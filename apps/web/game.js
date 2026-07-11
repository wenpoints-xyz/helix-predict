/* PREDICT.EXE — $HELIXPOINT price arcade (PredictionBook model).
   Zero dependencies. Live prices via Pyth Hermes SSE; each player opens their OWN position on-chain
   through PredictionBook (see chain.js -> window.PX). No shared rounds: you pick a duration, tap
   UP/DOWN, your strike locks in ~Δs later at a FIXED future instant, and after N seconds the keeper
   settles it against the Pyth price at exactly that instant — the price the chart already showed you.
   All timing is wall-clock (Date.now()) so the deterministic strike/close instants line up. */
(function () {
  "use strict";

  /* ---------- config ---------- */
  var FEEDS = {
    BTC: { id: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", label: "BTC/USD" },
    ETH: { id: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", label: "ETH/USD" },
    INJ: { id: "7a5bc1d2b56ad029048cd63964b3ad2776eadf812edc1a43a31406cb54bff592", label: "INJ/USD" }
  };
  var SPLIT = 0.75;          // chart divider (history:future = 3:1) at 75% width
  var POLL_MS = 1200, EXPO = -8;
  var CHIPS_MAX_CAP = 1000;
  var DURS = [15, 30, 60];   // selectable bet durations (s); clamped to book min/max once cfg loads

  /* ---------- state ---------- */
  var assets = Object.keys(FEEDS);
  var S = {
    asset: "BTC",
    stake: parseInt(localStorage.predict_stake || "25", 10) || 25,
    dur: parseInt(localStorage.predict_dur || "15", 10) || 15,
    bal: null, acct: null, cfg: null, markets: {},
    feeds: {}, active: {}, myBets: [], seen: {}, claiming: {}, pendingOpen: {}, provStrike: {}, finishT: {}, hist: {},
    pending: null, owedZero: {},
    muted: localStorage.predict_mute === "1",
    hover: null, press: null, flash: null,
    feedMode: "live", lastAnyTick: Date.now()
  };
  assets.forEach(function (a) { S.feeds[a] = { samples: [], disp: null, lastTick: 0 }; S.active[a] = null; S.hist[a] = []; });

  /* ---------- dom ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var cv = $("cv"), ctx = cv.getContext("2d");
  var wrap = $("chartwrap");
  var el = { rid: $("rid"), phase: $("phase"), clock: $("clock"), bal: $("bal"), hist: $("hist"),
             led: $("led"), px: $("px"), feedlbl: $("feedlbl"), getpts: $("getpts"),
             connect: $("connect"), netbanner: $("netbanner"), dur: $("durbtn"),
             pending: $("pending"), pendingMsg: $("pendingMsg"), pendingBtn: $("pendingBtn"),
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

  /* ---------- build stamp ---------- */
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
        if (p > 0) pushSample(a, p, false, Number(u.price.publish_time || 0)); // keep publish_time to match on-chain instants
      });
      retryMs = 1000; S.feedMode = "live"; S.lastAnyTick = Date.now();
    };
    es.onerror = function () { try { es.close(); } catch (e) {} scheduleRetry(); };
  }
  function scheduleRetry() { setTimeout(connectFeed, retryMs); retryMs = Math.min(retryMs * 2, 15000); }
  function pushSample(a, p, sim, pt) {
    var f = S.feeds[a], t = Date.now();
    if (!sim && f._hasSim) { f.samples = f.samples.filter(function (s) { return !s.sim; }); f._hasSim = false; }
    f.samples.push({ t: t, p: p, sim: !!sim, pt: pt || 0 }); f.lastTick = t;
    if (sim) f._hasSim = true;
    var cutoff = t - 180000; // widest bet (60s) + arming + settle slack
    while (f.samples.length && f.samples[0].t < cutoff) f.samples.shift();
    if (f.disp === null) f.disp = p;
  }
  function syntheticTick(now, dt) {
    if (S.feedMode === "live" && now - S.lastAnyTick < 8000) return;
    S.feedMode = "sim";
    assets.forEach(function (a) {
      var f = S.feeds[a];
      if (!f.samples.length) return;
      var last = f.samples[f.samples.length - 1].p;
      f._accum = (f._accum || 0) + dt;
      if (f._accum > 400) { f._accum = 0; pushSample(a, last * (1 + (Math.random() - 0.5) * 0.0008), true); }
    });
  }

  /* =========================================================================
     ON-CHAIN binding: markets + config once; poll the user's positions.
     A "view" derives a position's phase from wall-clock + the deterministic instants:
       now < strikeInstant           -> "arming"  (strike locks in soon; commit is blind)
       strikeInstant..+dur           -> "live"    (entry strike known from the stream; sweat it)
       >= strikeInstant+dur, Open     -> "settling"(keeper about to settle at the fixed instant)
       result != Open                 -> "done"    (win/loss/void)
     ========================================================================= */
  function mult() { return S.cfg ? PX.payout(S.cfg.payoutBps) : 1.95; }

  // The entry strike = first streamed Pyth tick whose publish_time >= strikeInstant (== the contract's
  // Unique read). Deterministic, so the chart shows the EXACT price the contract will settle against.
  function tickAtOrAfter(f, sec) {
    for (var i = 0; i < f.samples.length; i++) if (f.samples[i].pt && f.samples[i].pt >= sec) return f.samples[i].p;
    return null;
  }
  // The exact strike is the first Pyth tick with publish_time >= strikeInstant, but Hermes lags
  // wall-clock ~1-2s so that tick hasn't streamed in yet at lock time. We show the on-screen price
  // provisionally and GLIDE it onto the exact value once the tick lands (easeStrikes) — no jump.
  // Status stays "locking" until the glide has settled onto the confirmed value, then "locked".
  function strikeOf(pos, f, now) {
    if (pos.strike) return { p: Number(pos.strike) * Math.pow(10, EXPO), status: "locked" }; // on-chain (set at settle)
    if (now / 1000 < pos.strikeInstant) return { p: null, status: "arming" };
    var shown = S.provStrike[pos.betId];
    if (shown == null) shown = f.disp; // just crossed; easeStrikes seeds/glides it from next frame
    var confirmed = tickAtOrAfter(f, pos.strikeInstant);
    var locked = confirmed != null && Math.abs(shown - confirmed) < confirmed * 1e-5;
    return { p: shown, status: locked ? "locked" : "locking" };
  }
  // Once per frame: glide each locking position's shown strike toward its exact deterministic value.
  function easeStrikes(now) {
    assets.forEach(function (a) {
      var pos = S.active[a], f = S.feeds[a];
      if (!pos || pos.strike || now / 1000 < pos.strikeInstant) return;
      var cur = S.provStrike[pos.betId];
      if (cur == null) cur = f.samples.length ? f.samples[f.samples.length - 1].p : f.disp; // start at the on-screen price
      var confirmed = tickAtOrAfter(f, pos.strikeInstant);
      if (confirmed != null) cur = Math.abs(confirmed - cur) < confirmed * 3e-6 ? confirmed : cur + (confirmed - cur) * 0.16;
      S.provStrike[pos.betId] = cur;
    });
  }
  function viewOf(pos, f, now) {
    var nowS = now / 1000;
    var closeInstant = pos.strikeInstant + pos.dur;
    var v = {
      betId: pos.betId, up: pos.up, dur: pos.dur, result: pos.result,
      strikeInstantMs: pos.strikeInstant * 1000, closeInstantMs: closeInstant * 1000,
      tfMs: pos.dur * 1000, mult: mult()
    };
    if (pos.result !== PX.RESULT.OPEN) { v.phase = "done"; }
    else if (nowS < pos.strikeInstant) { v.phase = "arming"; }
    else if (nowS < closeInstant) { v.phase = "live"; }
    else { v.phase = "settling"; }
    var sk = strikeOf(pos, f, now);
    v.strike = sk.p; v.strikeStatus = sk.status;
    return v;
  }
  function activeView(asset, now) {
    var pos = S.active[asset], f = S.feeds[asset];
    if (!pos) return null;
    return viewOf(pos, f, now);
  }

  function loadMeta() {
    var need = [];
    if (!Object.keys(S.markets).length) need.push(PX.markets().then(function (ms) {
      var by = {};
      ms.forEach(function (m) { by[m.feedId.replace(/^0x/, "").toLowerCase()] = m; });
      assets.forEach(function (a) { var m = by[FEEDS[a].id.toLowerCase()]; if (m && m.enabled) S.markets[a] = m.marketId; });
    }).catch(function () {}));
    if (!S.cfg) need.push(PX.bookConfig().then(function (c) {
      S.cfg = c;
      DURS = DURS.filter(function (d) { return d >= c.minDur && d <= c.maxDur; });
      if (!DURS.length) DURS = [Math.max(c.minDur, Math.min(c.maxDur, 15))];
      if (DURS.indexOf(S.dur) === -1) { S.dur = DURS[0]; }
      renderDur();
    }).catch(function () {}));
    return Promise.all(need);
  }

  function poll() {
    if (!PX.NET.live || !PX.NET.book) return;
    loadMeta().then(function () {
      if (!S.acct) return;
      return PX.myPositions(S.acct, 40).then(function (r) {
        S.myBets = r.positions;
        var newestOpen = {};
        r.positions.forEach(function (p) {
          var a = assetOf(p.marketId);
          if (!a) return;
          if (p.result === PX.RESULT.OPEN) {
            if (!newestOpen[a] || p.betId > newestOpen[a].betId) newestOpen[a] = p;
            if (S.pendingOpen[a] && p.betId >= (S.pendingOpen[a].minId || 0)) delete S.pendingOpen[a];
          } else if (!S.seen[p.betId]) {
            recordResult(a, p);
          }
        });
        assets.forEach(function (a) { S.active[a] = newestOpen[a] || null; });
        computePending();
      });
    }).catch(function () {}).then(function () { if (S.acct) refreshBalance(); refreshLp(); });
  }

  /* ---------- pending / hanging bets (settling, stuck, unclaimed) ---------- */
  // Surfaces bets that need attention even if you lost connection or the keeper is behind:
  //   • matured + Open           -> "settling" (the keeper is on it; usually seconds)
  //   • matured + Open past grace -> "stuck"    -> REFUND (voidExpired, no oracle needed)
  //   • settled Win/Void, owed>0  -> "unclaimed" -> CLAIM  (a failed/rejected auto-claim landed here)
  function computePending() {
    var now = Date.now(), grace = (S.cfg && S.cfg.settleGrace ? S.cfg.settleGrace : 3600) * 1000;
    var settling = 0, refundable = [], winVoid = [];
    S.myBets.forEach(function (p) {
      var closeMs = (p.strikeInstant + p.dur) * 1000;
      if (p.result === PX.RESULT.OPEN) {
        if (now >= closeMs + grace) refundable.push(p.betId);
        else if (now >= closeMs) settling++;
      } else if (p.result === PX.RESULT.WIN || p.result === PX.RESULT.VOID) {
        winVoid.push(p.betId); // owed>0 only if a claim never landed
      }
    });
    // read owed only for a bounded set of recent settled Win/Void bets (usually 0 after auto-claim)
    var check = winVoid.slice(0, 12).filter(function (id) { return !S.owedZero[id]; });
    Promise.all(check.map(function (id) {
      return PX.owed(id).then(function (w) { if (w <= 0n) S.owedZero[id] = true; return { id: id, owed: w }; }).catch(function () { return { id: id, owed: 0n }; });
    })).then(function (res) {
      var unclaimed = res.filter(function (x) { return x.owed > 0n; });
      var total = unclaimed.reduce(function (s, x) { return s + x.owed; }, 0n);
      S.pending = { settling: settling, refundable: refundable, unclaimed: unclaimed.map(function (x) { return x.id; }), unclaimedTotal: total };
      renderPending();
    });
  }
  function renderPending() {
    var pg = S.pending || {}, msg = "", btn = null, act = null;
    if (pg.unclaimedTotal && pg.unclaimedTotal > 0n) {
      msg = "🏆 " + Math.floor(PX.toChips(pg.unclaimedTotal)).toLocaleString("en-US") + " pts ready to claim";
      btn = "CLAIM"; act = "claim";
    } else if (pg.refundable && pg.refundable.length) {
      msg = "⚠ " + pg.refundable.length + " stuck bet" + (pg.refundable.length > 1 ? "s" : "") + " — settlement lapsed";
      btn = "REFUND"; act = "refund";
    } else if (pg.settling) {
      msg = "⏳ " + pg.settling + " bet" + (pg.settling > 1 ? "s" : "") + " settling…";
    }
    if (!msg || !S.acct) { el.pending.style.display = "none"; return; }
    el.pending.style.display = "flex";
    el.pendingMsg.textContent = msg;
    el.pending.style.borderColor = act === "refund" ? PAL.bad : PAL.accent;
    if (btn) { el.pendingBtn.hidden = false; el.pendingBtn.textContent = btn; el.pendingBtn.dataset.act = act; }
    else el.pendingBtn.hidden = true;
  }
  el.pendingBtn.onclick = function () {
    if (!S.acct) return;
    var pg = S.pending || {}, act = el.pendingBtn.dataset.act;
    var ids = act === "claim" ? (pg.unclaimed || []) : act === "refund" ? (pg.refundable || []) : [];
    if (!ids.length) return;
    var fn = act === "claim" ? PX.claim : PX.voidExpired;
    el.pendingBtn.hidden = true; // debounce
    toast(act === "claim" ? "Claiming — confirm in wallet." : "Refunding stuck bet — confirm in wallet.");
    // fire them sequentially-ish; each is its own wallet confirm
    ids.reduce(function (chain, id) {
      return chain.then(function () { return fn(PX.wallet.provider, S.acct, id).catch(function () {}); });
    }, Promise.resolve()).then(function () { setTimeout(poll, 2500); }).catch(function (e) { toast(txErr(e, "Failed — try again.")); });
  };
  function assetOf(marketId) {
    for (var a in S.markets) if (S.markets[a] === marketId) return a;
    return null;
  }
  function recordResult(a, pos) {
    S.seen[pos.betId] = true;
    delete S.provStrike[pos.betId];
    delete S.finishT[pos.betId];
    var res = pos.result; // 1 win, 2 loss, 3 void
    var priceDir = res === PX.RESULT.VOID ? "tie" : (pos.up === (res === PX.RESULT.WIN) ? "up" : "down");
    var mine = res === PX.RESULT.WIN ? "win" : res === PX.RESULT.VOID ? "tie" : "lose";
    // claim winnings / void refunds
    if (res === PX.RESULT.WIN || res === PX.RESULT.VOID) maybeClaim(pos.betId);
    var stake = PX.toChips(pos.stake), delta = res === PX.RESULT.WIN ? stake * mult() : res === PX.RESULT.VOID ? stake : 0;
    S.hist[a].unshift({ dir: priceDir, mine: mine, delta: Math.floor(delta) });
    S.hist[a] = S.hist[a].slice(0, 16);
    if (a === S.asset) {
      S.flash = { t0: Date.now(), dir: priceDir, mine: mine };
      if (mine === "win") { beep(660, 90); setTimeout(function () { beep(990, 140); }, 90); flyPoints("+" + Math.floor(delta), PAL.ok, priceDir); }
      else if (mine === "lose") { beep(120, 180, "sawtooth", 0.05); flyPoints("rekt", PAL.bad, priceDir); }
      else { flyPoints("push · refund", PAL["ink-dim"], "up"); }
      renderHist();
    }
  }
  function maybeClaim(betId) {
    if (!S.acct || S.claiming[betId]) return;
    PX.owed(betId).then(function (w) {
      if (w <= 0n || S.claiming[betId]) return;
      S.claiming[betId] = true;
      PX.claim(PX.wallet.provider, S.acct, betId).then(function () { setTimeout(poll, 2500); }).catch(function () { delete S.claiming[betId]; });
    }).catch(function () {});
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
      b.className = "getpts"; b.style.cssText = "display:flex;align-items:center;gap:8px;width:100%;text-align:left;margin:4px 0";
      if (w.icon) { var im = document.createElement("img"); im.src = w.icon; im.width = 18; im.height = 18; im.alt = ""; b.appendChild(im); }
      b.appendChild(document.createTextNode(w.name));
      b.onclick = function () { document.body.removeChild(ov); doConnect(w.provider); };
      box.appendChild(b);
    });
    ov.appendChild(box);
    ov.onclick = function (e) { if (e.target === ov) document.body.removeChild(ov); };
    document.body.appendChild(ov);
  }
  el.connect.onclick = function () { if (S.acct) PX.wallet.disconnect(); else openWallet(); };
  function checkNet() {
    if (!S.acct) { el.netbanner.style.display = "none"; return; }
    PX.wallet.currentChain().then(function (cid) { el.netbanner.style.display = (cid === PX.NET.chainIdHex) ? "none" : "block"; });
  }
  el.netbanner.onclick = function () { if (PX.wallet.provider) PX.wallet.ensureNetwork(PX.wallet.provider).then(checkNet); };
  var gasWarnedFor = null;
  function checkGas() {
    if (!S.acct || S.acct === gasWarnedFor || !PX.NET.live) return;
    gasWarnedFor = S.acct;
    PX.nativeBalance(S.acct).then(function (w) {
      if (w < 1000000000000000n) toast("Low on INJ gas — every tx needs a little INJ. Get it free at faucet.injective.network.");
    }).catch(function () {});
  }
  PX.wallet.onChange(function (w) {
    S.acct = w.account; refreshConnectBtn(); checkNet();
    if (S.acct) { poll(); checkGas(); } else { S.bal = null; S.myBets = []; S.pending = null; assets.forEach(function (a) { S.active[a] = null; }); updateBalance(); if (el.pending) el.pending.style.display = "none"; }
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
  function txErr(e, fallback) {
    if (e && e.code === 4001) return "Cancelled.";
    var m = ((e && (e.message || (e.data && e.data.message) || (e.error && e.error.message))) || "").toLowerCase();
    if (m.indexOf("insufficient funds") !== -1 || m.indexOf("sender balance") !== -1 || m.indexOf("gas required") !== -1)
      return "No gas — you need testnet INJ. Get it free at faucet.injective.network, then retry.";
    return fallback;
  }

  /* ---------- betting (open a position) ---------- */
  function stakeValue() { return S.stake === "max" ? Math.max(0, Math.min(S.bal || 0, CHIPS_MAX_CAP)) : S.stake; }
  function placeBet(side) {
    if (!S.acct) { openWallet(); return; }
    var mid = S.markets[S.asset];
    if (mid == null) { toast("Market not ready yet."); beep(160, 40, "sawtooth"); return; }
    var chips = stakeValue();
    if (chips <= 0) { beep(160, 60, "sawtooth"); return; }
    if (S.cfg && chips < PX.toChips(S.cfg.minBet)) { toast("Min bet is " + Math.ceil(PX.toChips(S.cfg.minBet)) + " pts."); beep(160, 60, "sawtooth"); return; }
    if (S.bal != null && S.bal < chips) { el.getpts.hidden = false; beep(160, 60, "sawtooth"); toast("Not enough points — hit the faucet."); return; }
    var amt = PX.chipsToWei(chips), prov = PX.wallet.provider, from = S.acct, up = side === "up", dur = S.dur;
    beep(600, 30); if (navigator.vibrate) navigator.vibrate(12);
    S.pendingOpen[S.asset] = { t: Date.now(), minId: (S.myBets[0] ? S.myBets[0].betId : 0) + 1 };
    ensureAllowance(from, amt)
      .then(function () { return PX.openBet(prov, from, mid, up, amt, dur); })
      .then(function () { flyPoints("bet " + chips, PAL.accent, side); setTimeout(poll, 1500); })
      .catch(function (e) { delete S.pendingOpen[S.asset]; toast(txErr(e, "Bet failed.")); });
  }
  function ensureAllowance(from, amt) {
    return PX.allowance(from, PX.NET.book).then(function (a) {
      if (a >= amt) return;
      toast("One-time approve — confirm in wallet.");
      return PX.approve(PX.wallet.provider, from, PX.NET.book, (1n << 256n) - 1n).then(function () { return waitAllowance(from, amt); });
    });
  }
  function waitAllowance(from, amt) {
    return new Promise(function (res, rej) {
      var tries = 0;
      (function loop() {
        PX.allowance(from, PX.NET.book).then(function (a) {
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

  /* ---------- duration selector ---------- */
  function renderDur() { if (el.dur) el.dur.textContent = S.dur + "s"; }
  if (el.dur) el.dur.onclick = function () {
    var i = DURS.indexOf(S.dur); S.dur = DURS[(i + 1) % DURS.length]; localStorage.predict_dur = S.dur; renderDur(); beep(500, 25);
  };
  renderDur();

  /* ---------- LP vault: "be the house" ---------- */
  var lpShown = false;
  el.lp.style.display = "none";
  el.lpToggle.onclick = function () {
    lpShown = !lpShown;
    el.lp.style.display = lpShown ? "flex" : "none";
    el.lpToggle.textContent = (lpShown ? "▾" : "▸") + " BE THE HOUSE";
    if (lpShown) refreshLp();
  };
  function refreshLp() {
    if (!PX.NET.live || !lpShown || !PX.NET.book) return;
    PX.houseStats().then(function (s) {
      el.lpBank.textContent = Math.floor(PX.toChips(s.bankroll)).toLocaleString("en-US");
      var util = s.bankroll > 0n ? Number(s.reserved * 10000n / s.bankroll) / 100 : 0;
      el.lpUtil.textContent = util.toFixed(1) + "%";
      if (S.acct) {
        PX.vaultShares(S.acct).then(function (sh) {
          var assetsW = sh * s.sharePrice / (10n ** 18n);
          el.lpMine.textContent = Math.floor(PX.toChips(assetsW)).toLocaleString("en-US");
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
    var f = S.feeds[S.asset];
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var splitX = Math.round(W * SPLIT);

    if (!f.samples.length) {
      ctx.fillStyle = PAL["ink-dim"]; ctx.font = "bold 14px 'Courier New',monospace"; ctx.textAlign = "center";
      ctx.fillText("dialing up the price feed…", W / 2, H / 2);
      return;
    }
    var last = f.samples[f.samples.length - 1].p;
    if (Math.abs(last - f.disp) > last * 0.002) f.disp = last;
    else f.disp += (last - f.disp) * 0.18;

    var v = activeView(S.asset, now);
    var running = v && (v.phase === "arming" || v.phase === "live" || v.phase === "settling");
    var ready = !running; // no active bet on this asset -> tap to open one
    // The split line sits at the entry strike once it's known, else at the live price (preview).
    var splitPrice = (v && v.strike != null) ? v.strike : f.disp;

    // time window: future = the bet's duration; during a running bet pin the right edge to close
    var futMs = (v && v.tfMs) || S.dur * 1000, histMs = 3 * futMs;
    var rightT = (v && (v.phase === "live" || v.phase === "settling")) ? Math.max(v.closeInstantMs, now) : now + futMs;
    var t1 = rightT, t0 = t1 - (histMs + futMs);
    var xOf = function (t) { return (t - t0) / (t1 - t0) * W; };

    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < f.samples.length; i++) { var sm = f.samples[i]; if (sm.t < t0) continue; if (sm.p < lo) lo = sm.p; if (sm.p > hi) hi = sm.p; }
    if (splitPrice < lo) lo = splitPrice; if (splitPrice > hi) hi = splitPrice;
    var pad = Math.max((hi - lo) * 0.35, splitPrice * 0.0004);
    var tMin = lo - pad, tMax = hi + pad;
    if (!yScale.init) { yScale.min = tMin; yScale.max = tMax; yScale.init = true; }
    yScale.min += (tMin - yScale.min) * 0.1; yScale.max += (tMax - yScale.max) * 0.1;
    var yOf = function (p) { return H - (p - yScale.min) / (yScale.max - yScale.min) * H; };
    var strikeY = Math.max(26, Math.min(H - 26, yOf(splitPrice)));

    // zones (up above the line, down below); interactive when ready to bet
    var zones = [{ side: "up", y0: 0, y1: strikeY, col: PAL.ok }, { side: "down", y0: strikeY, y1: H, col: PAL.bad }];
    zones.forEach(function (z) {
      var alpha = 0.10;
      if (ready && S.hover === z.side) alpha = 0.17;
      if (ready && S.press === z.side) alpha = 0.26;
      if (v && v.up === (z.side === "up")) alpha += 0.05; // your active side glows
      ctx.globalAlpha = alpha; ctx.fillStyle = z.col; ctx.fillRect(splitX, z.y0, W - splitX, z.y1 - z.y0); ctx.globalAlpha = 1;
    });
    if (S.flash && now - S.flash.t0 < 650 && S.flash.dir !== "tie") {
      var k = 1 - (now - S.flash.t0) / 650;
      ctx.globalAlpha = 0.35 * k; ctx.fillStyle = S.flash.dir === "up" ? PAL.ok : PAL.bad;
      var zy = S.flash.dir === "up" ? [0, strikeY] : [strikeY, H];
      ctx.fillRect(splitX, zy[0], W - splitX, zy[1] - zy[0]); ctx.globalAlpha = 1;
    }

    // gridlines
    ctx.strokeStyle = PAL["ink-dim"]; ctx.globalAlpha = 0.18; ctx.lineWidth = 1;
    ctx.font = "10px 'Courier New',monospace"; ctx.textAlign = "left";
    for (var g = 1; g <= 3; g++) { var gy = H * g / 4; ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }
    ctx.globalAlpha = 0.55; ctx.fillStyle = PAL["ink-dim"];
    for (g = 1; g <= 3; g++) { var gp = yScale.max - (yScale.max - yScale.min) * g / 4; ctx.fillText(fmt(gp), 4, H * g / 4 - 3); }
    ctx.globalAlpha = 1;

    // split divider
    ctx.strokeStyle = PAL["ink-dim"]; ctx.globalAlpha = 0.4; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(splitX, 0); ctx.lineTo(splitX, H); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;

    // strike / preview line: solid ONLY once the strike has locked onto its exact value; dashed while
    // previewing, arming, or still gliding to lock — so the line settles in smoothly, no snap.
    var locked = v && v.strikeStatus === "locked";
    var locking = v && (v.strikeStatus === "arming" || v.strikeStatus === "locking");
    ctx.strokeStyle = PAL.accent; ctx.lineWidth = locked ? 2 : 1.5;
    if (!locked) ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(0, strikeY); ctx.lineTo(W, strikeY); ctx.stroke(); ctx.setLineDash([]);
    // hold the price out of the tag until it's exact — avoids showing a number that then jumps
    var tag = locking ? "LOCKING…" : "@ " + fmt(splitPrice);
    ctx.font = "bold 11px 'Courier New',monospace";
    var tw = ctx.measureText(tag).width + 10;
    ctx.fillStyle = PAL.accent; ctx.fillRect(splitX - tw - 4, strikeY - 9, tw, 18);
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.fillText(tag, splitX - tw / 2 - 4, strikeY + 4);

    // price line + head dot
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

    // live price readout riding the dot during a running bet: ▲ green above strike / ▼ red below
    if (v && (v.phase === "live" || v.phase === "settling") && v.strike != null) {
      var live = f.disp, strike = v.strike;
      var col = live > strike ? PAL.ok : live < strike ? PAL.bad : PAL["ink-dim"];
      var arrow = live > strike ? "▲" : live < strike ? "▼" : "•";
      var txt = arrow + " " + fmt(live);
      var rx = Math.min(headX - 8, W - 4);
      var ry = Math.max(16, Math.min(H - 6, live > strike ? headY - 12 : headY + 20));
      ctx.font = "bold 13px 'Courier New',monospace"; ctx.textAlign = "right";
      ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.strokeStyle = PAL["panel-2"];
      ctx.strokeText(txt, rx, ry);
      ctx.fillStyle = col; ctx.fillText(txt, rx, ry);
    }

    // zone labels: fixed odds + your active stake / win preview
    var zx = splitX + (W - splitX) / 2;
    zones.forEach(function (z) {
      var mid = (z.y0 + z.y1) / 2, m = mult();
      ctx.fillStyle = z.col; ctx.font = "bold 13px " + COMIC_CANVAS;
      var label = z.side === "up" ? "UP" : "DOWN";
      var lw = ctx.measureText(label).width;
      ctx.textAlign = "left"; ctx.fillText(label, zx - lw / 2 + 6, mid - 22);
      var ax = zx - lw / 2 - 5, ay = mid - 26;
      ctx.beginPath();
      if (z.side === "up") { ctx.moveTo(ax - 6, ay + 4); ctx.lineTo(ax + 6, ay + 4); ctx.lineTo(ax, ay - 5); }
      else { ctx.moveTo(ax - 6, ay - 5); ctx.lineTo(ax + 6, ay - 5); ctx.lineTo(ax, ay + 4); }
      ctx.closePath(); ctx.fill();
      ctx.textAlign = "center"; ctx.font = "bold 24px 'Courier New',monospace";
      ctx.fillText("×" + m.toFixed(2), zx, mid + 2);
      ctx.font = "11px 'Courier New',monospace"; ctx.fillStyle = PAL.ink;
      var val = stakeValue();
      if (ready && val > 0) ctx.fillText("win " + Math.floor(val * m) + " pts", zx, mid + 18);
      if (v && v.up === (z.side === "up")) { ctx.fillStyle = z.col; ctx.fillText("YOUR BET", zx, mid + 18 + (ready ? 14 : 0)); }
    });
    ctx.font = "bold 10px 'Courier New',monospace"; ctx.textAlign = "center";
    ctx.fillStyle = ready ? PAL.ok : PAL.bad;
    ctx.fillText(ready ? ">> TAP TO BET · " + S.dur + "s <<" : (v.phase === "arming" ? "STRIKE LOCKING IN" : "SWEAT IT"), zx, 12);

    // finish line during a running bet. The settle price is the first tick at/after closeInstant, but
    // Hermes lag means that tick lands on the chart ~1s to the RIGHT of the raw close instant. So the
    // line glides to sit exactly on that settle tick once it exists — the dashed line and the ringed
    // close tick coincide instead of drifting apart.
    if (v && (v.phase === "live" || v.phase === "settling")) {
      var closeTick = null;
      if (now >= v.closeInstantMs) {
        var closeSec = v.closeInstantMs / 1000;
        for (var si = 0; si < f.samples.length; si++) {
          if (f.samples[si].pt && f.samples[si].pt >= closeSec) { closeTick = f.samples[si]; break; }
        }
      }
      var targetT = closeTick ? closeTick.t : v.closeInstantMs; // align to the settle tick's arrival
      if (S.finishT[v.betId] == null) S.finishT[v.betId] = v.closeInstantMs;
      S.finishT[v.betId] += (targetT - S.finishT[v.betId]) * 0.2; // glide, don't snap
      var fx = Math.min(xOf(S.finishT[v.betId]), W - 1);
      ctx.strokeStyle = PAL.ink; ctx.globalAlpha = 0.5; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(fx, 0); ctx.lineTo(fx, H); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      if (closeTick) {
        var mx = xOf(closeTick.t), my = yOf(closeTick.p), strk = v.strike;
        ctx.strokeStyle = strk != null && closeTick.p > strk ? PAL.ok : strk != null && closeTick.p < strk ? PAL.bad : PAL.ink;
        ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(mx, my, 6, 0, 7); ctx.stroke();
        ctx.font = "bold 9px 'Courier New',monospace"; ctx.textAlign = "center";
        ctx.fillStyle = PAL["ink-dim"]; ctx.fillText("close", mx, my - 10);
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
    var f = S.feeds[S.asset];
    if (!f.samples.length) return null;
    var v = activeView(S.asset, Date.now());
    var splitPrice = (v && v.strike != null) ? v.strike : f.disp;
    var strikeY = Math.max(26, Math.min(H - 26, H - (splitPrice - yScale.min) / (yScale.max - yScale.min) * H));
    return y < strikeY ? "up" : "down";
  }
  function evPos(e) { var rct = cv.getBoundingClientRect(); return { x: e.clientX - rct.left, y: e.clientY - rct.top }; }
  cv.addEventListener("pointerdown", function (e) { var p = evPos(e), z = zoneAt(p.x, p.y); if (z) { S.press = z; placeBet(z); } });
  cv.addEventListener("pointerup", function () { S.press = null; });
  cv.addEventListener("pointermove", function (e) {
    var p = evPos(e), z = zoneAt(p.x, p.y); S.hover = z;
    cv.style.cursor = z ? "pointer" : "default";
  });
  cv.addEventListener("pointerleave", function () { S.hover = null; S.press = null; });

  /* ---------- tabs + chips ---------- */
  $("tabs").addEventListener("click", function (e) {
    var b = e.target.closest(".tab"); if (!b) return;
    S.asset = b.dataset.asset; yScale.init = false;
    var f = S.feeds[S.asset];
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
    el.hist.innerHTML = h.length ? "" : "<span style='opacity:.6'>no bets yet</span>";
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
    var v = activeView(S.asset, now), f = S.feeds[S.asset];
    if (!f.samples.length) {
      el.phase.textContent = S.feedMode === "sim" ? "SIM FEED — WARMING UP" : "CONNECTING…";
      el.phase.className = "phase"; el.clock.textContent = "0:00"; el.rid.textContent = "BET #—";
    } else if (!PX.NET.live || !PX.NET.book) {
      el.phase.textContent = "MAINNET SOON"; el.phase.className = "phase"; el.clock.textContent = "0:00"; el.rid.textContent = "BET #—";
    } else if (!v) {
      el.phase.textContent = "TAP UP OR DOWN"; el.phase.className = "phase hot";
      el.clock.textContent = S.dur + "s"; el.rid.textContent = "BET #—";
    } else {
      el.rid.textContent = "BET #" + v.betId;
      if (v.phase === "arming") {
        var sa = Math.ceil(Math.max(0, v.strikeInstantMs - now) / 1000);
        el.phase.textContent = "STRIKE LOCKS IN"; el.phase.className = "phase hot"; el.clock.textContent = "0:0" + Math.min(9, sa);
      } else if (v.phase === "live") {
        var sc = Math.ceil(Math.max(0, v.closeInstantMs - now) / 1000);
        if (v.strikeStatus !== "locked") {
          el.phase.textContent = "LOCKING…"; el.phase.className = "phase hot"; // strike still gliding to its exact value
        } else {
          var lead = f.disp > v.strike ? "▲ AHEAD" : f.disp < v.strike ? "▼ BEHIND" : "EVEN";
          el.phase.textContent = lead + " @ " + fmt(v.strike); el.phase.className = "phase locked";
        }
        el.clock.textContent = Math.floor(sc / 60) + ":" + ("0" + (sc % 60)).slice(-2);
      } else if (v.phase === "settling") {
        el.phase.textContent = "SETTLING…"; el.phase.className = "phase locked"; el.clock.textContent = "0:00";
      }
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
    easeStrikes(now);
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
  // Poll faster while a bet is arming or about to settle (the moments state changes on-chain).
  function nextPollDelay() {
    var now = Date.now(), fast = false;
    assets.forEach(function (a) {
      var v = activeView(a, now);
      if (!v) return;
      if (v.phase === "arming" || v.phase === "settling") fast = true;
      if (v.phase === "live" && v.closeInstantMs - now < 2500) fast = true;
    });
    return fast ? 400 : POLL_MS;
  }
  function pollLoop() { poll(); setTimeout(pollLoop, nextPollDelay()); }
  if (PX.NET.live && PX.NET.book) { PX.wallet.restore(); pollLoop(); }
  else { showComingSoon(); }
  requestAnimationFrame(frame);
})();
