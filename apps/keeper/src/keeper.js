// Keeper for PredictionHouse — BLOCK-DRIVEN.
//
// Subscribes to new blocks over WSS and fires the moment a round becomes eligible (first block whose
// timestamp >= lockTime / expiryTime), instead of waiting on a slow poll. Reads + tx sends go over
// HTTP (reliable); the socket is only a fast trigger. If the socket drops it reconnects, and a
// fallback interval keeps ticking so the keeper never stalls.
//
//   new block ──► tick ──► per market:
//     (none/Settled) --createRound--> [Open] --lock(Pyth)--> [Locked] --settle(Pyth)--> [Settled] -> ...
//                                        │  \                     │
//                                        │   \ no bets at lockTime -> roll to next slot, NO Pyth fee
//                               expiry+grace lapsed ─── voidExpired ──► refund (funds never lock)
//
// Idle cost: an empty round (nobody bet) never pays a Pyth fee — it's orphaned (0 stake, 0 reserve)
// and the market rolls forward. Only rounds with real bets get locked+settled on-chain. Injective
// gives no receipt, so we never await tx.wait(); a per-market cooldown dedupes sends across blocks.
//
// Env: RPC_URL, WSS_URL, HOUSE_ADDR, KEEPER_PRIVATE_KEY|KEEPER_MNEMONIC,
//      [HERMES_URL, LEAD_SEC, FALLBACK_MS, ACTION_COOLDOWN, GAS_LIMIT]
// Flags: --once (single tick then exit)

import { ethers } from "ethers";
import WebSocket from "ws";

const RPC_URL = req("RPC_URL");
const WSS_URL = process.env.WSS_URL || "wss://k8s.testnet.ws.injective.network/";
const HOUSE_ADDR = req("HOUSE_ADDR");
const HERMES = (process.env.HERMES_URL || "https://hermes.pyth.network").replace(/\/$/, "");
const LEAD = num("LEAD_SEC", 8); // seconds ahead to set a new round's lockTime
const FALLBACK_MS = num("FALLBACK_MS", 6000); // tick this often even if the socket is quiet/down
const ACTION_COOLDOWN = num("ACTION_COOLDOWN", 4); // don't re-act on a market within this many seconds
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
let grace = 3600; // cached settleGrace; refreshed at startup

// ---- nonce (never await receipts on Injective; manage locally) ----
let localNonce = null;
async function nextNonce() {
  if (localNonce === null) localNonce = await provider.getTransactionCount(wallet.address, "pending");
  return localNonce++;
}
function resyncNonce() {
  localNonce = null;
}

// ---- per-market cooldown: don't re-send while the last tx is still in flight ----
const actedAt = {};
function recentlyActed(mid, now) {
  return actedAt[mid] && now - actedAt[mid] < ACTION_COOLDOWN;
}
function markActed(mid) {
  actedAt[mid] = Math.floor(Date.now() / 1000);
}

async function pythUpdate(feedId) {
  const id = feedId.startsWith("0x") ? feedId.slice(2) : feedId;
  const url = `${HERMES}/v2/updates/price/latest?ids[]=0x${id}&encoding=hex`;
  const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); // never hang the loop on Hermes
  if (!r.ok) throw new Error(`hermes ${r.status}`);
  const j = await r.json();
  const data = j?.binary?.data;
  if (!Array.isArray(data) || !data.length) throw new Error("hermes: no update data");
  const publishTime = Number(j?.parsed?.[0]?.price?.publish_time || 0);
  return { data: data.map((h) => (h.startsWith("0x") ? h : "0x" + h)), publishTime };
}

async function send(label, fn) {
  const nonce = await nextNonce();
  try {
    const tx = await fn(nonce);
    log(`${label} sent nonce=${nonce} tx=${tx.hash}`);
  } catch (e) {
    resyncNonce();
    log(`${label} FAILED: ${short(e)}`);
  }
}

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

// One in-flight lock/settle attempt per market: the Hermes fetch is async, so without this two
// consecutive blocks could both fetch + fire, double-sending (the 2nd reverts NotOpen).
const inFlight = {};
async function lockOrSettle(kind, mid, rid, feedId, minPublishTime) {
  if (inFlight[mid]) return;
  inFlight[mid] = true;
  try {
    let upd;
    try {
      upd = await pythUpdate(feedId);
    } catch (e) {
      return log(`${kind} r${rid} skip: ${short(e)}`);
    }
    // Pyth/Hermes lags wall-clock by a couple seconds, and lock()/settle() REQUIRE the price's
    // publishTime >= the window (lockTime / expiryTime). Sending an older price just reverts
    // (PriceBeforeWindow) and burns gas + a cooldown, then retries. Instead, wait (retry next
    // block) until Hermes has caught up past the window, then send once — the real fix for latency.
    if (upd.publishTime < minPublishTime) return;
    markActed(mid); // only now (we're actually sending) so the waiting blocks keep retrying
    const fee = await pyth.getUpdateFee(upd.data);
    await send(`${kind} r${rid}`, (nonce) =>
      house[kind](rid, upd.data, { value: fee, nonce, gasLimit: GAS_LIMIT })
    );
  } finally {
    inFlight[mid] = false;
  }
}

async function handleMarket(m, now) {
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
  if (!m.hasRound || st === State.Settled) {
    markActed(mid);
    return createNext(m, now);
  }

  if (st === State.Open) {
    // EMPTY round: never spend a Pyth fee on it. Once betting closes, roll to the next slot
    // (the empty round is harmlessly orphaned: 0 stake, 0 reserve, off the board).
    if (!hasBets) {
      if (now >= lockT) {
        markActed(mid);
        return createNext(m, now);
      }
      return; // still open for bets
    }
    // real game (someone bet vs the house) -> lock on Pyth the first eligible block
    if (now >= expT + grace) {
      markActed(mid);
      return voidExp();
    }
    if (now >= lockT) return lockOrSettle("lock", mid, rid, m.feedId, lockT); // marks acted only on the actual send
    return; // still taking bets
  }

  if (st === State.Locked) {
    if (now >= expT + grace) {
      markActed(mid);
      return voidExp();
    }
    if (now >= expT) return lockOrSettle("settle", mid, rid, m.feedId, expT);
    return; // waiting for expiry
  }
}

let reading = false;
async function tick(blockTs) {
  if (reading) return; // guard ONLY the fast board read
  reading = true;
  const now = blockTs || Math.floor(Date.now() / 1000);
  let board;
  try {
    board = await house.boardSnapshot();
  } catch (e) {
    reading = false;
    return log(`read error: ${short(e)}`);
  }
  reading = false;
  // Fire per-market actions WITHOUT awaiting. handleMarket sets the per-market cooldown synchronously
  // before any await, so a slow Hermes/broadcast on one market can never stall the next block's tick
  // (that global-await stall is what pinned reactions to the fallback interval).
  for (const m of board) {
    handleMarket(m, now).catch((e) => {
      resyncNonce();
      log(`market ${m.marketId} error: ${short(e)}`);
    });
  }
}

// ---- WSS block feed (fast trigger); self-reconnecting ----
function startBlockFeed(onBlock) {
  let alive = true, backoff = 1000, ws;
  function connect() {
    ws = new WebSocket(WSS_URL, { handshakeTimeout: 8000 });
    ws.on("open", () => {
      backoff = 1000;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] }));
      log("ws connected");
    });
    ws.on("message", (d) => {
      let j;
      try {
        j = JSON.parse(d.toString());
      } catch {
        return;
      }
      const h = j?.method === "eth_subscription" ? j.params?.result : null;
      if (h && h.number) onBlock(parseInt(h.number, 16), h.timestamp ? parseInt(h.timestamp, 16) : 0);
    });
    ws.on("close", () => reconnect("close"));
    ws.on("error", (e) => reconnect("error " + short(e)));
  }
  function reconnect(why) {
    if (!alive) return;
    try {
      ws.terminate();
    } catch {}
    log(`ws reconnect (${why}) in ${backoff}ms`);
    setTimeout(() => alive && connect(), backoff);
    backoff = Math.min(backoff * 2, 15000);
  }
  connect();
  return () => {
    alive = false;
    try {
      ws.close();
    } catch {}
  };
}

async function main() {
  pyth = new ethers.Contract(await house.pyth(), PYTH_ABI, provider);
  grace = Number(await house.settleGrace());
  log(`keeper up (block-driven): house=${HOUSE_ADDR} signer=${wallet.address} ws=${WSS_URL} lead=${LEAD}s grace=${grace}s once=${ONCE}`);

  if (ONCE) {
    await tick();
    return;
  }
  let lastBlock = 0;
  startBlockFeed((num, ts) => {
    if (num <= lastBlock) return; // ignore dupes/reorgs going backwards
    lastBlock = num;
    tick(ts);
  });
  setInterval(() => tick(), FALLBACK_MS); // belt-and-suspenders if the socket is quiet/down
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

main().catch((e) => {
  log("fatal:", short(e));
  process.exit(1);
});
