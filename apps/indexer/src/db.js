// SQLite store (node:sqlite, zero-dep). One row per bet keyed by betId (idempotent upsert), plus a
// meta table holding the resume cursor. A bet row is built incrementally: BetOpened writes the
// stake/side/instants; BetSettled fills result/payout. A settle seen before its open (orphan, the
// open predates the index start) is stored with incomplete=1 and excluded from all aggregation.
import { DatabaseSync } from "node:sqlite";

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS bets (
      betId        TEXT PRIMARY KEY,
      bettor       TEXT,
      marketId     INTEGER,
      up           INTEGER,
      stake        TEXT,            -- wei
      strikeInstant INTEGER,
      dur          INTEGER,
      closeInstant INTEGER,
      payoutBps    INTEGER,
      settled      INTEGER DEFAULT 0,
      result       INTEGER DEFAULT 0,
      payout       TEXT DEFAULT '0',
      tip          TEXT DEFAULT '0',
      incomplete   INTEGER DEFAULT 0   -- settle seen but open never indexed (stake unknown)
    );
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  `);
  return db;
}

export function getCursor(db, deployBlock) {
  const row = db.prepare("SELECT v FROM meta WHERE k='cursor'").get();
  return row ? Number(row.v) : deployBlock;
}
export function setCursor(db, block) {
  db.prepare("INSERT INTO meta(k,v) VALUES('cursor',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(String(block));
}

// Upsert a BetOpened. Fills the open-side fields; if the row already exists (settle arrived first as
// an orphan) this clears incomplete since we now know the stake.
export function upsertOpened(db, o) {
  db.prepare(`
    INSERT INTO bets (betId,bettor,marketId,up,stake,strikeInstant,dur,closeInstant,payoutBps,incomplete)
    VALUES (@betId,@bettor,@marketId,@up,@stake,@strikeInstant,@dur,@closeInstant,@payoutBps,0)
    ON CONFLICT(betId) DO UPDATE SET
      bettor=excluded.bettor, marketId=excluded.marketId, up=excluded.up, stake=excluded.stake,
      strikeInstant=excluded.strikeInstant, dur=excluded.dur, closeInstant=excluded.closeInstant,
      payoutBps=excluded.payoutBps, incomplete=0
  `).run({ ...o, up: o.up ? 1 : 0 });
}

// Apply a BetSettled. If the open was never indexed, mark the row incomplete (stake unknown) so
// aggregation ignores it — never treat payout as pure profit.
export function applySettled(db, s) {
  const exists = db.prepare("SELECT stake FROM bets WHERE betId=?").get(s.betId);
  if (exists) {
    db.prepare("UPDATE bets SET settled=1, result=?, payout=?, tip=? WHERE betId=?")
      .run(s.result, s.payout, s.tip, s.betId);
  } else {
    db.prepare(`INSERT INTO bets (betId, settled, result, payout, tip, incomplete, closeInstant)
                VALUES (?,1,?,?,?,1,0)`)
      .run(s.betId, s.result, s.payout, s.tip);
  }
}

export function allRows(db) {
  return db.prepare("SELECT * FROM bets").all().map(function (r) {
    return {
      betId: r.betId, bettor: r.bettor, marketId: r.marketId, up: !!r.up, stake: r.stake,
      strikeInstant: r.strikeInstant, dur: r.dur, closeInstant: r.closeInstant, payoutBps: r.payoutBps,
      settled: !!r.settled, result: r.result, payout: r.payout, tip: r.tip, incomplete: !!r.incomplete
    };
  });
}
