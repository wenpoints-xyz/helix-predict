// Keeper for PredictionHouse.
//
// Per market it maintains one round through its lifecycle:
//
//   (none/Settled) --createRound--> [Open] --lock(Pyth)--> [Locked] --settle(Pyth)--> [Settled] -> ...
//                                      │                        │
//                             expiry+grace lapsed ─── voidExpired ──► refund (funds never lock)
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

async function handleMarket(m, now, grace) {
  if (!m.marketEnabled) return;
  const mid = m.marketId;
  const st = Number(m.state);
  const lockT = Number(m.lockTime);
  const expT = Number(m.expiryTime);
  const rid = m.roundId;

  // no round yet, or the latest one is done -> open the next
  if (!m.hasRound || st === State.Settled) {
    return send(`createRound m${mid}`, (nonce) =>
      house.createRound(mid, now + LEAD, { nonce, gasLimit: GAS_LIMIT })
    );
  }

  if (st === State.Open) {
    if (now >= expT + grace) return send(`voidExpired r${rid}`, (n) => house.voidExpired(rid, { nonce: n, gasLimit: GAS_LIMIT }));
    if (now >= lockT) return lockOrSettle("lock", rid, m.feedId);
    return; // still taking bets
  }

  if (st === State.Locked) {
    if (now >= expT + grace) return send(`voidExpired r${rid}`, (n) => house.voidExpired(rid, { nonce: n, gasLimit: GAS_LIMIT }));
    if (now >= expT) return lockOrSettle("settle", rid, m.feedId);
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
