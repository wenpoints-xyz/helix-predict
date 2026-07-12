# helix-predict indexer — global leaderboard (Phase 2)

Indexes PredictionBook `BetOpened`/`BetSettled` logs into SQLite and publishes a precomputed
`leaderboard.json` (per-window player aggregates) that the frontend 🏆 modal renders. Zero npm
deps (Node 24 `node:sqlite` + global `fetch`). Design + eng reviewed:
`~/.gstack/projects/wenpoints-xyz-helix-predict/root-main-design-20260711-leaderboard.md`.

## Why an indexer (not client-side)
Injective RPC caps `eth_getLogs` at a 10,000-block range, so windowing the whole history in-browser
would be 76-324 calls per visitor. Instead one service pages the logs once, stores per-bet rows,
recomputes the board, and publishes static JSON behind a CDN.

## Pipeline
```
book logs (BetOpened/BetSettled) --getLogs paged 9k--> SQLite (1 row/betId, idempotent)
   --aggregate per window (day/week/month/all)--> leaderboard.json --wrangler--> CF Pages (CORS)
                                                        frontend fetches helix-leaderboard.pages.dev
```
- **Window by `closeInstant` = strikeInstant+dur** (in the position; when the bet resolved) — free, no
  block-timestamp lookups, immune to keeper/void settle lag.
- **P&L = payout − stake** uniformly (win/loss/void). Open bets count volume only.
- **Cold-start gate**: publishes only once the cursor catches the (lagged) head — no partial board.
- **Orphan settles** (open predates the deploy-block seed) are marked incomplete and excluded — never
  counts a payout as pure profit.
- **Cursor lags head by LAG_BLOCKS** (load-balanced RPC eventual consistency; Injective finality is instant).

## Run
```bash
cp .env.example .env.mainnet   # fill CLOUDFLARE_API_TOKEN; chmod 600
npm test                       # node:test unit tests (decode, aggregate, windows, db, orphan, resume)
npm run once                   # single index+publish pass
npm start                      # loop every POLL_MS
```

## Deploy on the VM (own hardened unit, isolated from the keeper)
```bash
cp helix-indexer.service /etc/systemd/system/
systemctl enable --now helix-indexer
```
Runs as `helixkeeper` with `MemoryMax=256M`, `ProtectSystem=strict`. Its RPC budget is separate from
the keeper so a backfill burst can't throttle settlement.

## Data
- Mainnet book `0x98121Af94Ece69bFEC46544ff0Fc202F30010956`, deploy block `173753444` (cursor seed).
- Published to https://helix-leaderboard.pages.dev/leaderboard.json (CORS `*`, short TTL; frontend
  cache-busts with `?t=<epoch>`).
