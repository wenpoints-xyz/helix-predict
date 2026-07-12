import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, getCursor, setCursor, upsertOpened, applySettled, allRows } from "../src/db.js";

const E = (n) => (BigInt(Math.round(n * 1000)) * 10n ** 15n).toString();
const A1 = "0x" + "a1".padStart(40, "0");

function opened(betId, closeInstant, stakeE) {
  return { betId: String(betId), bettor: A1, marketId: 0, up: true, stake: E(stakeE), strikeInstant: closeInstant - 30, dur: 30, closeInstant, payoutBps: 19500 };
}

test("cursor seeds at deploy block, then persists", () => {
  const db = openDb(":memory:");
  assert.equal(getCursor(db, 42), 42);
  setCursor(db, 1000);
  assert.equal(getCursor(db, 42), 1000);
});

test("open then settle joins into one row; net computable", () => {
  const db = openDb(":memory:");
  upsertOpened(db, opened(1, 1000, 100));
  applySettled(db, { betId: "1", result: 1, payout: E(195), tip: E(1) });
  const rows = allRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].settled, true);
  assert.equal(rows[0].incomplete, false);
  assert.equal(rows[0].stake, E(100));
  assert.equal(rows[0].payout, E(195));
});

test("idempotent re-ingest: replaying the same open+settle yields one row, same values", () => {
  const db = openDb(":memory:");
  upsertOpened(db, opened(7, 2000, 50));
  upsertOpened(db, opened(7, 2000, 50)); // duplicate open (re-scan overlap)
  applySettled(db, { betId: "7", result: 2, payout: "0", tip: E(0.5) });
  applySettled(db, { betId: "7", result: 2, payout: "0", tip: E(0.5) }); // duplicate settle
  const rows = allRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].result, 2);
});

test("orphan settle (open predates index) is incomplete; a later open clears it", () => {
  const db = openDb(":memory:");
  applySettled(db, { betId: "9", result: 1, payout: E(195), tip: E(1) }); // settle first, no open
  let rows = allRows(db);
  assert.equal(rows[0].incomplete, true, "orphan marked incomplete");
  assert.equal(rows[0].settled, true);
  // if the open later shows up (shouldn't for a true orphan, but proves the join), incomplete clears
  upsertOpened(db, opened(9, 3000, 100));
  rows = allRows(db);
  assert.equal(rows[0].incomplete, false);
  assert.equal(rows[0].stake, E(100));
});

test("out-of-order settle-before-open in the SAME batch resolves correctly", () => {
  const db = openDb(":memory:");
  applySettled(db, { betId: "5", result: 1, payout: E(97.5), tip: E(0.5) });
  upsertOpened(db, opened(5, 4000, 50));
  const rows = allRows(db);
  assert.equal(rows[0].incomplete, false);
  assert.equal(rows[0].settled, true);
  assert.equal(rows[0].stake, E(50));
  assert.equal(rows[0].payout, E(97.5));
});
