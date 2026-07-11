// Sweeper for PredictionBook — BLOCK-DRIVEN, per-bet.
//
// No rounds. Each user opens their own position; the strike and close are pinned to FIXED PAST
// instants (strikeInstant = openTime+Δ, closeInstant = strikeInstant+dur). Once a bet matures
// (now >= closeInstant) anyone may settle it, and the settler earns a tip carved from the escrow.
// This keeper is that settler: it watches new blocks, asks the book which bets are matured, fetches
// the two historical Pyth updates from Hermes, and settles them in one settleMany() tx.
//
//   new block ──► sweep:
//     book.pendingSettlement(cursor,PAGE)  ──► [ {betId, feedId, strikeInstant, dur}, ... ]
//        for each matured bet: strikeData = hermes(strikeInstant) ; closeData = hermes(closeInstant)
//     settleMany(betIds[], strikeData[][], closeData[][])   (skip-not-revert; tip → this keeper)
//        └─ a bet whose Pyth history is unfetchable AND past settleGrace ──► voidExpired (refund)
//
// Because settlement reads FIXED PAST prices, there is no lock latency: the price is history by the
// time we settle, so the contract and the frontend read the identical value. Injective gives no tx
// receipt, so we never await tx.wait(); a per-bet cooldown dedupes sends across consecutive blocks.
//
// Liveness note: settling a loser earns a tip but costs gas + a Pyth fee; at low volume the tip may
// not cover cost, so THIS KEEPER IS SUBSIDISED — fund its key with INJ and run it always-on. Do not
// rely on purely permissionless third parties for liveness.
//
// Env: RPC_URL, WSS_URL, BOOK_ADDR, KEEPER_PRIVATE_KEY|KEEPER_MNEMONIC,
//      [HERMES_URL, PAGE, MAX_SETTLE, FALLBACK_MS, ACTION_COOLDOWN, GAS_LIMIT, FEE_BUFFER_BPS]
// Flags: --once (single sweep then exit)

import { ethers } from "ethers";
import WebSocket from "ws";

const RPC_URL = req("RPC_URL");
const WSS_URL = process.env.WSS_URL || "wss://k8s.testnet.ws.injective.network/";
const BOOK_ADDR = req("BOOK_ADDR");
const HERMES = (process.env.HERMES_URL || "https://hermes.pyth.network").replace(/\/$/, "");
const PAGE = num("PAGE", 500); // positions scanned per pendingSettlement call
const MAX_SETTLE = num("MAX_SETTLE", 20); // max bets per settleMany tx (bounds gas)
const FALLBACK_MS = num("FALLBACK_MS", 6000); // sweep this often even if the socket is quiet/down
const ACTION_COOLDOWN = num("ACTION_COOLDOWN", 6); // don't re-send a bet within this many seconds
const GAS_LIMIT = BigInt(process.env.GAS_LIMIT || "6000000");
const FEE_BUFFER_BPS = num("FEE_BUFFER_BPS", 500); // pad the update fee 5% (contract refunds leftover)
const ONCE = process.argv.includes("--once");

const BOOK_ABI = [
  "function pendingSettlement(uint256 start, uint256 max) view returns (tuple(uint256 betId, bytes32 feedId, uint64 strikeInstant, uint64 dur)[] list, uint256 nextCursor)",
  "function positionsLength() view returns (uint256)",
  "function settleGrace() view returns (uint64)",
  "function pyth() view returns (address)",
  "function settle(uint256 betId, bytes[] strikeData, bytes[] closeData) payable",
  "function settleMany(uint256[] betIds, bytes[][] strikeData, bytes[][] closeData) payable",
  "function voidExpired(uint256 betId)"
];
const PYTH_ABI = ["function getUpdateFee(bytes[] updateData) view returns (uint256)"];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = makeWallet();
const book = new ethers.Contract(BOOK_ADDR, BOOK_ABI, wallet);
let pyth;
let grace = 3600; // cached settleGrace, refreshed at startup

// ---- nonce (never await receipts on Injective; manage locally) ----
let localNonce = null;
async function nextNonce() {
  if (localNonce === null) localNonce = await provider.getTransactionCount(wallet.address, "pending");
  return localNonce++;
}
function resyncNonce() {
  localNonce = null;
}

// ---- per-bet cooldown: don't re-send a bet while its settle tx is still in flight ----
const sentAt = {};
function recentlySent(betId, now) {
  return sentAt[betId] && now - sentAt[betId] < ACTION_COOLDOWN;
}
function markSent(betId) {
  sentAt[betId] = Math.floor(Date.now() / 1000);
}

// Fetch the signed Pyth update whose publishTime is the first tick at/after T (Hermes historical).
// The book's Unique read pins min = the bet's instant, so this exact update satisfies it.
async function hermesAt(feedId, t) {
  const id = feedId.startsWith("0x") ? feedId.slice(2) : feedId;
  const url = `${HERMES}/v2/updates/price/${t}?ids[]=0x${id}&encoding=hex`;
  const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`hermes ${r.status} @${t}`);
  const j = await r.json();
  const data = j?.binary?.data;
  if (!Array.isArray(data) || !data.length) throw new Error(`hermes: no data @${t}`);
  return data.map((h) => (h.startsWith("0x") ? h : "0x" + h));
}

// Collect every matured, unsettled bet by paging the book's keeper view.
async function pendingAll(len) {
  const out = [];
  let cursor = 0;
  while (cursor < len) {
    const [list, next] = await book.pendingSettlement(cursor, PAGE);
    for (const p of list) {
      out.push({
        betId: p.betId,
        feedId: p.feedId,
        strikeInstant: Number(p.strikeInstant),
        dur: Number(p.dur)
      });
    }
    cursor = Number(next);
    if (next <= 0n && cursor === 0) break; // safety
  }
  return out;
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

let sweeping = false;
async function sweep(nowTs) {
  if (sweeping) return; // one sweep at a time (the read + Hermes fan-out)
  sweeping = true;
  try {
    const now = nowTs || Math.floor(Date.now() / 1000);
    const len = Number(await book.positionsLength());
    if (len === 0) return;
    const pending = await pendingAll(len);
    if (!pending.length) return;

    const batch = [];
    for (const b of pending) {
      if (batch.length >= MAX_SETTLE) break;
      if (recentlySent(b.betId, now)) continue; // let the last tx land
      batch.push(b);
    }
    if (!batch.length) return;

    // Fetch the two historical updates per bet (strike instant + close instant), in parallel.
    const built = [];
    for (const b of batch) {
      try {
        const [strikeData, closeData] = await Promise.all([
          hermesAt(b.feedId, b.strikeInstant),
          hermesAt(b.feedId, b.strikeInstant + b.dur)
        ]);
        built.push({ betId: b.betId, strikeData, closeData, bet: b });
      } catch (e) {
        // Hermes gap: if the bet is past grace it can never settle -> void it (refund) instead.
        if (now >= b.strikeInstant + b.dur + grace) {
          markSent(b.betId);
          await send(`voidExpired ${b.betId}`, (nonce) =>
            book.voidExpired(b.betId, { nonce, gasLimit: GAS_LIMIT })
          );
        } else {
          log(`skip ${b.betId}: ${short(e)} (retry next block)`);
        }
      }
    }
    if (!built.length) return;

    // Sum the exact update fees, pad a touch (the contract refunds any leftover).
    let fee = 0n;
    for (const x of built) {
      const [fs, fc] = await Promise.all([
        pyth.getUpdateFee(x.strikeData),
        pyth.getUpdateFee(x.closeData)
      ]);
      fee += fs + fc;
    }
    fee = fee + (fee * BigInt(FEE_BUFFER_BPS)) / 10000n;

    const betIds = built.map((x) => x.betId);
    const sData = built.map((x) => x.strikeData);
    const cData = built.map((x) => x.closeData);
    for (const id of betIds) markSent(id);

    if (betIds.length === 1) {
      await send(`settle ${betIds[0]}`, (nonce) =>
        book.settle(betIds[0], sData[0], cData[0], { value: fee, nonce, gasLimit: GAS_LIMIT })
      );
    } else {
      await send(`settleMany x${betIds.length}`, (nonce) =>
        book.settleMany(betIds, sData, cData, { value: fee, nonce, gasLimit: GAS_LIMIT })
      );
    }
  } catch (e) {
    resyncNonce();
    log(`sweep error: ${short(e)}`);
  } finally {
    sweeping = false;
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
  pyth = new ethers.Contract(await book.pyth(), PYTH_ABI, provider);
  grace = Number(await book.settleGrace());
  log(`sweeper up (block-driven): book=${BOOK_ADDR} signer=${wallet.address} ws=${WSS_URL} grace=${grace}s once=${ONCE}`);

  if (ONCE) {
    await sweep();
    return;
  }
  let lastBlock = 0;
  startBlockFeed((numBlk, ts) => {
    if (numBlk <= lastBlock) return; // ignore dupes/reorgs going backwards
    lastBlock = numBlk;
    sweep(ts);
  });
  setInterval(() => sweep(), FALLBACK_MS); // belt-and-suspenders if the socket is quiet/down
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
