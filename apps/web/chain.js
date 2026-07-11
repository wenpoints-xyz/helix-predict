/* chain.js — zero-dep binding layer for the $HELIXPOINT predict arcade (PredictionBook model).
   No shared rounds: each user opens their OWN position (openBet), which the keeper settles at a
   fixed past instant. Reads the user's positions (positionsOf + getPosition), the markets list, and
   the LP house stats; writes openBet/claim/faucet/approve through an injected wallet. Network is
   picked by hostname: predict.test.* (or ?net=test / localhost / *.pages.dev) => testnet (live);
   predict.* => mainnet (gated "coming soon" until $HELIXPOINT's EVM pair lands). */
(function () {
  "use strict";

  // ---- network config ----
  // "book" is the PredictionBook (per-user fixed-odds vs an LP vault); "vault" is HouseVault (ERC4626).
  var NETS = {
    test: {
      key: "test", name: "Injective Testnet", chainIdHex: "0x59f", // 1439
      rpc: "https://k8s.testnet.json-rpc.injective.network/",
      explorer: "https://testnet.blockscout.injective.network",
      book: "0x6ea22353f4e6Be0A4D193CE7Bb3f63186BDf74e3",  // PredictionBook (per-user positions)
      vault: "0x745D463b01667Bf15915A27c23746d6D2Ad59f2B", // HouseVault (LP) — fresh, wired to the Book
      points: "0x52045F671C452b7f91a7e436c64f126E78638F14", // MockPoints — has a faucet
      live: true,
      faucet: true,        // MockPoints can be minted for free (test money)
      stakeSymbol: "points",
      chips: [10, 25, 50, 100] // stake presets (test money scale)
    },
    prod: {
      key: "prod", name: "Injective Mainnet", chainIdHex: "0x6f0", // 1776
      rpc: "https://sentry.evm-rpc.injective.network/",
      explorer: "https://blockscout.injective.network",
      // Audited PredictionBook stack, deployed 2026-07-11. Stake = real $HELIXPOINT (18-dec).
      book: "0x98121Af94Ece69bFEC46544ff0Fc202F30010956",  // PredictionBook (mainnet)
      vault: "0x67bf550106dD010Fd071cfd156070bF23352f7cB", // HouseVault (mainnet)
      points: "0xAB3cc28e85056D5AB8f858F322a06AA6f9Eb64BD", // $HELIXPOINT ERC20 — the stake token
      live: true,
      faucet: false,       // NO faucet — HELIXPOINT is real; users buy it (see buyUrl)
      buyUrl: "https://pump.trippyinj.xyz/launch/8",
      stakeSymbol: "$HELIXPOINT",
      chips: [100000, 500000, 1000000, 10000000] // stake presets ($HELIXPOINT scale): 100K/500K/1M/10M
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

  // ---- selectors (PredictionBook) ----
  var SEL = {
    openBet: "0x058a345d",       // openBet(uint256 marketId,bool up,uint256 stake,uint64 dur)
    claim: "0x379607f5",         // claim(uint256 betId)
    voidExpired: "0xb04fe3fa",   // voidExpired(uint256 betId) — refund hatch past grace / while paused
    positionsOf: "0xdc9d54ef",   // positionsOf(address,uint256 start,uint256 count) -> (uint256[] ids,uint256 total)
    getPosition: "0xeb02c301",   // getPosition(uint256) -> Position
    positionsLength: "0xd6887bfa",
    marketsLength: "0xa5402544",
    markets: "0xb1283e77",       // markets(uint256) -> (bytes32 feedId,bool enabled)
    reserveFor: "0x6542ed86",    // reserveFor(uint256 stake)
    owed: "0xb1276604",          // owed(uint256 betId)
    payoutBps: "0x020f09b7",
    minBet: "0x9619367d",
    maxBet: "0x2e5b2168",
    minDur: "0x67b38200",
    maxDur: "0xeab50bd2",
    strikeDelay: "0x51fd4c2a",
    settleGrace: "0x12ae6491",
    tipBps: "0xe79ce788",
    maxTip: "0x7b45eb36",
    maxBetExposureBps: "0x6faa2d3a",
    maxAggExposureBps: "0xd2b4eda2",
    faucet: "0x57915897",        // faucet(uint256)
    approve: "0x095ea7b3",       // approve(address,uint256)
    balanceOf: "0x70a08231",
    allowance: "0xdd62ed3e",
    // HouseVault (LP)
    houseStats: "0xaa608dbb", // houseStats() -> (bankroll,reserved,free,sharePrice)
    deposit: "0x6e553f65",    // deposit(uint256 assets,address receiver)
    withdraw: "0xb460af94",   // withdraw(uint256 assets,address receiver,address owner)
    maxWithdraw: "0xce96cb77" // maxWithdraw(address)
  };
  // Position.result enum
  var RESULT = { OPEN: 0, WIN: 1, LOSS: 2, VOID: 3 };

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
  // getPosition(betId) -> Position (11 STATIC fields, encoded inline)
  function decodePosition(id, hex) {
    var w = words(hex);
    if (w.length < 11) return null;
    return {
      betId: id,
      bettor: "0x" + w[0].slice(24),
      marketId: Number(big(w[1])),
      payoutBps: Number(big(w[2])),
      up: big(w[3]) !== 0n,
      result: Number(big(w[4])),        // 0 Open,1 Win,2 Loss,3 Void
      stake: big(w[5]),                 // wei
      reserve: big(w[6]),
      strikeInstant: Number(big(w[7])), // unix s; first tick >= this = the entry strike
      dur: Number(big(w[8])),           // N seconds; close instant = strikeInstant + dur
      strike: sInt(w[9]),               // raw Pyth int64 (0 until settled)
      close: sInt(w[10])
    };
  }
  // positionsOf(user,start,count) -> (uint256[] ids, uint256 total)
  function decodePositionsOf(hex) {
    var w = words(hex);
    var off = Number(big(w[0])) / 32;   // offset (words) to ids array
    var total = Number(big(w[1]));
    var len = Number(big(w[off]));
    var ids = [];
    for (var i = 0; i < len; i++) ids.push(Number(big(w[off + 1 + i])));
    return { ids: ids, total: total };
  }
  // markets(i) -> (bytes32 feedId, bool enabled)
  function decodeMarket(i, hex) {
    var w = words(hex);
    return { marketId: i, feedId: "0x" + w[0], enabled: big(w[1]) !== 0n };
  }
  // houseStats() -> (bankroll, reserved, free, sharePrice) all uint256 wei
  function decodeStats(hex) {
    var w = words(hex);
    return { bankroll: big(w[0]), reserved: big(w[1]), free: big(w[2]), sharePrice: big(w[3]) };
  }

  // ---- reads ----
  function positionsLength() { return ethCall(NET.book, SEL.positionsLength).then(function (h) { return Number(BigInt(h)); }); }
  function getPosition(id) { return ethCall(NET.book, SEL.getPosition + u256(id)).then(function (h) { return decodePosition(id, h); }); }
  // A user's most-recent `count` positions (paged betIds) then the full struct for each — newest first.
  // Grabs the NEWEST window: positionsOf appends, so for >count bets we page to the tail, not the head.
  function myPositions(addr, count) {
    count = count || 40;
    function finish(ids, total) {
      var order = ids.slice().reverse(); // newest first
      return Promise.all(order.map(getPosition)).then(function (ps) {
        return { total: total, positions: ps.filter(Boolean) };
      });
    }
    return ethCall(NET.book, SEL.positionsOf + addr32(addr) + u256(0) + u256(count)).then(function (h) {
      var r = decodePositionsOf(h);
      if (r.total <= count) return finish(r.ids, r.total);
      var start = r.total - count; // fetch the newest window instead of the oldest
      return ethCall(NET.book, SEL.positionsOf + addr32(addr) + u256(start) + u256(count)).then(function (h2) {
        return finish(decodePositionsOf(h2).ids, r.total);
      });
    });
  }
  function marketsLength() { return ethCall(NET.book, SEL.marketsLength).then(function (h) { return Number(BigInt(h)); }); }
  function markets() { // -> [{marketId,feedId,enabled}]
    return marketsLength().then(function (n) {
      var calls = [];
      for (var i = 0; i < n; i++) (function (i) {
        calls.push(ethCall(NET.book, SEL.markets + u256(i)).then(function (h) { return decodeMarket(i, h); }));
      })(i);
      return Promise.all(calls);
    });
  }
  function owed(id) { return ethCall(NET.book, SEL.owed + u256(id)).then(function (h) { return BigInt(h); }); }
  function reserveFor(stakeWei) { return ethCall(NET.book, SEL.reserveFor + u256(stakeWei)).then(function (h) { return BigInt(h); }); }
  function _param(sel) { return ethCall(NET.book, sel).then(function (h) { return BigInt(h); }); }
  // Batch the config the UI needs (odds, stake bounds, duration bounds) in one go.
  function bookConfig() {
    return Promise.all([
      _param(SEL.payoutBps), _param(SEL.minBet), _param(SEL.maxBet), _param(SEL.minDur), _param(SEL.maxDur), _param(SEL.strikeDelay), _param(SEL.settleGrace), _param(SEL.tipBps), _param(SEL.maxTip), _param(SEL.maxBetExposureBps), _param(SEL.maxAggExposureBps)
    ]).then(function (r) {
      return {
        payoutBps: Number(r[0]), minBet: r[1], maxBet: r[2],
        minDur: Number(r[3]), maxDur: Number(r[4]), strikeDelay: Number(r[5]), settleGrace: Number(r[6]),
        tipBps: Number(r[7]), maxTip: r[8], maxBetExposureBps: Number(r[9]), maxAggExposureBps: Number(r[10])
      };
    });
  }
  function balanceOf(a) { return ethCall(NET.points, SEL.balanceOf + addr32(a)).then(function (h) { return BigInt(h); }); }
  function nativeBalance(a) { return rpc("eth_getBalance", [a, "latest"]).then(function (h) { return BigInt(h); }); } // INJ, for gas
  function allowance(o, s) { return ethCall(NET.points, SEL.allowance + addr32(o) + addr32(s)).then(function (h) { return BigInt(h); }); }
  // ---- house/vault reads ----
  function houseStats() { return ethCall(NET.book, SEL.houseStats).then(decodeStats); }
  function vaultShares(a) { return ethCall(NET.vault, SEL.balanceOf + addr32(a)).then(function (h) { return BigInt(h); }); }
  function vaultMaxWithdraw(a) { return ethCall(NET.vault, SEL.maxWithdraw + addr32(a)).then(function (h) { return BigInt(h); }); }

  // ---- writes (via injected provider) ----
  function tx(provider, from, to, data, value) {
    var p = { from: from, to: to, data: data };
    if (value) p.value = "0x" + BigInt(value).toString(16);
    return provider.request({ method: "eth_sendTransaction", params: [p] });
  }
  function openBet(provider, from, marketId, up, stakeWei, dur) {
    return tx(provider, from, NET.book, SEL.openBet + u256(marketId) + bool32(up) + u256(stakeWei) + u256(dur));
  }
  function claim(provider, from, betId) { return tx(provider, from, NET.book, SEL.claim + u256(betId)); }
  function voidExpired(provider, from, betId) { return tx(provider, from, NET.book, SEL.voidExpired + u256(betId)); }
  function faucet(provider, from, amountWei) { return tx(provider, from, NET.points, SEL.faucet + u256(amountWei)); }
  function approve(provider, from, spender, amountWei) { return tx(provider, from, NET.points, SEL.approve + addr32(spender) + u256(amountWei)); }
  // LP: deposit points into the vault -> shares; withdraw points back out. approve points to NET.vault first.
  function vaultDeposit(provider, from, assetsWei) { return tx(provider, from, NET.vault, SEL.deposit + u256(assetsWei) + addr32(from)); }
  function vaultWithdraw(provider, from, assetsWei) { return tx(provider, from, NET.vault, SEL.withdraw + u256(assetsWei) + addr32(from) + addr32(from)); }

  // ---- odds (FIXED payout from payoutBps, e.g. 19500 = 1.95x) ----
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
    NET: NET, RESULT: RESULT,
    markets: markets, marketsLength: marketsLength, bookConfig: bookConfig,
    myPositions: myPositions, getPosition: getPosition, positionsLength: positionsLength, owed: owed, reserveFor: reserveFor,
    balanceOf: balanceOf, allowance: allowance, nativeBalance: nativeBalance,
    houseStats: houseStats, vaultShares: vaultShares, vaultMaxWithdraw: vaultMaxWithdraw,
    openBet: openBet, claim: claim, voidExpired: voidExpired, faucet: faucet, approve: approve,
    vaultDeposit: vaultDeposit, vaultWithdraw: vaultWithdraw,
    payout: payout, potentialWin: potentialWin, toChips: toChips, chipsToWei: chipsToWei,
    explorerAddr: function (a) { return NET.explorer + "/address/" + a; },
    explorerTx: function (t) { return NET.explorer + "/tx/" + t; },
    wallet: {
      list: walletList, connect: connect, restore: restore, disconnect: disconnect,
      ensureNetwork: ensureNetwork, currentChain: currentChain,
      onChange: function (cb) { wcbs.push(cb); },
      get account() { return wstate.account; },
      get provider() { return wstate.provider; }
    }
  };
})();
