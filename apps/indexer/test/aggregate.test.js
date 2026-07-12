import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeOpened, decodeSettled, netWei, TOPIC_OPENED, TOPIC_SETTLED, RESULT } from "../src/decode.js";
import { buildWindow, buildLeaderboard, streaks } from "../src/aggregate.js";

const E = (n) => (BigInt(Math.round(n * 1000)) * 10n ** 15n).toString(); // n HELIXPOINT (millis-precise) -> wei string
const A = (h) => "0x" + h.padStart(40, "0");
const t32 = (v) => "0x" + BigInt(v).toString(16).padStart(64, "0");

// build a BetOpened log
function openedLog(betId, bettor, marketId, up, stakeE, strikeInstant, dur, payoutBps) {
  const w = (v) => BigInt(v).toString(16).padStart(64, "0");
  const data = "0x" + w(up ? 1 : 0) + w(BigInt(stakeE) * 10n ** 18n) + w(strikeInstant) + w(dur) + w(payoutBps) + w(0);
  return { topics: [TOPIC_OPENED, t32(betId), "0x" + bettor.slice(2).padStart(64, "0"), t32(marketId)], data };
}
function settledLog(betId, result, payoutWei, tip) {
  const w = (v) => BigInt(v).toString(16).padStart(64, "0");
  const data = "0x" + w(0) + w(0) + w(result) + w(payoutWei) + w(tip || 0);
  return { topics: [TOPIC_SETTLED, t32(betId), t32(0)], data };
}

test("decodeOpened extracts fields + closeInstant", () => {
  const o = decodeOpened(openedLog(7, A("a1"), 1, true, 100, 1000, 30, 19500));
  assert.equal(o.betId, "7");
  assert.equal(o.bettor, ("0x" + "a1".padStart(40, "0")));
  assert.equal(o.marketId, 1);
  assert.equal(o.up, true);
  assert.equal(o.stake, E(100));
  assert.equal(o.strikeInstant, 1000);
  assert.equal(o.dur, 30);
  assert.equal(o.closeInstant, 1030);
  assert.equal(o.payoutBps, 19500);
});

test("decodeSettled + wrong topic returns null", () => {
  const s = decodeSettled(settledLog(7, RESULT.WIN, E(195), E(1)));
  assert.equal(s.betId, "7");
  assert.equal(s.result, RESULT.WIN);
  assert.equal(s.payout, E(195));
  assert.equal(decodeOpened(settledLog(7, 1, 0, 0)), null); // topic mismatch
  assert.equal(decodeSettled(openedLog(7, A("a1"), 0, true, 1, 1, 5, 19500)), null);
});

test("netWei is uniform payout-stake for win/loss/void", () => {
  assert.equal(netWei(E(100), E(195)), 95n * 10n ** 18n);   // win 1.95x, tip in payout already
  assert.equal(netWei(E(100), "0"), -(100n * 10n ** 18n));  // loss
  assert.equal(netWei(E(100), E(99)), -(1n * 10n ** 18n));  // void refund stake-tip
});

const A1 = "0x" + "a1".padStart(40, "0");
const A2 = "0x" + "b2".padStart(40, "0");

function row(betId, bettor, stakeE, closeInstant, settled, result, payoutE, opts) {
  return Object.assign({
    betId: String(betId), bettor, marketId: 0, stake: E(stakeE), closeInstant,
    settled, result: result || 0, payout: payoutE != null ? E(payoutE) : "0"
  }, opts || {});
}

test("buildWindow: volume, netPnl, winRate, house P&L", () => {
  const now = 10000;
  const rows = [
    row(1, A1, 100, 9000, true, RESULT.WIN, 195),  // net +95
    row(2, A1, 100, 9500, true, RESULT.LOSS, 0),    // net -100
    row(3, A2, 50, 9800, true, RESULT.WIN, 97.5),  // net +47.5
    row(4, A2, 10, 9900, false, 0, 0)               // open: volume only
  ];
  const w = buildWindow(rows, now, 0); // all-time
  assert.equal(w.global.bets, 4);
  assert.equal(w.global.volume, E(260));
  // house P&L = -(sum player net) = -((95-100)+(47.5)) = -(42.5) = -42.5
  assert.equal(w.global.housePnl, (-(BigInt(E(425)) / 10n)).toString());
  const a1 = w.players.find((p) => p.addr === A1);
  assert.equal(a1.net, (-(5n * 10n ** 18n)).toString()); // +95-100
  assert.equal(a1.vol, E(200));
  assert.equal(a1.winRate, 50); // 1 win / 2 decided
  const a2 = w.players.find((p) => p.addr === A2);
  assert.equal(a2.winRate, 100); // 1 win, 0 loss (open bet not counted)
});

test("buildWindow: rolling window excludes bets outside [now-window, now] by closeInstant", () => {
  const now = 100000;
  const rows = [
    row(1, A1, 100, now - 86400, true, RESULT.WIN, 195),     // exactly 24h ago -> inclusive
    row(2, A1, 100, now - 86401, true, RESULT.WIN, 195),     // just older -> excluded from day
    row(3, A1, 100, now, true, RESULT.LOSS, 0)               // now -> included
  ];
  const day = buildWindow(rows, now, 86400);
  assert.equal(day.global.bets, 2); // bet 2 excluded
  const all = buildWindow(rows, now, 0);
  assert.equal(all.global.bets, 3);
});

test("orphan incomplete settle is fully excluded (never counts payout as profit)", () => {
  const now = 10000;
  const rows = [
    row(1, A1, 100, 9000, true, RESULT.WIN, 195, { incomplete: true }) // stake unknown at index start
  ];
  const w = buildWindow(rows, now, 0);
  assert.equal(w.global.bets, 0);
  assert.equal(w.players.length, 0);
});

test("streaks: current consecutive wins ending at latest settled bet", () => {
  const rows = [
    row(1, A1, 10, 100, true, RESULT.LOSS, 0),
    row(2, A1, 10, 200, true, RESULT.WIN, 19.5),
    row(3, A1, 10, 300, true, RESULT.WIN, 19.5), // latest two are wins -> streak 2
    row(4, A2, 10, 150, true, RESULT.WIN, 19.5),
    row(5, A2, 10, 250, true, RESULT.LOSS, 0)    // latest is a loss -> streak 0
  ];
  const s = streaks(rows);
  assert.equal(s.get(A1), 2);
  assert.equal(s.get(A2), 0);
});

test("buildLeaderboard: all windows present, streak folded into player rows, sorted by net desc", () => {
  const now = 10000;
  const rows = [
    row(1, A1, 100, 9000, true, RESULT.WIN, 195),
    row(2, A2, 100, 9500, true, RESULT.LOSS, 0)
  ];
  const lb = buildLeaderboard(rows, now, { book: "0xBOOK", fromBlock: 42 });
  assert.deepEqual(Object.keys(lb.windows), ["day", "week", "month", "all"]);
  assert.equal(lb.book, "0xBOOK");
  assert.equal(lb.fromBlock, 42);
  const top = lb.windows.all.players[0];
  assert.equal(top.addr, A1); // positive net sorts first
  assert.equal(typeof top.streak, "number");
});
