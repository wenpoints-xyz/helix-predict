// helix-predict leaderboard indexer (Phase 2, global cross-user board).
//
// Loop: resume from the SQLite cursor -> page BetOpened/BetSettled logs up to (head - LAG) -> upsert
// per-bet rows -> once the cursor has caught the (lagged) head, aggregate the leaderboard JSON and
// publish it. Injective has instant finality (no reorgs), but the RPC is load-balanced, so we lag
// the head a few blocks to dodge the eventual-consistency gap. Runs as its OWN systemd unit with its
// OWN RPC budget, isolated from the liveness-critical keeper.
//
// Env: RPC_URL, BOOK_ADDR, DEPLOY_BLOCK, [DB_PATH, LAG_BLOCKS, POLL_MS, OUT_DIR, PUBLISH_CMD]
//   PUBLISH_CMD: shell run after writing OUT_DIR/leaderboard.json (e.g. wrangler pages deploy). If
//   unset, the JSON is only written locally (useful for --once / dry runs).
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { openDb, getCursor, setCursor, upsertOpened, applySettled, allRows } from "./db.js";
import { makeRpc, blockNumber, getLogsPaged } from "./rpc.js";
import { decodeOpened, decodeSettled, TOPIC_OPENED, TOPIC_SETTLED } from "./decode.js";
import { buildLeaderboard } from "./aggregate.js";

const env = process.env;
const RPC_URL = req("RPC_URL");
const BOOK = req("BOOK_ADDR").toLowerCase();
const DEPLOY_BLOCK = Number(req("DEPLOY_BLOCK"));
const DB_PATH = env.DB_PATH || "./data/leaderboard.db";
const LAG = num("LAG_BLOCKS", 6);
const POLL_MS = num("POLL_MS", 60000);
const OUT_DIR = env.OUT_DIR || "./public";
const PUBLISH_CMD = env.PUBLISH_CMD || "";
const ONCE = process.argv.includes("--once");

mkdirSync(dir(DB_PATH), { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });
const db = openDb(DB_PATH);
const rpc = makeRpc(RPC_URL);

async function tick() {
  const head = await blockNumber(rpc);
  const target = head - LAG;
  let cursor = getCursor(db, DEPLOY_BLOCK);
  if (target < cursor) { log(`head ${head} (target ${target}) < cursor ${cursor} — nothing new`); return maybePublish(cursor, target); }

  const logs = await getLogsPaged(rpc, BOOK, cursor, target, [TOPIC_OPENED, TOPIC_SETTLED]);
  let opened = 0, settled = 0;
  for (const l of logs) {
    const o = decodeOpened(l);
    if (o) { upsertOpened(db, o); opened++; continue; }
    const s = decodeSettled(l);
    if (s) { applySettled(db, s); settled++; }
  }
  setCursor(db, target);
  log(`indexed [${cursor}..${target}] head=${head}: +${opened} opened, +${settled} settled`);
  return maybePublish(target, target);
}

// Cold-start gate: only publish once the cursor has caught the lagged head (no partial board
// mid-backfill). The rolling time-windows mean the board can change even with no new bets, so we key
// the "did it change" check on the aggregated body (minus generatedAt), and only re-run the (heavy,
// CDN-deploying) PUBLISH_CMD when that body actually differs from what we last pushed.
let _lastHash = null;
function maybePublish(cursor, target) {
  if (cursor < target) { log(`backfilling (cursor ${cursor} < target ${target}) — hold publish`); return; }
  const rows = allRows(db);
  const now = Math.floor(Date.now() / 1000);
  const lb = buildLeaderboard(rows, now, { book: BOOK, fromBlock: DEPLOY_BLOCK });
  const body = JSON.stringify(lb.windows); // ignore generatedAt when deciding if anything changed
  const hash = createHash("sha256").update(body).digest("hex");
  const file = join(OUT_DIR, "leaderboard.json");
  writeFileSync(file, JSON.stringify(lb));
  if (hash === _lastHash) { return; } // unchanged board — skip the redeploy
  _lastHash = hash;
  log(`publish ${file}: ${rows.length} bets, ${lb.windows.all.players.length} players`);
  if (PUBLISH_CMD) {
    const r = spawnSync(PUBLISH_CMD, { shell: true, stdio: "inherit" });
    if (r.status !== 0) { log(`PUBLISH_CMD exited ${r.status}`); _lastHash = null; } // retry next tick
  }
}

async function main() {
  log(`indexer up: book=${BOOK} deploy=${DEPLOY_BLOCK} db=${DB_PATH} lag=${LAG} poll=${POLL_MS}ms once=${ONCE}`);
  if (ONCE) { await tick(); return; }
  for (;;) {
    try { await tick(); } catch (e) { log("tick error: " + (e && e.message || e)); }
    await sleep(POLL_MS);
  }
}

function req(k) { const v = env[k]; if (!v) throw new Error("missing env " + k); return v; }
function num(k, d) { return env[k] ? Number(env[k]) : d; }
function dir(p) { const i = p.lastIndexOf("/"); return i > 0 ? p.slice(0, i) : "."; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function log(...a) { console.log(new Date().toISOString(), ...a); }

main().catch((e) => { log("fatal: " + (e && e.message || e)); process.exit(1); });
