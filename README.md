# helix-predict

Short-horizon, parimutuel "above/below" price game on Injective EVM. Players stake
on UP or DOWN for a 30s / 1m / 2m round; the winning side splits the pot minus a rake,
settled on a manipulation-resistant **Pyth** price. No house, no orderbook.

Part of the wenpoints / $HELIXPOINT ecosystem. See the design doc at
`~/.gstack/projects/helixpoints/root-main-design-20260708-120155.md`.

## Structure (monorepo)

```
contracts/          Foundry — Solidity. BUILT: PredictionPool + tests.
  src/PredictionPool.sol
  test/PredictionPool.t.sol
  script/Deploy.s.sol
apps/
  web/              Frontend arcade UI.        (LATER)
  indexer/          Events -> DB -> REST/WS.   (LATER)
packages/
  shared/           ABIs, addresses, Pyth feed IDs, TS types. (LATER)
```

## Status
- [x] `PredictionPool` contract: rounds (open/lock/settle), parimutuel pools, Pyth pull
      settlement with staleness guard, tie/one-sided void rules, pull-based claims, rake,
      permissionless lock/settle. 14 tests + conservation fuzz passing.
- [ ] Points (stake) token + testnet deploy.
- [ ] Settle keeper (Hermes -> updatePriceFeeds -> settle) + createRound cadence.
- [ ] Frontend, indexer.

## Settlement oracle (verified)
Pyth pull oracle on Injective EVM. Mainnet `0x36825bf3Fbdf5a29E2d5148bfe7Dcf7B5639e320`,
testnet `0xDd24F84d36BF92C65F92307595335bdFab5Bbd21`. Feed IDs: BTC
`0xe62df6c8…415b43`, ETH `0xff61491a…fd0ace`, INJ `0x7a5bc1d2…4bff592`.
Per-settlement fee ~0.005 INJ. `getPriceNoOlderThan` reverts on stale prices.

## Dev
```
cd contracts
forge test          # local (Foundry installed)
forge fmt
```
