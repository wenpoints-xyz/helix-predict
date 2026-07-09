# web

Arcade UI — **POC built and working** (zero-dependency, no build step, Win95 style
matching wenpoints.xyz; vanilla JS + canvas, mobile-first).

- `index.html` + `game.js` — that's the whole app. Serve statically:
  `python3 -m http.server 8791` and open `http://localhost:8791/`.
- Chart: price history on the left ⅔; the right ⅓ is the future zone split by the
  strike line into two tap-to-bet tiles (UP/DOWN) with live parimutuel multipliers.
  While a round is locked, the window pins to expiry so the price line advances into
  the tile zone until it crosses the finish line.
- **Real prices:** Pyth Hermes SSE stream (BTC/ETH/INJ — the same feeds
  `PredictionPool` settles on), synthetic random-walk fallback if the stream drops.
- **Simulated for now:** pools, co-bettors, points balance (localStorage). The seams
  for the contract are `placeBet()`, `settle()` and `botBets()` in `game.js` — swap
  those for chain calls + events, add wallet connect, keep everything else.
- Round cadence in the POC: 12s betting + 30s locked. Tie → refund; rake 3% —
  mirror the contract's params once deployed (read from `packages/shared`).
