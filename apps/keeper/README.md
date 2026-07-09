# helix-predict keeper

Drives `PredictionHouse` rounds. Per market it keeps one round cycling:

```
(none | Settled) --createRound--> [Open] --lock(Pyth)--> [Locked] --settle(Pyth)--> [Settled] -> repeat
                                     |                        |
                            expiry+grace lapsed --- voidExpired --> refund (funds never lock)
```

- Reads the whole board in one `boardSnapshot()` call.
- For lock/settle, pulls a fresh signed price update from Hermes and pays the Pyth fee
  (on-chain refunds the excess).
- Injective returns null receipts, so the keeper never blocks on `tx.wait()`; it manages the
  nonce locally and confirms effects on the next read.

## Run

```bash
npm install
cp .env.example .env   # fill HOUSE_ADDR + a signer key; chmod 600 .env
npm run once           # single tick (validate)
npm start              # loop every POLL_MS
```

## Deploy on the VM (poll-agent model)

The keeper holds a key, so isolate it:

1. Create a dedicated user: `useradd -r -s /usr/sbin/nologin helixkeeper`.
2. Put the repo at `/opt/helix-predict`, keeper env at `apps/keeper/.env` (owned by
   `helixkeeper`, `chmod 600`), with a **dedicated** keeper key funded with a little INJ.
3. `cp helix-keeper.service /etc/systemd/system/ && systemctl enable --now helix-keeper`.

The unit runs as `helixkeeper` with `ProtectSystem=strict`, `ProtectHome`, `NoNewPrivileges`,
so it can't read other services' `.env` files or the deployer key. A separate poll-agent timer
(trusted `main` only, CI-green) rebuilds the repo and restarts this service — the keeper box
never runs a GitHub daemon.

## Mainnet

Point `HOUSE_ADDR` at the mainnet house and use a dedicated `KEEPER_PRIVATE_KEY` (never the
deployer mnemonic). Mainnet deploys require explicit authorization.
