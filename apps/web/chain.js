/* chain.js — zero-dep binding layer for the $HELIXPOINT predict arcade.
   Reads the whole board in ONE eth_call (boardSnapshot) and a user's bets in one
   (myPositions); writes bet/claim/faucet/approve through an injected wallet. Network is
   picked by hostname: predict.test.* (or ?net=test / localhost / *.pages.dev) => testnet
   (live); predict.* => mainnet (gated "coming soon" until $HELIXPOINT's EVM pair lands). */
(function () {
  "use strict";

  // ---- network config ----
  // "pool" is the PredictionHouse (fixed-odds vs an LP vault); "vault" is the HouseVault (ERC4626).
  var NETS = {
    test: {
      key: "test", name: "Injective Testnet", chainIdHex: "0x59f", // 1439
      rpc: "https://k8s.testnet.json-rpc.injective.network/",
      explorer: "https://testnet.blockscout.injective.network",
      pool: "0xe7773Db880BF38574441699A60E53d68a52Db680",   // PredictionHouse
      vault: "0x15FC2a0020A2a8309E602fC7B148B120C9C3b587",  // HouseVault (LP)
      points: "0x52045F671C452b7f91a7e436c64f126E78638F14", // MockPoints (faucet)
      live: true
    },
    prod: {
      key: "prod", name: "Injective Mainnet", chainIdHex: "0x6f0", // 1776
      rpc: "https://sentry.evm-rpc.injective.network/",
      explorer: "https://blockscout.injective.network",
      pool: "", vault: "", points: "", live: false // not deployed yet — frontend gates as "coming soon"
    }
  };
  function pickNet() {
    try {
      var q = new URLSearchParams(location.search).get("net");
      if (q === "test" || q === "prod") return NETS[q];
    } catch (e) {}
    var h = (location.hostname || "").toLowerCase();
    if (h.indexOf("test") !== -1 || h === "localhost" || h === "127.0.0.1" || h.indexOf("pages.dev") !== -1) return NETS.test;
    return NETS.prod;
  }
  var NET = pickNet();
  var UNIT = 1000000000000000000n;   // MockPoints is 18-decimal; 1 chip = 1e18 wei

  // ---- selectors ----
  var SEL = {
    board: "0x938be1ab",   // boardSnapshot()
    myPos: "0x98a973bb",   // myPositions(address,uint256[])
    bet: "0x8decaec0",     // bet(uint256,bool,uint256)
    claim: "0x379607f5",   // claim(uint256)
    faucet: "0x57915897",  // faucet(uint256)
    approve: "0x095ea7b3", // approve(address,uint256)
    balanceOf: "0x70a08231",
    allowance: "0xdd62ed3e",
    // HouseVault (LP)
    houseStats: "0xaa608dbb", // houseStats() -> (bankroll,reserved,free,sharePrice)
    deposit: "0x6e553f65",    // deposit(uint256 assets,address receiver)
    withdraw: "0xb460af94",   // withdraw(uint256 assets,address receiver,address owner)
    maxWithdraw: "0xce96cb77" // maxWithdraw(address)
  };

  // ---- hex/abi helpers ----
  function strip0x(h) { return h && h.indexOf("0x") === 0 ? h.slice(2) : (h || ""); }
  function u256(v) { return BigInt(v).toString(16).padStart(64, "0"); }
  function addr32(a) { return strip0x(a).toLowerCase().padStart(64, "0"); }
  function bool32(b) { return (b ? "1" : "0").padStart(64, "0"); }
  function big(w) { return BigInt("0x" + w); }
  function sInt(w) { var b = big(w); return b >= (1n << 255n) ? b - (1n << 256n) : b; } // signed 2's-complement
  function words(hex) { hex = strip0x(hex); var o = []; for (var i = 0; i < hex.length; i += 64) o.push(hex.substr(i, 64)); return o; }

  // ---- json-rpc ----
  var _id = 0;
  function rpc(method, params) {
    return fetch(NET.rpc, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++_id, method: method, params: params || [] })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw new Error(j.error.message || "rpc error");
      return j.result;
    });
  }
  function ethCall(to, data) { return rpc("eth_call", [{ to: to, data: data }, "latest"]); }

  // ---- decoders ----
  // boardSnapshot() -> RoundInfo[] (dynamic array of a 16-field STATIC struct; +payoutBps vs the pool)
  function decodeBoard(hex) {
    var w = words(hex);
    var base = Number(big(w[0])) / 32;         // offset -> word index of length
    var n = Number(big(w[base]));
    var out = [];
    for (var k = 0; k < n; k++) {
      var s = base + 1 + k * 16;
      out.push({
        marketId: Number(big(w[s + 0])),
        feedId: "0x" + w[s + 1],
        timeframe: Number(big(w[s + 2])),
        marketEnabled: big(w[s + 3]) !== 0n,
        hasRound: big(w[s + 4]) !== 0n,
        roundId: Number(big(w[s + 5])),
        lockTime: Number(big(w[s + 6])),
        expiryTime: Number(big(w[s + 7])),
        strike: sInt(w[s + 8]),   // raw Pyth int64 (BigInt); human = strike * 10^expo
        close: sInt(w[s + 9]),
        upPool: big(w[s + 10]),   // BigInt wei (UP stake total)
        downPool: big(w[s + 11]), // DOWN stake total
        payoutBps: Number(big(w[s + 12])), // fixed odds, e.g. 19500 = 1.95x
        state: Number(big(w[s + 13])), // 0 Open, 1 Locked, 2 Settled
        upWon: big(w[s + 14]) !== 0n,
        voided: big(w[s + 15]) !== 0n
      });
    }
    return out;
  }
  // houseStats() -> (bankroll, reserved, free, sharePrice) all uint256 wei
  function decodeStats(hex) {
    var w = words(hex);
    return { bankroll: big(w[0]), reserved: big(w[1]), free: big(w[2]), sharePrice: big(w[3]) };
  }
  // myPositions -> (uint256[] up, uint256[] down, uint256[] claimable, bool[] didClaim)
  function decodeMyPositions(hex, ids) {
    var w = words(hex);
    function arrAt(byteOff) { var wi = byteOff / 32; var len = Number(big(w[wi])); var a = []; for (var i = 0; i < len; i++) a.push(big(w[wi + 1 + i])); return a; }
    var up = arrAt(Number(big(w[0]))), down = arrAt(Number(big(w[1]))), claim = arrAt(Number(big(w[2]))), dc = arrAt(Number(big(w[3])));
    return ids.map(function (id, i) {
      return { id: id, up: up[i] || 0n, down: down[i] || 0n, claimable: claim[i] || 0n, claimed: (dc[i] || 0n) !== 0n };
    });
  }

  // ---- reads (one call each) ----
  function boardSnapshot() { return ethCall(NET.pool, SEL.board).then(decodeBoard); }
  function myPositions(addr, ids) {
    if (!ids.length) return Promise.resolve([]);
    var data = SEL.myPos + addr32(addr) + u256(64) + u256(ids.length) + ids.map(u256).join("");
    return ethCall(NET.pool, data).then(function (h) { return decodeMyPositions(h, ids); });
  }
  function balanceOf(a) { return ethCall(NET.points, SEL.balanceOf + addr32(a)).then(function (h) { return BigInt(h); }); }
  function allowance(o, s) { return ethCall(NET.points, SEL.allowance + addr32(o) + addr32(s)).then(function (h) { return BigInt(h); }); }
  // ---- house/vault reads ----
  function houseStats() { return ethCall(NET.pool, SEL.houseStats).then(decodeStats); }
  function vaultShares(a) { return ethCall(NET.vault, SEL.balanceOf + addr32(a)).then(function (h) { return BigInt(h); }); }
  function vaultMaxWithdraw(a) { return ethCall(NET.vault, SEL.maxWithdraw + addr32(a)).then(function (h) { return BigInt(h); }); }

  // ---- writes (via injected provider) ----
  function tx(provider, from, to, data, value) {
    var p = { from: from, to: to, data: data };
    if (value) p.value = "0x" + BigInt(value).toString(16);
    return provider.request({ method: "eth_sendTransaction", params: [p] });
  }
  function bet(provider, from, roundId, up, amountWei) { return tx(provider, from, NET.pool, SEL.bet + u256(roundId) + bool32(up) + u256(amountWei)); }
  function claim(provider, from, roundId) { return tx(provider, from, NET.pool, SEL.claim + u256(roundId)); }
  function faucet(provider, from, amountWei) { return tx(provider, from, NET.points, SEL.faucet + u256(amountWei)); }
  function approve(provider, from, spender, amountWei) { return tx(provider, from, NET.points, SEL.approve + addr32(spender) + u256(amountWei)); }
  // LP: deposit points into the vault -> shares; withdraw points back out. approve points to NET.vault first.
  function vaultDeposit(provider, from, assetsWei) { return tx(provider, from, NET.vault, SEL.deposit + u256(assetsWei) + addr32(from)); }
  function vaultWithdraw(provider, from, assetsWei) { return tx(provider, from, NET.vault, SEL.withdraw + u256(assetsWei) + addr32(from) + addr32(from)); }

  // ---- odds (house: FIXED payout per round from payoutBps, e.g. 19500 = 1.95x) ----
  function payout(payoutBps) { return payoutBps ? Number(payoutBps) / 10000 : 0; }
  function potentialWin(stakeWei, payoutBps) { return (stakeWei * BigInt(payoutBps || 0)) / 10000n; }

  // ---- units ----
  function toChips(wei) { return Number(wei / UNIT) + Number(wei % UNIT) / 1e18; }
  function chipsToWei(chips) { return BigInt(Math.round(chips * 1e6)) * (UNIT / 1000000n); }

  // =========================================================================
  // wallet (EIP-6963 + injected, persistent silent reconnect, network switch)
  // =========================================================================
  var providers = {}; // rdns -> {info, provider}
  var wstate = { account: null, provider: null };
  var wcbs = [];
  var WKEY = "predict-wallet";
  function emit() { wcbs.forEach(function (cb) { try { cb(wstate); } catch (e) {} }); }
  function isAddr(a) { return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a); }

  window.addEventListener("eip6963:announceProvider", function (e) {
    var d = e.detail; if (d && d.info && d.provider) providers[d.info.rdns] = d;
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  function injectedList() { return window.ethereum ? (Array.isArray(window.ethereum.providers) ? window.ethereum.providers : [window.ethereum]) : []; }
  function injectedLabel(p) { return p.isRabby ? "Rabby" : p.isBraveWallet ? "Brave" : p.isMetaMask ? "MetaMask" : "Injected"; }
  function walletList() {
    var seen = [], out = [];
    Object.keys(providers).forEach(function (k) { var d = providers[k]; seen.push(d.provider); out.push({ name: d.info.name, icon: d.info.icon, provider: d.provider, id: d.info.rdns }); });
    injectedList().forEach(function (p) { if (p && seen.indexOf(p) === -1) { seen.push(p); out.push({ name: injectedLabel(p), icon: null, provider: p, id: "injected" }); } });
    return out;
  }
  function walletId(p) {
    for (var k in providers) if (providers[k].provider === p) return providers[k].info.rdns;
    if (p.isRabby) return "io.rabby"; if (p.isBraveWallet) return "com.brave.wallet"; if (p.isMetaMask) return "io.metamask"; return "injected";
  }
  function findProvider(id) {
    if (providers[id]) return providers[id].provider;
    var list = injectedList();
    for (var i = 0; i < list.length; i++) {
      var p = list[i]; if (!p) continue;
      if (id === "io.rabby" && p.isRabby) return p;
      if (id === "com.brave.wallet" && p.isBraveWallet) return p;
      if (id === "io.metamask" && p.isMetaMask) return p;
      if (id === "injected") return p;
    }
    return null;
  }
  function wire(p) {
    if (!p || !p.on || p.__pxWired) return;
    p.__pxWired = true;
    p.on("accountsChanged", function (a) { wstate.account = isAddr(a && a[0]) ? a[0] : null; if (!wstate.account) { wstate.provider = null; clearSaved(); } emit(); });
    p.on("chainChanged", function () { emit(); });
  }
  function save(p) { try { localStorage.setItem(WKEY, walletId(p)); } catch (e) {} }
  function clearSaved() { try { localStorage.removeItem(WKEY); } catch (e) {} }
  function saved() { try { return localStorage.getItem(WKEY); } catch (e) { return null; } }

  function connect(provider) {
    return provider.request({ method: "eth_requestAccounts" }).then(function (accts) {
      if (!isAddr(accts && accts[0])) throw new Error("no account");
      wstate.account = accts[0]; wstate.provider = provider; save(provider); wire(provider); emit();
      ensureNetwork(provider);
      return wstate.account;
    });
  }
  function silentReconnect(provider) {
    return provider.request({ method: "eth_accounts" }).then(function (accts) {
      if (isAddr(accts && accts[0])) { wstate.account = accts[0]; wstate.provider = provider; wire(provider); emit(); return true; }
      return false;
    }).catch(function () { return false; });
  }
  function restore() { // silent reconnect on load
    var id = saved(); if (!id) return;
    var tryOne = function () { var p = findProvider(id); if (!p) return false; silentReconnect(p).then(function (ok) { if (!ok) clearSaved(); }); return true; };
    if (tryOne()) return;
    var done = false, on = function () { if (done) return; if (tryOne()) { done = true; window.removeEventListener("eip6963:announceProvider", on); } };
    window.addEventListener("eip6963:announceProvider", on);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(function () { done = true; window.removeEventListener("eip6963:announceProvider", on); }, 3000);
  }
  function disconnect() { clearSaved(); wstate.account = null; wstate.provider = null; emit(); }

  function currentChain() { if (!wstate.provider) return Promise.resolve(null); return wstate.provider.request({ method: "eth_chainId" }).catch(function () { return null; }); }
  function ensureNetwork(provider) {
    return provider.request({ method: "eth_chainId" }).then(function (cid) {
      if (cid === NET.chainIdHex) return;
      return provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: NET.chainIdHex }] }).catch(function (err) {
        if (err && (err.code === 4902 || (err.data && err.data.originalError && err.data.originalError.code === 4902))) {
          return provider.request({ method: "wallet_addEthereumChain", params: [{
            chainId: NET.chainIdHex, chainName: NET.name,
            nativeCurrency: { name: "Injective", symbol: "INJ", decimals: 18 },
            rpcUrls: [NET.rpc], blockExplorerUrls: [NET.explorer]
          }] });
        }
      });
    }).catch(function () {});
  }

  // ---- public API ----
  window.PX = {
    NET: NET,
    boardSnapshot: boardSnapshot, myPositions: myPositions, balanceOf: balanceOf, allowance: allowance,
    houseStats: houseStats, vaultShares: vaultShares, vaultMaxWithdraw: vaultMaxWithdraw,
    bet: bet, claim: claim, faucet: faucet, approve: approve,
    vaultDeposit: vaultDeposit, vaultWithdraw: vaultWithdraw,
    payout: payout, potentialWin: potentialWin, toChips: toChips, chipsToWei: chipsToWei,
    explorerAddr: function (a) { return NET.explorer + "/address/" + a; },
    wallet: {
      list: walletList, connect: connect, restore: restore, disconnect: disconnect,
      ensureNetwork: ensureNetwork, currentChain: currentChain,
      onChange: function (cb) { wcbs.push(cb); },
      get account() { return wstate.account; },
      get provider() { return wstate.provider; }
    }
  };
})();
