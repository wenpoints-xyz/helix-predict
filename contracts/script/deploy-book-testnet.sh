#!/usr/bin/env bash
# Deploy the PredictionBook stack to Injective testnet (chainid 1439) via cast --async + nonce
# polling (forge script hangs on Injective's null receipts). Reuses MockPoints; deploys a FRESH
# HouseVault (the old one's house is one-shot-locked to the retired PredictionHouse) + PredictionBook,
# wires + seeds them. Reads DEPLOYER_MNEMONIC from /root/helixpoints/.env — never printed.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."

set -a; . /root/helixpoints/.env; set +a
RPC="https://k8s.testnet.json-rpc.injective.network/"
M="$DEPLOYER_MNEMONIC"
DEP=$(cast wallet address --mnemonic "$M")
[ "$(cast chain-id --rpc-url "$RPC")" = "1439" ] || { echo "not testnet"; exit 1; }

PYTH=0xDd24F84d36BF92C65F92307595335bdFab5Bbd21
POINTS=0x52045F671C452b7f91a7e436c64f126E78638F14
BTC=0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43
ETHF=0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace
INJF=0x7a5bc1d2b56ad029048cd63964b3ad2776eadf812edc1a43a31406cb54bff592
SEED=100000000000000000000000     # 100_000e18
MINBET=1000000000000000000        # 1e18
MAXBET=2000000000000000000000     # 2000e18
MAXTIP=5000000000000000000        # 5e18

send() { cast send --mnemonic "$M" --rpc-url "$RPC" --async --gas-limit 7000000 "$@" >/dev/null; }
waitn() { local t="$1" n; for i in $(seq 1 90); do n=$(cast nonce "$DEP" --rpc-url "$RPC"); [ "$n" -ge "$t" ] && return 0; sleep 1; done; echo "TIMEOUT nonce $t (at $n)"; exit 1; }

N0=$(cast nonce "$DEP" --rpc-url "$RPC")
VAULT=$(cast compute-address "$DEP" --nonce "$N0" --rpc-url "$RPC" | awk '{print $NF}')
BOOK=$(cast compute-address "$DEP" --nonce "$((N0+1))" --rpc-url "$RPC" | awk '{print $NF}')
echo "deployer=$DEP  start-nonce=$N0"
echo "VAULT (predicted)=$VAULT"
echo "BOOK  (predicted)=$BOOK"

VBC=$(forge inspect HouseVault bytecode)
BBC=$(forge inspect PredictionBook bytecode)

echo ">> [1/10] deploy HouseVault";   send --create "$VBC" "constructor(address,string,string)" "$POINTS" "HELIX House LP (testnet)" "hHLX-t"; waitn $((N0+1))
echo ">> [2/10] deploy PredictionBook"; send --create "$BBC" "constructor(address,address,uint256,uint256,uint256,uint256,uint256)" "$PYTH" "$VAULT" 19500 500 3000 "$MINBET" "$MAXBET"; waitn $((N0+2))
echo ">> [3/10] vault.setHouse(book)"; send "$VAULT" "setHouse(address)" "$BOOK"; waitn $((N0+3))
echo ">> [4/10] addMarket BTC";        send "$BOOK" "addMarket(bytes32)" "$BTC";  waitn $((N0+4))
echo ">> [5/10] addMarket ETH";        send "$BOOK" "addMarket(bytes32)" "$ETHF"; waitn $((N0+5))
echo ">> [6/10] addMarket INJ";        send "$BOOK" "addMarket(bytes32)" "$INJF"; waitn $((N0+6))
echo ">> [7/10] setGuards";            send "$BOOK" "setGuards(uint256,uint256,uint256,uint32,uint64,uint64,uint64,uint64,uint64)" 200 100 "$MAXTIP" 25 5 300 3 5 3600; waitn $((N0+7))
echo ">> [8/10] faucet SEED";          send "$POINTS" "faucet(uint256)" "$SEED"; waitn $((N0+8))
echo ">> [9/10] approve vault SEED";   send "$POINTS" "approve(address,uint256)" "$VAULT" "$SEED"; waitn $((N0+9))
echo ">> [10/10] deposit SEED -> LP";  send "$VAULT" "deposit(uint256,address)" "$SEED" "$DEP"; waitn $((N0+10))

echo "===== VERIFY ====="
echo "vault.house()        = $(cast call "$VAULT" 'house()(address)' --rpc-url "$RPC")   (want $BOOK)"
echo "book.vault()         = $(cast call "$BOOK" 'vault()(address)' --rpc-url "$RPC")   (want $VAULT)"
echo "book.marketsLength() = $(cast call "$BOOK" 'marketsLength()(uint256)' --rpc-url "$RPC")   (want 3)"
echo "book.payoutBps()     = $(cast call "$BOOK" 'payoutBps()(uint256)' --rpc-url "$RPC")   (want 19500)"
echo "book.strikeDelay()   = $(cast call "$BOOK" 'strikeDelay()(uint64)' --rpc-url "$RPC")   (want 3)"
echo "book.settleGrace()   = $(cast call "$BOOK" 'settleGrace()(uint64)' --rpc-url "$RPC")   (want 3600)"
echo "vault.totalAssets()  = $(cast call "$VAULT" 'totalAssets()(uint256)' --rpc-url "$RPC")   (want 100000e18)"
echo ""
echo "BOOK=$BOOK"
echo "VAULT=$VAULT"
