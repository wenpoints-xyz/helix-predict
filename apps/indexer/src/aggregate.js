// Pure leaderboard aggregation: a set of per-bet rows -> the leaderboard JSON the frontend renders.
// No IO. Fully unit-tested. All wei kept as decimal strings in the output (BigInt-safe in JS clients).
//
// A "bet row" (as stored / passed in) has at least:
//   { betId, bettor, marketId, stake, closeInstant, settled, result, payout, incomplete }
// - settled: has a BetSettled been seen? (open bets count toward volume only, never P&L)
// - incomplete: a BetSettled seen for a bet whose BetOpened predates the index start (orphan) — we
//   have payout but not stake, so P&L is unknowable; count nothing for it (never treat payout as pure profit).

import { RESULT, netWei } from "./decode.js";

export const WINDOWS = { day: 86400, week: 604800, month: 2592000, all: 0 }; // all = since deploy

// One player's aggregate over a window.
function emptyAgg(addr) {
  return { addr, net: 0n, vol: 0n, bets: 0, wins: 0, losses: 0, voids: 0, biggestWin: 0n };
}

// Build the board for a single window. `rows` = all bet rows; `now` = unix seconds; `windowSecs` = 0 for all-time.
export function buildWindow(rows, now, windowSecs) {
  const lo = windowSecs > 0 ? now - windowSecs : 0;
  const byUser = new Map();
  let totalVol = 0n, totalBets = 0, totalNet = 0n, biggestWin = 0n, biggestWinner = null;
  const assetVol = new Map(); // marketId -> volume, for "most-played"

  for (const r of rows) {
    // Volume counts a bet in the window by its resolve instant (closeInstant); open bets included.
    if (r.closeInstant < lo || r.closeInstant > now) continue;
    if (r.incomplete) continue; // orphan settle (stake unknown) — cannot attribute
    let a = byUser.get(r.bettor);
    if (!a) { a = emptyAgg(r.bettor); byUser.set(r.bettor, a); }
    const stake = BigInt(r.stake);
    a.vol += stake; a.bets += 1;
    totalVol += stake; totalBets += 1;
    assetVol.set(r.marketId, (assetVol.get(r.marketId) || 0n) + stake);

    if (r.settled) {
      const net = netWei(r.stake, r.payout);
      a.net += net; totalNet += net;
      if (r.result === RESULT.WIN) { a.wins += 1; if (net > a.biggestWin) a.biggestWin = net; if (net > biggestWin) { biggestWin = net; biggestWinner = r.bettor; } }
      else if (r.result === RESULT.LOSS) a.losses += 1;
      else if (r.result === RESULT.VOID) a.voids += 1;
    }
  }

  const players = [...byUser.values()].map(function (a) {
    const decided = a.wins + a.losses;
    return {
      addr: a.addr,
      net: a.net.toString(),
      vol: a.vol.toString(),
      bets: a.bets,
      wins: a.wins, losses: a.losses, voids: a.voids,
      winRate: decided > 0 ? Math.round((a.wins / decided) * 1000) / 10 : null, // %, 1dp, null if no decided bets
      biggestWin: a.biggestWin.toString()
    };
  });
  // Default sort: net descending (the LUCKIEST board). Frontend re-sorts client-side.
  players.sort(function (x, y) { const d = BigInt(y.net) - BigInt(x.net); return d > 0n ? 1 : d < 0n ? -1 : 0; });

  let topAsset = null, topAssetVol = -1n;
  for (const [m, v] of assetVol) if (v > topAssetVol) { topAssetVol = v; topAsset = m; }

  return {
    global: {
      volume: totalVol.toString(),
      bets: totalBets,
      players: players.length,
      housePnl: (-totalNet).toString(), // LP take = -(sum of player net)
      biggestWin: biggestWin.toString(),
      biggestWinner,
      topAsset
    },
    players
  };
}

// Current consecutive-win streak per user (ALL-TIME, ending at their latest settled bet) — the 🔥 badge.
// Returns a Map addr -> streak count.
export function streaks(rows) {
  const byUser = new Map();
  for (const r of rows) {
    if (!r.settled || r.incomplete) continue;
    let arr = byUser.get(r.bettor);
    if (!arr) { arr = []; byUser.set(r.bettor, arr); }
    arr.push(r);
  }
  const out = new Map();
  for (const [addr, arr] of byUser) {
    arr.sort((a, b) => a.closeInstant - b.closeInstant); // oldest -> newest
    let s = 0;
    for (let i = arr.length - 1; i >= 0; i--) { if (arr[i].result === RESULT.WIN) s++; else break; }
    out.set(addr, s);
  }
  return out;
}

// Assemble the full leaderboard payload (all windows) + fold streaks into each player row.
export function buildLeaderboard(rows, now, meta) {
  const strk = streaks(rows);
  const windows = {};
  for (const [name, secs] of Object.entries(WINDOWS)) {
    const w = buildWindow(rows, now, secs);
    for (const p of w.players) p.streak = strk.get(p.addr) || 0;
    windows[name] = w;
  }
  return { generatedAt: now, book: (meta && meta.book) || null, fromBlock: (meta && meta.fromBlock) || null, windows };
}
