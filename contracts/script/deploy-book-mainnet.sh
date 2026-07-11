#!/usr/bin/env bash
# Deploy the audited PredictionBook stack to Injective EVM MAINNET (chainid 1776) via cast --async +
# nonce polling (forge script hangs on Injective's null receipts). Stake token = real $HELIXPOINT
# ERC20. Deploys a fresh HouseVault (asset = HELIXPOINT) + PredictionBook wired to it and the mainnet
# Pyth pull oracle, adds BTC/ETH/INJ markets, sets audited guards. Does NOT seed — the operator LPs
# $HELIXPOINT after deploy (deployer holds no HELIXPOINT; OFFSET=6 protects the first depositor).
# Reads DEPLOYER_MNEMONIC from /root/helixpoints/.env — never printed.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."

set -a; . /root/helixpoints/.env; set +a
RPC="https://sentry.evm-rpc.injective.network/"
M="$DEPLOYER_MNEMONIC"
DEP=$(cast wallet address --mnemonic "$M")
[ "$(cast chain-id --rpc-url "$RPC")" = "1776" ] || { echo "NOT MAINNET (chainid mismatch)"; exit 1; }

PYTH=0x36825bf3Fbdf5a29E2d5148bfe7Dcf7B5639e320                 # mainnet Pyth (verified: parsePriceFeedUpdatesUnique present)
STAKE=0xAB3cc28e85056D5AB8f858F322a06AA6f9Eb64BD                # $HELIXPOINT ERC20 (bank precompile, 18-dec)
BTC=0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43
ETHF=0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace
INJF=0x7a5bc1d2b56ad029048cd63964b3ad2776eadf812edc1a43a31406cb54bff592

# audited params (owner-tunable post-deploy via setParams/setGuards)
PAYOUT=19500          # 1.95x  (edge 500 bps)
MAXBET_EXP=500        # per-bet vault max-loss cap: 5% of bankroll
MAXAGG_EXP=3000       # aggregate open exposure cap: 30% of bankroll
MINBET=1000000000000000000            # 1 HELIXPOINT
MAXBET=5000000000000000000000000      # 5,000,000 HELIXPOINT (absolute ceiling; exposure caps bind first)
MAXCONF=200           # void if Pyth conf band > 2%
TIP=100               # 1% settler tip (<= edge 500; per-bet edge cap enforces safety)
MAXTIP=1000000000000000000000         # 1,000 HELIXPOINT absolute tip cap
MAXOPEN=25
MINDUR=5
MAXDUR=300
DELTA=3               # strikeDelay
TOL=5                 # settleTol
GRACE=3600            # settleGrace (>= MIN_SETTLE_GRACE 60)

send() { cast send --mnemonic "$M" --rpc-url "$RPC" --async --gas-limit 8000000 "$@" >/dev/null; }
waitn() { local t="$1" n; for i in $(seq 1 120); do n=$(cast nonce "$DEP" --rpc-url "$RPC"); [ "$n" -ge "$t" ] && return 0; sleep 1; done; echo "TIMEOUT nonce $t (at $n)"; exit 1; }

echo "deployer=$DEP"
echo "INJ balance=$(cast balance "$DEP" --rpc-url "$RPC" | cast from-wei)"
N0=$(cast nonce "$DEP" --rpc-url "$RPC")
VAULT=$(cast compute-address "$DEP" --nonce "$N0" --rpc-url "$RPC" | awk '{print $NF}')
BOOK=$(cast compute-address "$DEP" --nonce "$((N0+1))" --rpc-url "$RPC" | awk '{print $NF}')
echo "VAULT (predicted)=$VAULT"
echo "BOOK  (predicted)=$BOOK"

VBC=$(forge inspect HouseVault bytecode)
BBC=$(forge inspect PredictionBook bytecode)

echo ">> [1/7] deploy HouseVault (asset=HELIXPOINT)"
send --create "$VBC" "constructor(address,string,string)" "$STAKE" "HELIX House LP" "hHLX"; waitn $((N0+1))
echo ">> [2/7] deploy PredictionBook"
send --create "$BBC" "constructor(address,address,uint256,uint256,uint256,uint256,uint256)" "$PYTH" "$VAULT" "$PAYOUT" "$MAXBET_EXP" "$MAXAGG_EXP" "$MINBET" "$MAXBET"; waitn $((N0+2))
echo ">> [3/7] vault.setHouse(book)"; send "$VAULT" "setHouse(address)" "$BOOK"; waitn $((N0+3))
echo ">> [4/7] addMarket BTC";        send "$BOOK" "addMarket(bytes32)" "$BTC";  waitn $((N0+4))
echo ">> [5/7] addMarket ETH";        send "$BOOK" "addMarket(bytes32)" "$ETHF"; waitn $((N0+5))
echo ">> [6/7] addMarket INJ";        send "$BOOK" "addMarket(bytes32)" "$INJF"; waitn $((N0+6))
echo ">> [7/7] setGuards";            send "$BOOK" "setGuards(uint256,uint256,uint256,uint32,uint64,uint64,uint64,uint64,uint64)" "$MAXCONF" "$TIP" "$MAXTIP" "$MAXOPEN" "$MINDUR" "$MAXDUR" "$DELTA" "$TOL" "$GRACE"; waitn $((N0+7))

echo "===== VERIFY ====="
echo "vault.house()        = $(cast call "$VAULT" 'house()(address)' --rpc-url "$RPC")   (want $BOOK)"
echo "vault.asset()        = $(cast call "$VAULT" 'asset()(address)' --rpc-url "$RPC")   (want $STAKE)"
echo "book.vault()         = $(cast call "$BOOK" 'vault()(address)' --rpc-url "$RPC")   (want $VAULT)"
echo "book.stakeToken()    = $(cast call "$BOOK" 'stakeToken()(address)' --rpc-url "$RPC")   (want $STAKE)"
echo "book.pyth()          = $(cast call "$BOOK" 'pyth()(address)' --rpc-url "$RPC")   (want $PYTH)"
echo "book.marketsLength() = $(cast call "$BOOK" 'marketsLength()(uint256)' --rpc-url "$RPC")   (want 3)"
echo "book.payoutBps()     = $(cast call "$BOOK" 'payoutBps()(uint256)' --rpc-url "$RPC")   (want 19500)"
echo "book.maxConfBps()    = $(cast call "$BOOK" 'maxConfBps()(uint256)' --rpc-url "$RPC")   (want 200)"
echo "book.tipBps()        = $(cast call "$BOOK" 'tipBps()(uint256)' --rpc-url "$RPC")   (want 100)"
echo "book.settleGrace()   = $(cast call "$BOOK" 'settleGrace()(uint64)' --rpc-url "$RPC")   (want 3600)"
echo "vault.totalAssets()  = $(cast call "$VAULT" 'totalAssets()(uint256)' --rpc-url "$RPC")   (0 until operator LPs)"
echo ""
echo "BOOK=$BOOK"
echo "VAULT=$VAULT"
echo "STAKE=$STAKE"
