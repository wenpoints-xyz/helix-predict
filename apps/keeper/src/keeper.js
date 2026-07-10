// Keeper for PredictionHouse.
//
// Per market it maintains one round through its lifecycle:
//
//   (none/Settled) --createRound--> [Open] --lock(Pyth)--> [Locked] --settle(Pyth)--> [Settled] -> ...
//                                      │  \                     │
//                                      │   \ no bets at lockTime -> roll to next slot, NO Pyth fee
//                             expiry+grace lapsed ─── voidExpired ──► refund (funds never lock)
//
// Idle cost: an empty round (nobody bet the house) never pays a Pyth fee — it's orphaned (0 stake,
// 0 reserve) and the market rolls forward. Only rounds with real bets get locked+settled on-chain.
//
// It reads the whole board in one call (boardSnapshot), pulls signed price updates from Hermes for
// lock/settle, and pays the Pyth fee (excess is refunded on-chain). Injective returns null receipts,
// so it never waits on tx.wait(); it manages the nonce locally and verifies effects via the next read.
//
// Env: RPC_URL, HOUSE_ADDR, KEEPER_PRIVATE_KEY or KEEPER_MNEMONIC, [HERMES_URL, LEAD_SEC, POLL_MS, GAS_LIMIT]
// Flags: --once (single tick then exit)

import { ethers } from "ethers";

const RPC_URL = req("RPC_URL");
const HOUSE_ADDR = req("HOUSE_ADDR");
const HERMES = (process.env.HERMES_URL || "https://hermes.pyth.network").replace(/\/$/, "");
const LEAD = num("LEAD_SEC", 12); // seconds ahead to set a new round's lockTime
const POLL_MS = num("POLL_MS", 4000);
const GAS_LIMIT = BigInt(process.env.GAS_LIMIT || "2500000");
const ONCE = process.argv.includes("--once");

const HOUSE_ABI = [
  "function boardSnapshot() view returns (tuple(uint256 marketId, bytes32 feedId, uint32 timeframe, bool marketEnabled, bool hasRound, uint256 roundId, uint64 lockTime, uint64 expiryTime, int64 strike, int64 close, uint128 upPool, uint128 downPool, uint32 payoutBps, uint8 state, bool upWon, bool voided)[])",
  "function settleGrace() view returns (uint64)",
  "function pyth() view returns (address)",
  "function createRound(uint256 marketId, uint64 lockTime) returns (uint256)",
  "function lock(uint256 roundId, bytes[] updateData) payable",
  "function settle(uint256 roundId, bytes[] updateData) payable",
  "function voidExpired(uint256 roundId)"
];
const PYTH_ABI = ["function getUpdateFee(bytes[] updateData) view returns (uint256)"];

const State = { Open: 0, Locked: 1, Settled: 2 };

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = makeWallet();
const house = new ethers.Contract(HOUSE_ADDR, HOUSE_ABI, wallet);
let pyth;

let localNonce = null;
async function nextNonce() {
  if (localNonce === null) localNonce = await provider.getTransactionCount(wallet.address, "pending");
  return localNonce++;
}
function resyncNonce() {
  localNonce = null;
}

async function pythUpdate(feedId) {
  const id = feedId.startsWith("0x") ? feedId.slice(2) : feedId;
  const url = `${HERMES}/v2/updates/price/latest?ids[]=0x${id}&encoding=hex`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`hermes ${r.status}`);
  const j = await r.json();
  const data = j?.binary?.data;
  if (!Array.isArray(data) || !data.length) throw new Error("hermes: no update data");
  return data.map((h) => (h.startsWith("0x") ? h : "0x" + h));
}

async function send(label, fn) {
  const nonce = await nextNonce();
  try {
    const tx = await fn(nonce);
    log(`${label} sent nonce=${nonce} tx=${tx.hash}`);
  } catch (e) {
    resyncNonce(); // nonce/estimate errors: resync next tick
    log(`${label} FAILED: ${short(e)}`);
  }
}

// Don't act on the same market twice before the last tx has a chance to mine (Injective gives no
// receipt, so we can't await it). Cooldown is < LEAD, so it never blocks a legit next-phase action.
const actedAt = {};
const ACTION_COOLDOWN = num("ACTION_COOLDOWN", 9);
function recentlyActed(mid, now) { return actedAt[mid] && now - actedAt[mid] < ACTION_COOLDOWN; }
function markActed(mid) { actedAt[mid] = Math.floor(Date.now() / 1000); }

// Open the next round. Cadence: while the chain is live open exactly the next slot (= this round's
// expiry); after a settled/lapsed round restart genesis-style a short lead ahead.
function createNext(m, now) {
  const mid = Number(m.marketId);
  const expT = Number(m.expiryTime);
  const target = m.hasRound && expT > now ? expT : now + LEAD;
  return send(`createRound m${mid} @${target}`, (nonce) =>
    house.createRound(mid, target, { nonce, gasLimit: GAS_LIMIT })
  );
}

async function handleMarket(m, now, grace) {
  if (!m.marketEnabled) return;
  const mid = Number(m.marketId);
  if (recentlyActed(mid, now)) return; // let the last tx land first
  const st = Number(m.state);
  const lockT = Number(m.lockTime);
  const expT = Number(m.expiryTime);
  const rid = m.roundId;
  const hasBets = m.upPool > 0n || m.downPool > 0n;
  const voidExp = () => send(`voidExpired r${rid}`, (n) => house.voidExpired(rid, { nonce: n, gasLimit: GAS_LIMIT }));

  // no round yet, or the last real game settled -> open a fresh one
  if (!m.hasRound || st === State.Settled) { markActed(mid); return createNext(m, now); }

  if (st === State.Open) {
    // EMPTY round: nobody bet the house, so NEVER spend a Pyth fee locking/settling it. Once
    // betting has closed, roll the market to the next slot — the empty round is harmlessly
    // orphaned (0 stake, 0 reserve, invisible to the board). This is the idle-cost optimization.
    if (!hasBets) {
      if (now >= lockT) { markActed(mid); return createNext(m, now); }
      return; // still open for bets
    }
    // real game (someone bet vs the house) -> lock on Pyth
    if (now >= expT + grace) { markActed(mid); return voidExp(); }
    if (now >= lockT) { markActed(mid); return lockOrSettle("lock", rid, m.feedId); }
    return; // still taking bets
  }

  if (st === State.Locked) {
    if (now >= expT + grace) { markActed(mid); return voidExp(); }
    if (now >= expT) { markActed(mid); return lockOrSettle("settle", rid, m.feedId); }
    return; // waiting for expiry
  }
}

async function lockOrSettle(kind, rid, feedId) {
  let updateData;
  try {
    updateData = await pythUpdate(feedId);
  } catch (e) {
    return log(`${kind} r${rid} skip: ${short(e)}`);
  }
  const fee = await pyth.getUpdateFee(updateData);
  await send(`${kind} r${rid}`, (nonce) =>
    house[kind](rid, updateData, { value: fee, nonce, gasLimit: GAS_LIMIT })
  );
}

async function tick() {
  const now = Math.floor(Date.now() / 1000);
  const [board, grace] = await Promise.all([house.boardSnapshot(), house.settleGrace()]);
  const g = Number(grace);
  for (const m of board) {
    try {
      await handleMarket(m, now, g);
    } catch (e) {
      resyncNonce();
      log(`market ${m.marketId} error: ${short(e)}`);
    }
  }
}

async function main() {
  pyth = new ethers.Contract(await house.pyth(), PYTH_ABI, provider);
  log(`keeper up: house=${HOUSE_ADDR} signer=${wallet.address} hermes=${HERMES} lead=${LEAD}s poll=${POLL_MS}ms once=${ONCE}`);
  if (ONCE) {
    await tick();
    return;
  }
  let running = false;
  for (;;) {
    if (!running) {
      running = true;
      tick()
        .catch((e) => log(`tick error: ${short(e)}`))
        .finally(() => (running = false));
    }
    await sleep(POLL_MS);
  }
}

// ---- helpers ----
function makeWallet() {
  if (process.env.KEEPER_PRIVATE_KEY) return new ethers.Wallet(process.env.KEEPER_PRIVATE_KEY, provider);
  if (process.env.KEEPER_MNEMONIC) {
    return ethers.HDNodeWallet.fromPhrase(process.env.KEEPER_MNEMONIC.trim()).connect(provider);
  }
  throw new Error("set KEEPER_PRIVATE_KEY or KEEPER_MNEMONIC");
}
function req(k) {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}
function num(k, d) {
  return process.env[k] ? Number(process.env[k]) : d;
}
function short(e) {
  return (e && (e.shortMessage || e.info?.error?.message || e.message)) || String(e);
}
function log(...a) {
  console.log(new Date().toISOString(), ...a);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  log("fatal:", short(e));
  process.exit(1);
});
