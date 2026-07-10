/* PREDICT.EXE — $HELIXPOINT price arcade.
   Zero dependencies. Live prices via Pyth Hermes SSE; rounds/pools/points/bets are ON-CHAIN
   through PredictionPool (see chain.js -> window.PX). Bound to the 30s market per asset.
   All timing is wall-clock (Date.now()) so the contract's lockTime/expiryTime line up with the chart. */
(function () {
  "use strict";

  /* ---------- config ---------- */
  var FEEDS = {
    BTC: { id: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", label: "BTC/USD" },
    ETH: { id: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", label: "ETH/USD" },
    INJ: { id: "7a5bc1d2b56ad029048cd63964b3ad2776eadf812edc1a43a31406cb54bff592", label: "INJ/USD" }
  };
  // Chart window = history:future at 3:1, both derived from the round's ON-CHAIN timeframe —
  // hardcoding these to 60s/30s while rounds are 15s made the head jump right at lock and
  // run off-frame while waiting for the keeper's settle.
  var SPLIT = 0.75; // 3:1 ratio → the bet/future divider is always at 75% of the width
  var TF = 15, POLL_MS = 1200, EXPO = -8; // BTC/ETH/INJ Pyth feeds are expo -8; markets are 15s
  var CHIPS_MAX_CAP = 1000;

  /* ---------- state ---------- */
  var assets = Object.keys(FEEDS);
  var S = {
    asset: "BTC",
    stake: parseInt(localStorage.predict_stake || "25", 10) || 25,
    bal: null, acct: null, board: [], seen: {}, pendingBet: {}, prov: {},
    muted: localStorage.predict_mute === "1",
    feeds: {}, rounds: {}, hist: {},
    hover: null, press: null, flash: null,
    feedMode: "live", lastAnyTick: Date.now() // boot grace: don't fall into sim before the stream ever connects
  };
  assets.forEach(function (a) { S.feeds[a] = { samples: [], disp: null, lastTick: 0 }; S.rounds[a] = null; S.hist[a] = []; });

  /* ---------- dom ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var cv = $("cv"), ctx = cv.getContext("2d");
  var wrap = $("chartwrap");
  var el = { rid: $("rid"), phase: $("phase"), clock: $("clock"), bal: $("bal"), hist: $("hist"),
             led: $("led"), px: $("px"), feedlbl: $("feedlbl"), getpts: $("getpts"),
             connect: $("connect"), netbanner: $("netbanner"),
             lp: $("lp"), lpToggle: $("lpToggle"), lpBank: $("lpBank"), lpMine: $("lpMine"),
             lpUtil: $("lpUtil"), lpAmt: $("lpAmt"), lpDep: $("lpDep"), lpWd: $("lpWd"), lpMsg: $("lpMsg") };

  /* ---------- theme + palette ---------- */
  var PAL = {};
  function readPalette() {
    var cs = getComputedStyle(document.documentElement);
    ["ink", "ink-dim", "accent", "accent-2", "ok", "bad", "panel-2", "bevel-dk"].forEach(function (k) { PAL[k] = cs.getPropertyValue("--" + k).trim(); });
  }
  var COMIC_CANVAS = "'Comic Sans MS','Comic Sans','Chalkboard SE','Comic Neue',sans-serif";
  document.documentElement.dataset.theme = localStorage.predict_theme || "dark";
  readPalette();
  $("themebtn").onclick = function () {
    var t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = t; localStorage.predict_theme = t; readPalette();
  };

  /* ---------- audio ---------- */
  var AC = null;
  function beep(f, ms, type, g) {
    if (S.muted) return;
    try {
      AC = AC || new (window.AudioContext || window.webkitAudioContext)();
      var o = AC.createOscillator(), gn = AC.createGain();
      o.type = type || "square"; o.frequency.value = f;
      gn.gain.setValueAtTime(g || 0.04, AC.currentTime);
      gn.gain.exponentialRampToValueAtTime(0.0001, AC.currentTime + ms / 1000);
      o.connect(gn); gn.connect(AC.destination); o.start(); o.stop(AC.currentTime + ms / 1000);
    } catch (e) {}
  }
  function updateMuteBtn() { $("mutebtn").textContent = S.muted ? "×" : "♪"; }
  $("mutebtn").onclick = function () { S.muted = !S.muted; localStorage.predict_mute = S.muted ? "1" : "0"; updateMuteBtn(); };
  updateMuteBtn();

  /* ---------- build stamp (footer): sha injected at deploy; tap shows deploy time ---------- */
  var verEl = $("ver");
  if (verEl) {
    if (verEl.textContent.indexOf("__") >= 0) { verEl.textContent = "dev build"; verEl.removeAttribute("data-time"); }
    verEl.onclick = function () { toast(verEl.dataset.time ? "deployed " + verEl.dataset.time : "local dev build"); };
  }

  /* ---------- price feed: Pyth Hermes SSE (wall-clock samples) ---------- */
  var es = null, retryMs = 1000;
  var ID2ASSET = {};
  assets.forEach(function (a) { ID2ASSET[FEEDS[a].id.toLowerCase()] = a; });
  function connectFeed() {
    var url = "https://hermes.pyth.network/v2/updates/price/stream?parsed=true";
    assets.forEach(function (a) { url += "&ids[]=" + FEEDS[a].id; });
    try { es = new EventSource(url); } catch (e) { scheduleRetry(); return; }
    es.onmessage = function (ev) {
      var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      (d.parsed || []).forEach(function (u) {
        var a = ID2ASSET[(u.id || "").replace(/^0x/, "").toLowerCase()];
        if (!a || !u.price) return;
        var p = Number(u.price.price) * Math.pow(10, u.price.expo);
        if (p > 0) pushSample(a, p, false, Number(u.price.publish_time || 0)); // keep publish_time to match the on-chain strike
      });
      retryMs = 1000; S.feedMode = "live"; S.lastAnyTick = Date.now();
    };
    es.onerror = function () { try { es.close(); } catch (e) {} scheduleRetry(); };
  }
  function scheduleRetry() { setTimeout(connectFeed, retryMs); retryMs = Math.min(retryMs * 2, 15000); }
  function pushSample(a, p, sim, pt) {
    var f = S.feeds[a], t = Date.now();
    if (!sim && f._hasSim) { // first live tick after a sim stretch: drop the fabricated history
      f.samples = f.samples.filter(function (s) { return !s.sim; });
      f._hasSim = false;
    }
    f.samples.push({ t: t, p: p, sim: !!sim, pt: pt || 0 }); f.lastTick = t; // pt = Pyth publish_time (0 for sim)
    if (sim) f._hasSim = true;
    var cutoff = t - 120000; // covers the widest window (4×timeframe) plus settle-wait slack
    while (f.samples.length && f.samples[0].t < cutoff) f.samples.shift();
    if (f.disp === null) f.disp = p;
  }
  function syntheticTick(now, dt) {
    if (S.feedMode === "live" && now - S.lastAnyTick < 8000) return;
    S.feedMode = "sim";
    assets.forEach(function (a) {
      var f = S.feeds[a];
      if (!f.samples.length) return; // never invent a price level — only extrapolate a known one
      var last = f.samples[f.samples.length - 1].p;
      f._accum = (f._accum || 0) + dt;
      if (f._accum > 400) { f._accum = 0; pushSample(a, last * (1 + (Math.random() - 0.5) * 0.0008), true); }
    });
  }

  /* =========================================================================
     ON-CHAIN round binding: poll boardSnapshot -> S.rounds; myPositions -> my/claim
     ========================================================================= */
  function marketFor(asset) {
    var fid = FEEDS[asset].id.toLowerCase();
    for (var i = 0; i < S.board.length; i++) {
      var m = S.board[i];
      if (m.feedId.replace(/^0x/, "").toLowerCase() === fid && m.timeframe === TF) return m;
    }
    return null;
  }
  // House: fixed odds. The payout multiplier is the round's payoutBps (same for both sides),
  // known from creation, so it doesn't drift with the crowd like parimutuel did.
  function mult(r) { return PX.payout(r.payoutBps); }
  function mapRound(m) {
    if (!m || !m.hasRound) return null;
    var nowS = Date.now() / 1000;
    var betting = m.state === 0 && nowS < m.lockTime;
    var strike = m.state >= 1 ? Number(m.strike) * Math.pow(10, EXPO) : null;
    var pm = PX.payout(m.payoutBps);
    var r = {
      n: m.roundId, roundId: m.roundId, state: m.state, upWon: m.upWon, voided: m.voided,
      phase: betting ? "bet" : "play",
      lockTime: m.lockTime * 1000,
      tfMs: m.timeframe * 1000,
      tEnd: (betting ? m.lockTime : m.expiryTime) * 1000,
      strike: strike, payoutBps: m.payoutBps,
      pools: { up: PX.toChips(m.upPool), down: PX.toChips(m.downPool) },
      my: { up: 0, down: 0 }, claimable: 0, claimed: false
    };
    r.lockMult = { up: pm, down: pm };
    return r;
  }
  // Effective strike + status. The on-chain strike is final once it lands (~4-6s after lockTime given
  // Pyth's ~3s publish lag + mine time). Before that, freeze a provisional the instant betting closes so
  // the lock feels immediate, then snap to the EXACT price the contract locks — the first streamed Pyth
  // sample whose publish_time >= lockTime — the moment it arrives. No dependence on the laggy chain read.
  function strikeFor(r, f) {
    if (!r || !f) return { p: f && f.disp, status: "live" };
    if (r.strike) return { p: r.strike, status: "locked" }; // on-chain, authoritative
    if (r.phase !== "play" || !r.lockTime) return { p: f.disp, status: "live" }; // still betting / no round
    var key = r.roundId, lockSec = r.lockTime / 1000, confirmed = null;
    for (var i = 0; i < f.samples.length; i++) {
      if (f.samples[i].pt && f.samples[i].pt >= lockSec) { confirmed = f.samples[i].p; break; } // == the on-chain strike
    }
    if (confirmed != null) { S.prov[key] = confirmed; return { p: confirmed, status: "locked" }; }
    if (S.prov[key] == null) S.prov[key] = f.disp; // instant freeze at the lock-moment price
    return { p: S.prov[key], status: "locking" };
  }
  function poll() {
    if (!PX.NET.live) return;
    PX.boardSnapshot().then(function (board) {
      S.board = board;
      var ids = [];
      assets.forEach(function (a) { var m = marketFor(a); if (m && m.hasRound) ids.push(m.roundId); });
      var posP = (S.acct && ids.length) ? PX.myPositions(S.acct, ids).catch(function () { return []; }) : Promise.resolve([]);
      return posP.then(function (positions) {
        var by = {}; positions.forEach(function (p) { by[p.id] = p; });
        assets.forEach(function (a) {
          var m = marketFor(a), r = mapRound(m);
          if (r) {
            var p = by[r.roundId];
            if (p) { r.my.up = PX.toChips(p.up); r.my.down = PX.toChips(p.down); r.claimable = PX.toChips(p.claimable); r.claimed = p.claimed; }
            if (r.my.up + r.my.down > 0 || S.pendingBet[r.roundId] < Date.now() - 45000) delete S.pendingBet[r.roundId];
            // EMPTY round past lockTime: the keeper never locks it (no Pyth fee for empty
            // rounds) — it orphans it and opens the next slot. Mirror that: "roll" phase, no
            // fake lock. Own bets/pending txs suppress it — the board poll is ~1.2s stale and
            // "NO BETS" must never flash at a user who just bet.
            if (r.state === 0 && Date.now() >= r.lockTime &&
                r.pools.up + r.pools.down === 0 && r.my.up + r.my.down === 0 &&
                !S.pendingBet[r.roundId]) {
              r.phase = "roll";
              var prev = S.rounds[a];
              r.rollSince = (prev && prev.roundId === r.roundId && prev.rollSince) || Date.now();
            }
          }
          if (m && m.hasRound && m.state === 2 && !S.seen[m.roundId]) recordResult(a, m, by[m.roundId]);
          S.rounds[a] = r;
        });
      });
    }).catch(function () {}).then(function () { if (S.acct) refreshBalance(); refreshLp(); });
  }
  function recordResult(a, m, pos) {
    S.seen[m.roundId] = true;
    delete S.prov[m.roundId]; // round done — drop its provisional-strike cache
    var up = pos ? PX.toChips(pos.up) : 0, down = pos ? PX.toChips(pos.down) : 0;
    var claimable = pos ? PX.toChips(pos.claimable) : 0, claimed = pos ? pos.claimed : false;
    var dir = m.voided ? "tie" : (m.upWon ? "up" : "down");
    var mine = null, delta = 0;
    if (m.voided) { if (up + down > 0) { mine = "tie"; delta = up + down; } }
    else { var ws = m.upWon ? up : down; if (ws > 0) { mine = "win"; delta = claimable; } else if (up + down > 0) mine = "lose"; }
    S.hist[a].unshift({ dir: dir, mine: mine, delta: Math.floor(delta) });
    S.hist[a] = S.hist[a].slice(0, 16);
    if ((mine === "win" || mine === "tie") && claimable > 0 && !claimed) claimRound(m.roundId);
    if (a === S.asset) {
      S.flash = { t0: Date.now(), dir: dir, mine: mine };
      if (mine === "win") { beep(660, 90); setTimeout(function () { beep(990, 140); }, 90); flyPoints("+" + Math.floor(delta), PAL.ok, dir); }
      else if (mine === "lose") { beep(120, 180, "sawtooth", 0.05); flyPoints("rekt", PAL.bad, dir); }
      else if (mine === "tie") { flyPoints("push · refund", PAL["ink-dim"], "up"); }
      renderHist();
    }
  }
  function claimRound(id) {
    if (!S.acct) return;
    PX.claim(PX.wallet.provider, S.acct, id).then(function () { setTimeout(poll, 2500); }).catch(function () {});
  }
  function refreshBalance() {
    if (!S.acct) { S.bal = null; updateBalance(); return; }
    PX.balanceOf(S.acct).then(function (w) { S.bal = PX.toChips(w); updateBalance(); }).catch(function () {});
  }

  /* ---------- wallet ---------- */
  function short(a) { return a.slice(0, 6) + "…" + a.slice(-4); }
  function refreshConnectBtn() {
    el.connect.textContent = S.acct ? short(S.acct) : "CONNECT";
    el.connect.title = S.acct ? "disconnect" : "connect wallet";
  }
  function openWallet() {
    var list = PX.wallet.list();
    if (!list.length) { toast("No EVM wallet found — install MetaMask, Rabby or Keplr."); return; }
    if (list.length === 1) { doConnect(list[0].provider); return; }
    showPicker(list);
  }
  function doConnect(provider) { PX.wallet.connect(provider).catch(function (e) { toast(e && e.code === 4001 ? "Connection cancelled." : "Could not connect."); }); }
  function showPicker(list) {
    var ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;background:rgba(6,11,22,.8);display:flex;align-items:center;justify-content:center;z-index:9998;padding:16px";
    var box = document.createElement("div");
    box.style.cssText = "background:var(--panel);border:3px solid;border-color:var(--bevel-lt) var(--bevel-dk) var(--bevel-dk) var(--bevel-lt);padding:14px;min-width:220px;max-width:92vw";
    box.innerHTML = "<div style='font-family:var(--comic);font-weight:bold;color:var(--accent-2);margin-bottom:8px'>Pick a wallet</div>";
    list.forEach(function (w) {
      var b = document.createElement("button");
      b.className = "getpts"; b.style.cssText = "display:block;width:100%;text-align:left;margin:4px 0";
      b.textContent = w.name;
      b.onclick = function () { document.body.removeChild(ov); doConnect(w.provider); };
      box.appendChild(b);
    });
    ov.appendChild(box);
    ov.onclick = function (e) { if (e.target === ov) document.body.removeChild(ov); };
    document.body.appendChild(ov);
  }
  el.connect.onclick = function () { if (S.acct) PX.wallet.disconnect(); else openWallet(); };
  function checkNet() {
    // .histbar sets display, which overrides the [hidden] attr — so toggle display directly.
    if (!S.acct) { el.netbanner.style.display = "none"; return; }
    PX.wallet.currentChain().then(function (cid) { el.netbanner.style.display = (cid === PX.NET.chainIdHex) ? "none" : "block"; });
  }
  el.netbanner.onclick = function () { if (PX.wallet.provider) PX.wallet.ensureNetwork(PX.wallet.provider).then(checkNet); };
  var gasWarnedFor = null;
  function checkGas() {
    if (!S.acct || S.acct === gasWarnedFor || !PX.NET.live) return;
    gasWarnedFor = S.acct;
    PX.nativeBalance(S.acct).then(function (w) {
      if (w < 1000000000000000n) toast("Low on INJ gas — every tx needs a little INJ. Get it free at faucet.injective.network."); // < 0.001 INJ
    }).catch(function () {});
  }
  PX.wallet.onChange(function (w) {
    S.acct = w.account; refreshConnectBtn(); checkNet();
    if (S.acct) { poll(); checkGas(); } else { S.bal = null; updateBalance(); }
  });

  /* ---------- toast ---------- */
  var toastEl = null, toastT = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.style.cssText = "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);background:var(--panel-2);color:var(--ink);border:2px solid var(--accent);padding:8px 14px;font-size:13px;z-index:9997;max-width:92vw;text-align:center";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg; toastEl.style.display = "block";
    clearTimeout(toastT); toastT = setTimeout(function () { toastEl.style.display = "none"; }, 4200);
  }
  // Turn a wallet/RPC error into a human message. Every tx (even the free points faucet) costs INJ
  // gas, so a 0-INJ wallet fails at broadcast with "insufficient funds" — surface that clearly.
  function txErr(e, fallback) {
    if (e && e.code === 4001) return "Cancelled.";
    var m = ((e && (e.message || (e.data && e.data.message) || (e.error && e.error.message))) || "").toLowerCase();
    if (m.indexOf("insufficient funds") !== -1 || m.indexOf("sender balance") !== -1 || m.indexOf("gas required") !== -1)
      return "No gas — you need testnet INJ. Get it free at faucet.injective.network, then retry.";
    return fallback;
  }

  /* ---------- betting (on-chain) ---------- */
  function stakeValue() { return S.stake === "max" ? Math.max(0, Math.min(S.bal || 0, CHIPS_MAX_CAP)) : S.stake; }
  function placeBet(side) {
    if (!S.acct) { openWallet(); return; }
    var r = S.rounds[S.asset];
    if (r && r.phase === "roll") return; // tiles are visibly disabled — no error beep
    if (!r || r.phase !== "bet" || Date.now() >= r.tEnd) { beep(160, 40, "sawtooth"); return; }
    var chips = stakeValue();
    if (chips <= 0) { beep(160, 60, "sawtooth"); return; }
    if (S.bal != null && S.bal < chips) { el.getpts.hidden = false; beep(160, 60, "sawtooth"); toast("Not enough points — hit the faucet."); return; }
    var amt = PX.chipsToWei(chips), prov = PX.wallet.provider, from = S.acct, rid = r.roundId, up = side === "up";
    beep(600, 30); if (navigator.vibrate) navigator.vibrate(12);
    S.pendingBet[rid] = Date.now(); // suppresses the "NO BETS" roll state until the board sees it
    ensureAllowance(from, amt)
      .then(function () { return PX.bet(prov, from, rid, up, amt); })
      .then(function () { flyPoints("bet " + chips, PAL.accent, side); setTimeout(poll, 1500); })
      .catch(function (e) { delete S.pendingBet[rid]; toast(txErr(e, "Bet failed.")); });
  }
  function ensureAllowance(from, amt) {
    return PX.allowance(from, PX.NET.pool).then(function (a) {
      if (a >= amt) return;
      toast("One-time approve — confirm in wallet.");
      return PX.approve(PX.wallet.provider, from, PX.NET.pool, (1n << 256n) - 1n).then(function () { return waitAllowance(from, amt); });
    });
  }
  function waitAllowance(from, amt) {
    return new Promise(function (res, rej) {
      var tries = 0;
      (function loop() {
        PX.allowance(from, PX.NET.pool).then(function (a) {
          if (a >= amt) return res();
          if (++tries > 40) return rej(new Error("approve timeout"));
          setTimeout(loop, 1500);
        }).catch(function () { setTimeout(loop, 1500); });
      })();
    });
  }
  function updateBalance() {
    el.bal.textContent = S.bal == null ? "—" : Math.floor(S.bal).toLocaleString("en-US");
    el.getpts.hidden = !(S.acct && S.bal != null && S.bal < 10);
  }
  el.getpts.onclick = function () {
    if (!S.acct) { openWallet(); return; }
    toast("Minting test points — confirm in wallet.");
    PX.faucet(PX.wallet.provider, S.acct, PX.chipsToWei(1000))
      .then(function () { flyPoints("+1000", PAL.ok, "up"); setTimeout(poll, 2500); })
      .catch(function (e) { toast(txErr(e, "Faucet failed.")); });
  };

  /* ---------- LP vault: "be the house" ---------- */
  var lpShown = false;
  el.lpToggle.onclick = function () {
    lpShown = !lpShown;
    el.lp.hidden = !lpShown;
    el.lpToggle.textContent = (lpShown ? "▾" : "▸") + " BE THE HOUSE";
    if (lpShown) refreshLp();
  };
  function refreshLp() {
    if (!PX.NET.live || !lpShown) return;
    PX.houseStats().then(function (s) {
      el.lpBank.textContent = Math.floor(PX.toChips(s.bankroll)).toLocaleString("en-US");
      var util = s.bankroll > 0n ? Number(s.reserved * 10000n / s.bankroll) / 100 : 0;
      el.lpUtil.textContent = util.toFixed(1) + "%";
      if (S.acct) {
        PX.vaultShares(S.acct).then(function (sh) {
          var assets = sh * s.sharePrice / (10n ** 18n); // shares -> points at current price
          el.lpMine.textContent = Math.floor(PX.toChips(assets)).toLocaleString("en-US");
        }).catch(function () {});
      } else { el.lpMine.textContent = "—"; }
    }).catch(function () {});
  }
  function ensureVaultAllowance(from, amt) {
    return PX.allowance(from, PX.NET.vault).then(function (a) {
      if (a >= amt) return;
      el.lpMsg.textContent = "One-time approve — confirm in wallet.";
      return PX.approve(PX.wallet.provider, from, PX.NET.vault, (1n << 256n) - 1n).then(function () { return waitAllowanceVault(from, amt); });
    });
  }
  function waitAllowanceVault(from, amt) {
    return new Promise(function (res, rej) {
      var tries = 0, iv = setInterval(function () {
        PX.allowance(from, PX.NET.vault).then(function (a) {
          if (a >= amt) { clearInterval(iv); res(); }
          else if (++tries > 40) { clearInterval(iv); rej(new Error("approve timeout")); }
        });
      }, 800);
    });
  }
  el.lpDep.onclick = function () {
    if (!S.acct) { openWallet(); return; }
    var chips = parseFloat(el.lpAmt.value); if (!(chips > 0)) { el.lpMsg.textContent = "Enter an amount."; return; }
    var amt = PX.chipsToWei(chips), from = S.acct;
    if (S.bal != null && S.bal < chips) { el.lpMsg.textContent = "Not enough points — hit the faucet."; return; }
    el.lpMsg.textContent = "Depositing to the house…";
    ensureVaultAllowance(from, amt)
      .then(function () { return PX.vaultDeposit(PX.wallet.provider, from, amt); })
      .then(function () { el.lpMsg.textContent = "Deposited. You're backing bets now."; el.lpAmt.value = ""; setTimeout(function () { refreshLp(); refreshBalance(); }, 2500); })
      .catch(function (e) { el.lpMsg.textContent = txErr(e, "Deposit failed."); });
  };
  el.lpWd.onclick = function () {
    if (!S.acct) { openWallet(); return; }
    var chips = parseFloat(el.lpAmt.value); if (!(chips > 0)) { el.lpMsg.textContent = "Enter an amount."; return; }
    var from = S.acct;
    el.lpMsg.textContent = "Withdrawing…";
    PX.vaultWithdraw(PX.wallet.provider, from, PX.chipsToWei(chips))
      .then(function () { el.lpMsg.textContent = "Withdrawn (only free, unreserved capital)."; el.lpAmt.value = ""; setTimeout(function () { refreshLp(); refreshBalance(); }, 2500); })
      .catch(function (e) { el.lpMsg.textContent = txErr(e, "Withdraw failed (capital may be backing open bets)."); });
  };

  /* ---------- flying points ---------- */
  function flyPoints(text, color, side) {
    var d = document.createElement("div");
    d.className = "fly"; d.textContent = text; d.style.color = color;
    var rct = cv.getBoundingClientRect();
    d.style.left = (rct.width * 0.78 - 40) + "px";
    d.style.top = (rct.height * (side === "up" ? 0.28 : 0.68)) + "px";
    wrap.appendChild(d);
    requestAnimationFrame(function () { d.style.transform = "translateY(-70px)"; d.style.opacity = "0"; });
    setTimeout(function () { d.remove(); }, 1200);
  }

  /* ---------- canvas ---------- */
  var W = 0, H = 0, DPR = 1;
  function resize() {
    var w = wrap.clientWidth, h = Math.max(240, Math.min(Math.round(window.innerHeight * 0.42), 400));
    DPR = window.devicePixelRatio || 1;
    cv.width = Math.round(w * DPR); cv.height = Math.round(h * DPR); cv.style.height = h + "px"; W = w; H = h;
  }
  window.addEventListener("resize", resize);

  var yScale = { min: 0, max: 1, init: false };
  function draw(now) {
    var f = S.feeds[S.asset], r = S.rounds[S.asset];
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var splitX = Math.round(W * SPLIT);

    if (!f.samples.length) {
      ctx.fillStyle = PAL["ink-dim"]; ctx.font = "bold 14px 'Courier New',monospace"; ctx.textAlign = "center";
      ctx.fillText("dialing up the price feed…", W / 2, H / 2);
      return;
    }
    var last = f.samples[f.samples.length - 1].p;
    // ease toward the live price, but snap when far off (>0.2%) — disp goes stale for
    // background tabs (easing only runs for the active asset), and a visible glide from
    // a minutes-old price reads as a wrong price, not an animation
    if (Math.abs(last - f.disp) > last * 0.002) f.disp = last;
    else f.disp += (last - f.disp) * 0.18;

    var playing = r && r.phase === "play";
    // Future span = the round's real timeframe (15s markets), history = 3× that. During play the
    // right edge pins to expiry so the head glides from the split to the finish; once expiry
    // passes (waiting on the keeper's settle) the window follows `now`, keeping the head pinned
    // at the right edge — no cap, the finish-line marker scrolls left with history instead.
    var futMs = (r && r.tfMs) || TF * 1000, histMs = 3 * futMs;
    var t1 = playing ? Math.max(r.tEnd, now) : now + futMs;
    var t0 = t1 - (histMs + futMs);
    var xOf = function (t) { return (t - t0) / (t1 - t0) * W; };

    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < f.samples.length; i++) { var sm = f.samples[i]; if (sm.t < t0) continue; if (sm.p < lo) lo = sm.p; if (sm.p > hi) hi = sm.p; }
    var strike = strikeFor(r, f).p;
    if (strike < lo) lo = strike; if (strike > hi) hi = strike;
    var pad = Math.max((hi - lo) * 0.35, strike * 0.0004);
    var tMin = lo - pad, tMax = hi + pad;
    if (!yScale.init) { yScale.min = tMin; yScale.max = tMax; yScale.init = true; }
    yScale.min += (tMin - yScale.min) * 0.1; yScale.max += (tMax - yScale.max) * 0.1;
    var yOf = function (p) { return H - (p - yScale.min) / (yScale.max - yScale.min) * H; };
    var strikeY = Math.max(26, Math.min(H - 26, yOf(strike)));

    var betting = r && r.phase === "bet";
    var rolling = r && r.phase === "roll";
    var zones = [{ side: "up", y0: 0, y1: strikeY, col: PAL.ok }, { side: "down", y0: strikeY, y1: H, col: PAL.bad }];
    zones.forEach(function (z) {
      var alpha = rolling ? 0.04 : 0.10;
      if (betting && S.hover === z.side) alpha = 0.17;
      if (betting && S.press === z.side) alpha = 0.26;
      if (r && r.my[z.side] > 0) alpha += 0.05;
      ctx.globalAlpha = alpha; ctx.fillStyle = z.col; ctx.fillRect(splitX, z.y0, W - splitX, z.y1 - z.y0); ctx.globalAlpha = 1;
    });
    if (S.flash && now - S.flash.t0 < 650 && S.flash.dir !== "tie") {
      var k = 1 - (now - S.flash.t0) / 650;
      ctx.globalAlpha = 0.35 * k; ctx.fillStyle = S.flash.dir === "up" ? PAL.ok : PAL.bad;
      var zy = S.flash.dir === "up" ? [0, strikeY] : [strikeY, H];
      ctx.fillRect(splitX, zy[0], W - splitX, zy[1] - zy[0]); ctx.globalAlpha = 1;
    }

    ctx.strokeStyle = PAL["ink-dim"]; ctx.globalAlpha = 0.18; ctx.lineWidth = 1;
    ctx.font = "10px 'Courier New',monospace"; ctx.textAlign = "left";
    for (var g = 1; g <= 3; g++) { var gy = H * g / 4; ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }
    ctx.globalAlpha = 0.55; ctx.fillStyle = PAL["ink-dim"];
    for (g = 1; g <= 3; g++) { var gp = yScale.max - (yScale.max - yScale.min) * g / 4; ctx.fillText(fmt(gp), 4, H * g / 4 - 3); }
    ctx.globalAlpha = 1;

    ctx.strokeStyle = PAL["ink-dim"]; ctx.globalAlpha = 0.4; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(splitX, 0); ctx.lineTo(splitX, H); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;

    ctx.strokeStyle = PAL.accent; ctx.lineWidth = betting || rolling ? 1.5 : 2;
    if (betting || rolling) ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(0, strikeY); ctx.lineTo(W, strikeY); ctx.stroke(); ctx.setLineDash([]);
    var tag = "@ " + fmt(strike);
    ctx.font = "bold 11px 'Courier New',monospace";
    var tw = ctx.measureText(tag).width + 10;
    ctx.fillStyle = PAL.accent; ctx.fillRect(splitX - tw - 4, strikeY - 9, tw, 18);
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.fillText(tag, splitX - tw / 2 - 4, strikeY + 4);

    ctx.strokeStyle = PAL["accent-2"]; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.beginPath();
    var started = false;
    for (i = 0; i < f.samples.length; i++) {
      sm = f.samples[i]; if (sm.t < t0 - 1000) continue;
      var px = xOf(sm.t), py = yOf(sm.p);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    var headX = xOf(now), headY = yOf(f.disp);
    if (started) ctx.lineTo(headX, headY);
    ctx.stroke();
    ctx.fillStyle = PAL["accent-2"];
    ctx.globalAlpha = 0.25; ctx.beginPath(); ctx.arc(headX, headY, 7, 0, 7); ctx.fill();
    ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(headX, headY, 3, 0, 7); ctx.fill();

    if (r && rolling) {
      // empty round rolled by the keeper: calm beat, no fake lock theater
      var rx = splitX + (W - splitX) / 2;
      ctx.textAlign = "center"; ctx.fillStyle = PAL["ink-dim"];
      ctx.font = "bold 14px " + COMIC_CANVAS;
      ctx.fillText("NO BETS", rx, H / 2 - 8);
      ctx.font = "11px 'Courier New',monospace";
      ctx.fillText(now - r.rollSince > 10000 ? "waiting for next round…" : "rolling to next round…", rx, H / 2 + 12);
    } else if (r) {
      var zx = splitX + (W - splitX) / 2;
      zones.forEach(function (z) {
        var mid = (z.y0 + z.y1) / 2;
        var m = r.lockMult[z.side]; // fixed odds: same before and after lock
        ctx.fillStyle = z.col; ctx.font = "bold 13px " + COMIC_CANVAS;
        var label = z.side === "up" ? "UP" : "DOWN";
        var lw = ctx.measureText(label).width;
        ctx.textAlign = "left"; ctx.fillText(label, zx - lw / 2 + 6, mid - 22);
        var tx = zx - lw / 2 - 5, ty = mid - 26;
        ctx.beginPath();
        if (z.side === "up") { ctx.moveTo(tx - 6, ty + 4); ctx.lineTo(tx + 6, ty + 4); ctx.lineTo(tx, ty - 5); }
        else { ctx.moveTo(tx - 6, ty - 5); ctx.lineTo(tx + 6, ty - 5); ctx.lineTo(tx, ty + 4); }
        ctx.closePath(); ctx.fill();
        ctx.textAlign = "center"; ctx.font = "bold 24px 'Courier New',monospace";
        ctx.fillText("×" + m.toFixed(2), zx, mid + 2);
        ctx.font = "11px 'Courier New',monospace"; ctx.fillStyle = PAL.ink;
        var v = stakeValue();
        if (betting && v > 0) ctx.fillText("win " + Math.floor(v * m) + " pts", zx, mid + 18);
        if (r.my[z.side] > 0) { ctx.fillStyle = z.col; ctx.fillText("YOU: " + Math.floor(r.my[z.side]), zx, mid + 32); }
        ctx.fillStyle = PAL["ink-dim"]; ctx.fillText("bets " + Math.floor(r.pools[z.side]), zx, z.y1 - 6 < mid + 40 ? z.y0 + 12 : z.y1 - 6);
      });
      ctx.font = "bold 10px 'Courier New',monospace"; ctx.textAlign = "center";
      ctx.fillStyle = betting ? PAL.ok : PAL.bad;
      ctx.fillText(betting ? ">> BETS OPEN <<" : "LOCKED - SWEAT", splitX + (W - splitX) / 2, 12);
    }
    if (playing) {
      // finish line at the round's actual expiry — stays put at the right edge until expiry,
      // then scrolls left with history while the head waits at the live edge for settlement
      var fx = Math.min(xOf(r.tEnd), W - 1);
      ctx.strokeStyle = PAL.ink; ctx.globalAlpha = 0.5; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(fx, 0); ctx.lineTo(fx, H); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      // the round settles on the first Pyth tick published AT/AFTER expiry, not at the line
      // itself — ring that tick so the "price decided after the line" moment is visible
      if (now >= r.tEnd) {
        var endSec = r.tEnd / 1000;
        for (var si = 0; si < f.samples.length; si++) {
          var sp = f.samples[si];
          if (sp.pt && sp.pt >= endSec) {
            var mx = xOf(sp.t), my = yOf(sp.p);
            ctx.strokeStyle = sp.p > strike ? PAL.ok : sp.p < strike ? PAL.bad : PAL.ink;
            ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(mx, my, 6, 0, 7); ctx.stroke();
            ctx.font = "bold 9px 'Courier New',monospace"; ctx.textAlign = "center";
            ctx.fillStyle = PAL["ink-dim"]; ctx.fillText("settle tick", mx, my - 10);
            break;
          }
        }
      }
    }
  }
  function fmt(p) {
    if (p >= 10000) return p.toLocaleString("en-US", { maximumFractionDigits: 0 });
    if (p >= 100) return p.toFixed(1);
    if (p >= 1) return p.toFixed(3);
    return p.toFixed(5);
  }

  /* ---------- input ---------- */
  function zoneAt(x, y) {
    var splitX = W * SPLIT;
    if (x < splitX) return null;
    var f = S.feeds[S.asset], r = S.rounds[S.asset];
    if (!r || !f.samples.length) return null;
    var strike = strikeFor(r, f).p;
    var strikeY = Math.max(26, Math.min(H - 26, H - (strike - yScale.min) / (yScale.max - yScale.min) * H));
    return y < strikeY ? "up" : "down";
  }
  function evPos(e) { var rct = cv.getBoundingClientRect(); return { x: e.clientX - rct.left, y: e.clientY - rct.top }; }
  cv.addEventListener("pointerdown", function (e) { var p = evPos(e), z = zoneAt(p.x, p.y); if (z) { S.press = z; placeBet(z); } });
  cv.addEventListener("pointerup", function () { S.press = null; });
  cv.addEventListener("pointermove", function (e) {
    var p = evPos(e), z = zoneAt(p.x, p.y); S.hover = z;
    cv.style.cursor = z && S.rounds[S.asset] && S.rounds[S.asset].phase === "bet" ? "pointer" : "default";
  });
  cv.addEventListener("pointerleave", function () { S.hover = null; S.press = null; });

  /* ---------- tabs + chips ---------- */
  $("tabs").addEventListener("click", function (e) {
    var b = e.target.closest(".tab"); if (!b) return;
    S.asset = b.dataset.asset; yScale.init = false;
    var f = S.feeds[S.asset]; // snap the stale display price before this tab's first draw
    if (f && f.samples.length) f.disp = f.samples[f.samples.length - 1].p;
    document.querySelectorAll(".tab").forEach(function (t) { t.setAttribute("aria-pressed", t === b ? "true" : "false"); });
    renderHist();
  });
  document.querySelectorAll(".chip").forEach(function (c) {
    c.addEventListener("click", function () {
      S.stake = c.dataset.v === "max" ? "max" : parseInt(c.dataset.v, 10);
      localStorage.predict_stake = S.stake;
      document.querySelectorAll(".chip").forEach(function (x) { x.setAttribute("aria-pressed", x === c ? "true" : "false"); });
    });
    if (String(S.stake) === c.dataset.v) {
      document.querySelectorAll(".chip").forEach(function (x) { x.setAttribute("aria-pressed", "false"); });
      c.setAttribute("aria-pressed", "true");
    }
  });

  /* ---------- history strip ---------- */
  function renderHist() {
    var h = S.hist[S.asset];
    el.hist.innerHTML = h.length ? "" : "<span style='opacity:.6'>no rounds yet</span>";
    h.slice(0, 14).forEach(function (x) {
      var s = document.createElement("span");
      s.className = "hdot " + x.dir + (x.mine ? " mine" : "");
      s.textContent = x.dir === "up" ? "▲︎" : x.dir === "down" ? "▼︎" : "•";
      s.title = x.mine ? (x.mine + (x.delta ? " +" + x.delta : "")) : x.dir;
      el.hist.appendChild(s);
    });
  }

  /* ---------- hud ---------- */
  function updateHud(now) {
    var r = S.rounds[S.asset], f = S.feeds[S.asset];
    if (!f.samples.length) {
      el.phase.textContent = S.feedMode === "sim" ? "SIM FEED — WARMING UP" : "CONNECTING…";
      el.phase.className = "phase"; el.clock.textContent = "0:00"; el.rid.textContent = "ROUND #—";
    } else if (!r) {
      el.phase.textContent = PX.NET.live ? "WAITING FOR ROUND" : "MAINNET SOON";
      el.phase.className = "phase"; el.clock.textContent = "0:00"; el.rid.textContent = "ROUND #—";
    } else {
      var s = Math.ceil(Math.max(0, r.tEnd - now) / 1000);
      el.clock.textContent = r.phase === "roll" ? "—" : Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2);
      el.rid.textContent = "ROUND #" + r.n;
      if (r.phase === "roll") { el.phase.textContent = now - r.rollSince > 10000 ? "NO BETS — WAITING FOR NEXT ROUND" : "NO BETS — NEXT ROUND SOON"; el.phase.className = "phase"; }
      else if (r.phase === "bet" && now < r.tEnd) { el.phase.textContent = "PLACE YOUR BETS"; el.phase.className = "phase hot"; }
      else if (r.state === 2) { el.phase.textContent = r.voided ? "VOID — REFUND" : (r.upWon ? "UP WINS" : "DOWN WINS"); el.phase.className = "phase locked"; }
      else if (r.phase === "play" && now >= r.tEnd) { el.phase.textContent = "SETTLING…"; el.phase.className = "phase locked"; }
      else { var sk = strikeFor(r, f); el.phase.textContent = (sk.status === "locked" ? "LOCKED @ " : "LOCKING @ ~") + fmt(sk.p); el.phase.className = "phase locked"; }
    }
    var fresh = now - f.lastTick < 5000;
    el.led.className = "led" + ((fresh || S.feedMode === "sim") ? " on" : "");
    el.feedlbl.textContent = S.feedMode === "sim" ? "sim·feed" : "pyth·hermes";
    if (f.disp) el.px.textContent = FEEDS[S.asset].label + " " + fmt(f.disp);
  }

  /* ---------- main loop ---------- */
  var lastFrame = Date.now();
  function frame() {
    var now = Date.now(), dt = now - lastFrame; lastFrame = now;
    syntheticTick(now, dt);
    draw(now);
    updateHud(now);
    requestAnimationFrame(frame);
  }

  /* ---------- mainnet gate ---------- */
  function showComingSoon() {
    var d = document.createElement("div");
    d.style.cssText = "position:fixed;inset:0;background:rgba(6,11,22,.92);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;text-align:center;padding:24px;color:var(--ink)";
    d.innerHTML = "<div style='font-family:var(--comic);font-size:22px;color:var(--accent);margin-bottom:10px'>PREDICT.EXE — mainnet coming soon</div>" +
      "<div style='max-width:420px;line-height:1.5'>Live on <b>testnet</b> for now. Play with free points at " +
      "<a style='color:var(--accent-2)' href='https://predict.test.wenpoints.xyz/'>predict.test.wenpoints.xyz</a>.</div>";
    document.body.appendChild(d);
  }

  /* ---------- boot ---------- */
  resize();
  refreshConnectBtn();
  el.netbanner.style.display = "none";
  updateBalance();
  renderHist();
  connectFeed();
  // Adaptive poll cadence: idle rounds tick at POLL_MS, but near a lock/expiry boundary or
  // while a round awaits its on-chain settle, poll fast — the perceived "lag" at the finish
  // line is mostly waiting a full poll period to notice the keeper's tx already landed.
  function nextPollDelay() {
    var now = Date.now(), fast = false;
    assets.forEach(function (a) {
      var r = S.rounds[a];
      if (!r) return;
      if (Math.abs(now - r.lockTime) < 2500 || Math.abs(now - r.tEnd) < 2500) fast = true;
      if (r.phase === "play" && now >= r.tEnd) fast = true;   // awaiting settle
      if (r.phase === "roll") fast = true;                    // awaiting next round
    });
    return fast ? 300 : POLL_MS;
  }
  function pollLoop() { poll(); setTimeout(pollLoop, nextPollDelay()); }
  if (PX.NET.live) { PX.wallet.restore(); pollLoop(); }
  else { showComingSoon(); }
  requestAnimationFrame(frame);
})();
