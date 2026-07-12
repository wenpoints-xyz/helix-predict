// Pure log decoders for PredictionBook events. Hand-decoded (32-byte words) so the indexer stays
// zero-dependency, exactly like the frontend chain.js. No ethers.
//
// BetOpened(uint256 indexed betId, address indexed bettor, uint256 indexed marketId,
//           bool up, uint256 stake, uint64 strikeInstant, uint64 dur, uint32 payoutBps, uint256 reserve)
//   topics: [sig, betId, bettor, marketId]  data: up, stake, strikeInstant, dur, payoutBps, reserve
// BetSettled(uint256 indexed betId, address indexed settler, int64 strike, int64 close,
//            Result result, uint256 payout, uint256 tip)
//   topics: [sig, betId, settler]           data: strike, close, result, payout, tip

export const TOPIC_OPENED = "0x8b3da10fee11b56f42bdca23d6f988e4ec0a300ad8c5bd402ca2250e3b875645";
export const TOPIC_SETTLED = "0xb584bddf30fccfce488a8be0371b153f98922da25a6398d2912c45a1f22a3427";

function strip(h) { return h && h.startsWith("0x") ? h.slice(2) : (h || ""); }
function words(hex) { hex = strip(hex); const o = []; for (let i = 0; i < hex.length; i += 64) o.push(hex.slice(i, i + 64)); return o; }
function u(w) { return BigInt("0x" + w); }
function addrOf(topic) { return "0x" + strip(topic).slice(24); } // low 20 bytes of a 32-byte word

// A settled Result enum value: 1 Win, 2 Loss, 3 Void (0 Open never emitted on settle).
export const RESULT = { OPEN: 0, WIN: 1, LOSS: 2, VOID: 3 };

// Decode a BetOpened log -> partial bet row. Returns null if the topic doesn't match.
export function decodeOpened(log) {
  if (!log || (log.topics && log.topics[0] || "").toLowerCase() !== TOPIC_OPENED) return null;
  const t = log.topics, d = words(log.data);
  const strikeInstant = Number(u(d[2]));
  const dur = Number(u(d[3]));
  return {
    betId: BigInt(t[1]).toString(),        // topics carry 0x; use BigInt directly
    bettor: addrOf(t[2]).toLowerCase(),
    marketId: Number(BigInt(t[3])),
    up: u(d[0]) !== 0n,
    stake: u(d[1]).toString(),          // wei
    strikeInstant,
    dur,
    closeInstant: strikeInstant + dur,  // the window bucket key (when the bet resolves)
    payoutBps: Number(u(d[4]))
  };
}

// Decode a BetSettled log -> partial bet row. Returns null if the topic doesn't match.
export function decodeSettled(log) {
  if (!log || (log.topics && log.topics[0] || "").toLowerCase() !== TOPIC_SETTLED) return null;
  const t = log.topics, d = words(log.data);
  return {
    betId: BigInt(t[1]).toString(),     // topics carry 0x; use BigInt directly
    result: Number(u(d[2])),            // 1 win, 2 loss, 3 void
    payout: u(d[3]).toString(),         // wei owed to the bettor (0 on a loss)
    tip: u(d[4]).toString()
  };
}

// Per-bet realized P&L in wei, uniform across outcomes: net = payout - stake.
//   win:  payout = m*stake - tip   -> net = (m-1)*stake - tip  (> 0)
//   loss: payout = 0               -> net = -stake
//   void: payout = stake - tip     -> net = -tip
export function netWei(stakeWei, payoutWei) {
  return BigInt(payoutWei) - BigInt(stakeWei);
}
