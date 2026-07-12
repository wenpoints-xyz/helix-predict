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
    pending: null, owedZero: {}, statsBets: null, statWin: 3, house: null, auto: null,
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
             connect: $("connect"), netbanner: $("netbanner"), dur: $("durbtn"), histbtn: $("histbtn"), statsbtn: $("statsbtn"), autobtn: $("autobtn"),
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
    }).catch(function () {}).then(function () {
      if (S.acct) refreshBalance();
      refreshLp();
      refreshAuto(); // keep the ⚡ button + auto-bet gating in sync with the on-chain grant
      PX.houseStats().then(function (h) { S.house = h; }).catch(function () {}); // cache bankroll for the MAX chip clamp
    });
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
      if (w < 1000000000000000n) toast(HAS_FAUCET ? "Low on INJ gas — get it free at faucet.injective.network." : "Low on INJ gas — every tx needs a little INJ.");
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
  // Wallets bury a reverting contract's custom error as a 4-byte selector somewhere in the error
  // payload (data / info.error.data / message), not as a readable string. Map every user-reachable
  // revert to plain language by matching its selector. Selectors from PredictionBook + HouseVault +
  // OZ Pausable/ERC20/ERC4626 (keccak(sig)[0:4]); keep in sync if the contract's errors change.
  var ERRMAP = {
    "0xd312a688": "That's below the minimum bet.",
    "0x217b2dd1": "That's over the max bet — try a smaller stake.",
    "0x59a5f145": "You've got too many open bets — settle some first.",
    "0x843e7985": "Too big for the house right now — try a smaller stake.",
    "0x137b0798": "The house is full right now — try a smaller stake, or again in a bit.",
    "0xbb113ce1": "The house can't cover that right now — smaller stake, or add LP.",
    "0x1f2a2005": "Enter an amount first.",
    "0x52a422f7": "This market is paused.",
    "0xac8a2f48": "That market isn't available.",
    "0x4d84c2e9": "Pick a valid duration.",
    "0xddafad98": "This bet was already settled.",
    "0x111c4409": "Not ready to settle yet — give it a few seconds.",
    "0x3937f51f": "Can't refund yet — the settlement grace hasn't passed.",
    "0x025dbdd4": "Oracle fee too low — try again.",
    "0x969bf728": "Nothing to claim here.",
    "0xd93c0665": "Betting is paused right now.",
    "0xe450d38c": "Not enough points for that.",
    "0xfb8f41b2": "Approve points first, then retry.",
    "0xfe9cceec": "Can't withdraw that much — capital is backing open bets.",
    "0xb94abeec": "Can't withdraw that much — capital is backing open bets."
  };
  // Recursively collect every string anywhere in the error object — wallets bury the revert selector
  // at wildly different depths (e.data / data.data / data.originalError.data / info.error.data / cause…),
  // and Error instances don't JSON.stringify their message/data. Walk the whole thing and match later.
  function errBlob(e) {
    var out = [], seen = [];
    (function walk(o, d) {
      if (o == null || d > 6) return;
      if (typeof o === "string") { out.push(o); return; }
      if (typeof o !== "object") return;
      if (seen.indexOf(o) !== -1) return; seen.push(o);
      if (typeof o.message === "string") out.push(o.message); // non-enumerable on Error
      for (var k in o) { try { walk(o[k], d + 1); } catch (_) {} }
    })(e, 0);
    return out.join(" ").toLowerCase();
  }
  function txErr(e, fallback) {
    if (e && e.code === 4001) return "Cancelled.";
    var s = errBlob(e);
    for (var sel in ERRMAP) if (s.indexOf(sel) !== -1) return ERRMAP[sel];
    if (s.indexOf("insufficient funds") !== -1 || s.indexOf("sender balance") !== -1 || s.indexOf("gas required") !== -1)
      return HAS_FAUCET ? "No gas — get testnet INJ free at faucet.injective.network, then retry." : "No gas — you need a little INJ for fees, then retry.";
    return fallback;
  }

  /* ---------- betting (open a position) ---------- */
  // MAX = your balance, capped by the contract's maxBet (so it never opens a doomed over-cap bet).
  // MAX = the largest you can actually bet: the lower of your balance, the absolute maxBet, AND the
  // biggest bet the house will currently accept (its per-bet exposure cap on the live bankroll).
  function stakeValue() {
    if (S.stake !== "max") return S.stake;
    var cap = S.cfg && S.cfg.maxBet ? PX.toChips(S.cfg.maxBet) : CHIPS_MAX_CAP;
    if (S.house && S.cfg && S.cfg.maxBetExposureBps && S.cfg.payoutBps > 10000) {
      var houseMax = PX.toChips(S.house.bankroll) * S.cfg.maxBetExposureBps / (S.cfg.payoutBps - 10000);
      if (houseMax < cap) cap = houseMax;
    }
    return Math.max(0, Math.floor(Math.min(S.bal || 0, cap)));
  }
  function placeBet(side) {
    if (!S.acct) { openWallet(); return; }
    var mid = S.markets[S.asset];
    if (mid == null) { toast("Market not ready yet."); beep(160, 40, "sawtooth"); return; }
    var chips = stakeValue();
    if (chips <= 0) { beep(160, 60, "sawtooth"); return; }
    if (S.cfg && chips < PX.toChips(S.cfg.minBet)) { toast("Min bet is " + Math.ceil(PX.toChips(S.cfg.minBet)) + " pts."); beep(160, 60, "sawtooth"); return; }
    if (S.bal != null && S.bal < chips) { el.getpts.hidden = false; beep(160, 60, "sawtooth"); toast(HAS_FAUCET ? "Not enough points — hit the faucet." : "Low $HELIXPOINT — tap GET $HELIXPOINT."); return; }
    var amt = PX.chipsToWei(chips), prov = PX.wallet.provider, from = S.acct, up = side === "up", dur = S.dur;
    function walletBet() {
      return ensureAllowance(from, amt).then(function () { return PX.openBet(prov, from, mid, up, amt, dur); });
    }
    function fire() {
      beep(600, 30); if (navigator.vibrate) navigator.vibrate(12);
      S.pendingOpen[S.asset] = { t: Date.now(), minId: (S.myBets[0] ? S.myBets[0].betId : 0) + 1 };
      // Auto-bet path: the session key signs openBetFor with NO popup, if a live grant covers this stake.
      var auto = autoReady() && S.auto.budgetLeft >= amt;
      var submit;
      if (auto) {
        submit = PXSession.autoBet(PX.NET.key, from, mid, up, amt, dur).catch(function (e) {
          // Retry on the wallet ONLY for a pre-broadcast gas shortfall (the tx never went out, so no
          // double-bet). Any other error (revert, timeout) surfaces — it may have landed.
          if (e && e.code === "INSUFFICIENT_GAS") {
            toast("Auto-bet gas low — confirm this one in your wallet, then top up ⚡.");
            return walletBet();
          }
          throw e;
        });
      } else {
        submit = walletBet();
      }
      submit
        .then(function () { flyPoints("bet " + chips, PAL.accent, side); setTimeout(poll, 1500); if (auto) refreshAuto(); })
        .catch(function (e) { delete S.pendingOpen[S.asset]; toast(txErr(e, "Bet failed.")); });
    }
    // Pre-flight the house exposure caps so an oversized bet shows a precise message (with the current
    // max) instead of a cryptic wallet revert. Read fails -> fire anyway; the contract still guards.
    if (!S.cfg || S.cfg.maxBetExposureBps == null) { fire(); return; }
    PX.houseStats().then(function (h) {
      if (h.bankroll <= 0n) { toast("The house has no LP yet — deposit via BE THE HOUSE first."); beep(160, 60, "sawtooth"); return; }
      var vig = BigInt(S.cfg.payoutBps - 10000);
      var reserve = amt * vig; reserve = reserve === 0n ? 0n : (reserve - 1n) / 10000n + 1n; // ceil((m-1)*stake)
      var perCap = h.bankroll * BigInt(S.cfg.maxBetExposureBps) / 10000n;
      var aggCap = h.bankroll * BigInt(S.cfg.maxAggExposureBps) / 10000n;
      if (reserve > perCap) {
        var maxStake = perCap * 10000n / vig; // largest stake whose reserve fits the per-bet cap
        toast("Too big for the house — max ~" + Math.floor(PX.toChips(maxStake)).toLocaleString("en-US") + " pts right now (LP " + Math.floor(PX.toChips(h.bankroll)).toLocaleString("en-US") + "). Bet smaller or add LP.");
        beep(160, 60, "sawtooth"); return;
      }
      if (h.reserved + reserve > aggCap) { toast("The house is near capacity right now — smaller bet, or try again shortly."); beep(160, 60, "sawtooth"); return; }
      fire();
    }).catch(function () { fire(); });
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
  /* ---------- session-key auto-bet state ---------- */
  // autoReady = there's a live grant for THIS session key that hasn't expired. budgetLeft is checked
  // per bet in fire(). Requires window.PXSession (the ESM module) to have loaded.
  function autoReady() { return !!(window.PXSession && S.auto && S.auto.granted && !S.auto.expired); }
  function updateAutoBtn() {
    if (!el.autobtn) return;
    var on = autoReady();
    el.autobtn.style.color = on ? "var(--ok)" : "";
    el.autobtn.style.filter = on ? "drop-shadow(0 0 3px var(--ok))" : "";
    el.autobtn.title = on ? "auto-bet ON — no popup per tap" : "auto-bet (no popup per tap)";
  }
  function refreshAuto() {
    if (!window.PXSession || !S.acct) { S.auto = null; updateAutoBtn(); return Promise.resolve(); }
    return PXSession.status(PX.NET.key, S.acct).then(function (st) { S.auto = st; updateAutoBtn(); })
      .catch(function () { /* leave last-known; a read blip shouldn't flip the UI */ });
  }

  // On testnet the button mints free MockPoints; on mainnet there's no faucet — it links out to
  // buy real $HELIXPOINT instead.
  var HAS_FAUCET = PX.NET.faucet !== false;
  if (!HAS_FAUCET) el.getpts.textContent = "GET " + (PX.NET.stakeSymbol || "$HELIXPOINT");
  function updateBalance() {
    el.bal.textContent = S.bal == null ? "—" : Math.floor(S.bal).toLocaleString("en-US");
    el.getpts.hidden = !(S.acct && S.bal != null && S.bal < 10);
  }
  el.getpts.onclick = function () {
    if (!HAS_FAUCET) { window.open(PX.NET.buyUrl || "https://pump.trippyinj.xyz/launch/8", "_blank", "noopener"); return; }
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
    if (S.bal != null && S.bal < chips) { el.lpMsg.textContent = HAS_FAUCET ? "Not enough points — hit the faucet." : "Low $HELIXPOINT to deposit."; return; }
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

  /* ---------- bet history (modal from the ☰ title-bar button) ---------- */
  function histPrice(raw) { return raw ? fmt(Number(raw) * Math.pow(10, EXPO)) : "—"; }
  function showHistory() {
    var ov = document.createElement("div");
    ov.id = "histmodal";
    ov.style.cssText = "position:fixed;inset:0;background:rgba(6,11,22,.82);display:flex;align-items:center;justify-content:center;z-index:9998;padding:16px";
    var box = document.createElement("div");
    box.style.cssText = "background:var(--panel);border:3px solid;border-color:var(--bevel-lt) var(--bevel-dk) var(--bevel-dk) var(--bevel-lt);min-width:300px;max-width:min(96vw,480px);max-height:82vh;display:flex;flex-direction:column";
    var hd = document.createElement("div");
    hd.style.cssText = "display:flex;align-items:center;gap:8px;padding:7px 10px;color:#fff;background:linear-gradient(90deg,var(--stripe-b),var(--stripe-a))";
    hd.innerHTML = "<span style='flex:1;font-family:var(--comic);font-weight:bold'>YOUR BETS</span>";
    var x = document.createElement("button"); x.className = "tbtn"; x.textContent = "×"; x.onclick = function () { document.body.removeChild(ov); };
    hd.appendChild(x); box.appendChild(hd);
    var list = document.createElement("div");
    list.style.cssText = "overflow-y:auto;padding:6px 8px;font-family:var(--mono);font-size:12px";
    box.appendChild(list);
    if (!S.acct) list.innerHTML = "<div style='opacity:.7;padding:12px'>Connect a wallet to see your bets.</div>";
    else if (!S.myBets.length) list.innerHTML = "<div style='opacity:.7;padding:12px'>No bets yet — tap UP or DOWN to play.</div>";
    else renderHistoryRows(list);
    ov.appendChild(box);
    ov.onclick = function (e) { if (e.target === ov) document.body.removeChild(ov); };
    document.body.appendChild(ov);
  }
  function renderHistoryRows(list) {
    var now = Date.now(), winVoid = [];
    S.myBets.forEach(function (p) {
      var a = assetOf(p.marketId) || "?";
      var dir = p.up ? "▲" : "▼", dcol = p.up ? "var(--ok)" : "var(--bad)";
      var stake = Math.floor(PX.toChips(p.stake));
      var status, scol, amt;
      if (p.result === PX.RESULT.OPEN) {
        var matured = now >= (p.strikeInstant + p.dur) * 1000;
        status = matured ? "settling" : "live"; scol = "var(--accent-2)"; amt = stake + " @ risk";
      } else if (p.result === PX.RESULT.WIN) {
        status = "won"; scol = "var(--ok)";
        amt = "+" + Math.floor(PX.toChips(p.stake) * p.payoutBps / 10000).toLocaleString("en-US"); winVoid.push(p.betId);
      } else if (p.result === PX.RESULT.VOID) {
        status = "void"; scol = "var(--ink-dim)"; amt = "refund " + stake.toLocaleString("en-US"); winVoid.push(p.betId);
      } else { status = "lost"; scol = "var(--bad)"; amt = "-" + stake.toLocaleString("en-US"); }
      var det = (p.strike && p.close) ? histPrice(p.strike) + "→" + histPrice(p.close) : (p.dur + "s");
      var row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 2px;border-bottom:1px solid var(--bevel-dk)";
      row.innerHTML =
        "<span style='color:" + dcol + ";font-weight:bold;min-width:46px'>" + dir + " " + a + "</span>" +
        "<span style='flex:1'><b>" + stake + "</b> pts <span style='opacity:.55'>" + det + "</span></span>" +
        "<span style='color:" + scol + ";font-weight:bold;min-width:52px;text-align:right'>" + status + "</span>" +
        "<span style='min-width:64px;text-align:right'>" + amt + "</span>";
      var slot = document.createElement("span"); slot.style.cssText = "min-width:56px;text-align:right"; slot.dataset.bet = p.betId;
      row.appendChild(slot); list.appendChild(row);
    });
    // only Win/Void can have unclaimed proceeds — read owed and drop a CLAIM button where >0
    winVoid.slice(0, 25).forEach(function (id) {
      PX.owed(id).then(function (w) {
        if (w <= 0n) return;
        var slot = list.querySelector('[data-bet="' + id + '"]'); if (!slot) return;
        var b = document.createElement("button"); b.className = "getpts"; b.textContent = "CLAIM"; b.style.padding = "3px 6px";
        b.onclick = function () {
          b.disabled = true; b.textContent = "…";
          PX.claim(PX.wallet.provider, S.acct, id).then(function () { b.textContent = "✓"; setTimeout(poll, 2500); })
            .catch(function (e) { b.disabled = false; b.textContent = "CLAIM"; toast(txErr(e, "Claim failed.")); });
        };
        slot.appendChild(b);
      }).catch(function () {});
    });
  }
  el.histbtn.onclick = showHistory;

  /* ---------- AUTO-BET (⚡ modal): grant a session key so taps fire with no wallet popup ---------- */
  function fmtDur(secs) {
    if (secs <= 0) return "expired";
    var h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
    return h > 0 ? h + "h " + m + "m" : m + "m";
  }
  function showAuto() {
    var ov = document.createElement("div");
    ov.id = "automodal";
    ov.style.cssText = "position:fixed;inset:0;background:rgba(6,11,22,.82);display:flex;align-items:center;justify-content:center;z-index:9998;padding:16px";
    var box = document.createElement("div");
    box.style.cssText = "background:var(--panel);border:3px solid;border-color:var(--bevel-lt) var(--bevel-dk) var(--bevel-dk) var(--bevel-lt);min-width:300px;max-width:min(96vw,440px);display:flex;flex-direction:column";
    var hd = document.createElement("div");
    hd.style.cssText = "display:flex;align-items:center;gap:8px;padding:7px 10px;color:#fff;background:linear-gradient(90deg,var(--stripe-b),var(--stripe-a))";
    hd.innerHTML = "<span style='flex:1;font-family:var(--comic);font-weight:bold'>⚡ AUTO-BET</span>";
    var x = document.createElement("button"); x.className = "tbtn"; x.textContent = "×"; x.onclick = function () { document.body.removeChild(ov); };
    hd.appendChild(x); box.appendChild(hd);
    var body = document.createElement("div");
    body.style.cssText = "padding:12px;font-family:var(--mono);font-size:12px;display:flex;flex-direction:column;gap:9px";
    box.appendChild(body);
    var msg = document.createElement("div");
    msg.style.cssText = "min-height:15px;color:var(--accent-2);font-size:11px";
    function status(t) { msg.textContent = t || ""; }

    var noPX = !window.PXSession;
    function inputRow(label, value, sym) {
      var row = document.createElement("label");
      row.style.cssText = "display:flex;align-items:center;gap:8px;justify-content:space-between";
      var sp = document.createElement("span"); sp.textContent = label; sp.style.opacity = ".8";
      var inp = document.createElement("input"); inp.type = "text"; inp.value = value;
      inp.style.cssText = "width:120px;text-align:right;font-family:var(--mono);padding:3px 6px;border:2px inset var(--bevel-dk);background:var(--panel-2);color:var(--ink)";
      var wrap2 = document.createElement("span"); wrap2.style.cssText = "display:flex;align-items:center;gap:4px";
      wrap2.appendChild(inp); var u = document.createElement("span"); u.textContent = sym; u.style.opacity = ".6"; wrap2.appendChild(u);
      row.appendChild(sp); row.appendChild(wrap2); row.__input = inp; return row;
    }
    // NB: do NOT reuse the .tbtn class here — that's the 22x20px title-bar icon button, which squished
    // these action buttons to a 22px sliver. Full inline styling with a Win95 press bevel instead.
    function btn(label, primary) {
      var b = document.createElement("button"); b.textContent = label;
      b.style.cssText = "padding:9px 12px;font-family:var(--comic);font-weight:bold;font-size:13px;cursor:pointer;white-space:nowrap;" +
        "border:2px solid;border-color:var(--bevel-lt) var(--bevel-dk) var(--bevel-dk) var(--bevel-lt);" +
        (primary ? "background:var(--accent);color:#fff;" : "background:var(--panel-2);color:var(--ink);");
      b.addEventListener("pointerdown", function () { b.style.borderColor = "var(--bevel-dk) var(--bevel-lt) var(--bevel-lt) var(--bevel-dk)"; });
      var up = function () { b.style.borderColor = "var(--bevel-lt) var(--bevel-dk) var(--bevel-dk) var(--bevel-lt)"; };
      b.addEventListener("pointerup", up); b.addEventListener("pointerleave", up);
      return b;
    }

    function render() {
      body.innerHTML = "";
      if (!S.acct) { body.appendChild(txt("Connect a wallet to enable auto-bet.")); body.appendChild(msg); return; }
      if (noPX) { body.appendChild(txt("Signer still loading — try again in a moment.")); body.appendChild(msg); return; }
      var a = S.auto;
      if (a && a.granted && !a.expired) {
        // ---- STATUS view ----
        var left = a.expiry - Math.floor(Date.now() / 1000);
        var gasInj = PX.toChips(a.gas);
        var lowGas = a.gas < (PXSession.GAS_LIMIT * 2n * 1000000000n); // ~2 bets of headroom at 1 gwei-ish
        body.appendChild(kv("Status", "ON — taps fire with no popup", "var(--ok)"));
        body.appendChild(kv("Session key", short(a.address), null));
        body.appendChild(kv("Budget left", Math.floor(PX.toChips(a.budgetLeft)).toLocaleString("en-US") + " / " + Math.floor(PX.toChips(a.maxSpend)).toLocaleString("en-US") + " " + SYM, null));
        body.appendChild(kv("Expires in", fmtDur(left), left < 3600 ? "var(--bad)" : null));
        body.appendChild(kv("Gas", gasInj.toFixed(4) + " INJ", lowGas ? "var(--bad)" : null));
        var rowb = document.createElement("div"); rowb.style.cssText = "display:flex;gap:8px;margin-top:4px";
        var top = btn("TOP UP GAS"); top.onclick = function () {
          status("Sending 0.05 INJ to the session key — confirm in wallet…");
          PXSession.topupGas(PX.wallet.provider, S.acct, a.address, injWei(0.05))
            .then(function () { status("Gas topped up."); setTimeout(function () { refreshAuto().then(render); }, 2500); })
            .catch(function (e) { status(txErr(e, "Top-up failed.")); });
        };
        var off = btn("DISABLE"); off.onclick = function () {
          status("Revoke — confirm in wallet…");
          PXSession.revoke(PX.wallet.provider, S.acct)
            .then(function () { status("Sweeping leftover gas back…"); return PXSession.sweepGas(PX.NET.key, S.acct).catch(function () { return null; }); })
            .then(function () { status("Auto-bet off."); setTimeout(function () { refreshAuto().then(render); }, 2500); })
            .catch(function (e) { status(txErr(e, "Disable failed.")); });
        };
        top.style.flex = "1"; off.style.flex = "1"; // share the row evenly instead of collapsing
        rowb.appendChild(top); rowb.appendChild(off); body.appendChild(rowb);
      } else {
        // ---- SETUP form ----
        body.appendChild(txt("Approve a budget once, then tap UP/DOWN with no wallet popup. A browser key signs your bets and pays its own gas. It can spend at most the budget, expires in 24h, and you can revoke anytime."));
        var biggest = (PX.NET.chips && PX.NET.chips[PX.NET.chips.length - 1]) || 100;
        var defBudget = Math.floor(Math.min(S.bal != null ? S.bal : biggest * 10, biggest * 10));
        var rBudget = inputRow("Session budget", defBudget, SYM);
        var rGas = inputRow("Gas top-up", "0.05", "INJ");
        body.appendChild(rBudget); body.appendChild(rGas);
        body.appendChild(kv("Expires", "in 24h (revoke anytime)", null));
        var go = btn("ENABLE AUTO-BET", true); go.style.marginTop = "4px"; go.style.width = "100%";
        go.onclick = function () {
          var budget = parseFloat(rBudget.__input.value), inj = parseFloat(rGas.__input.value);
          if (!(budget > 0)) { status("Enter a session budget."); return; }
          go.disabled = true;
          doEnable(budget, inj || 0.05, status).then(function () { setTimeout(function () { refreshAuto().then(render); }, 2500); })
            .catch(function () { go.disabled = false; });
        };
        body.appendChild(go);
      }
      body.appendChild(msg);
    }
    function txt(t) { var d = document.createElement("div"); d.style.cssText = "opacity:.8;line-height:1.5"; d.textContent = t; return d; }
    function kv(k, v, col) {
      var d = document.createElement("div"); d.style.cssText = "display:flex;justify-content:space-between;gap:10px";
      d.innerHTML = "<span style='opacity:.7'>" + k + "</span><span style='font-weight:bold" + (col ? ";color:" + col : "") + "'>" + v + "</span>"; return d;
    }
    render();
    // pull a fresh grant/gas read when the modal opens
    if (S.acct && !noPX) refreshAuto().then(render);
    ov.appendChild(box);
    ov.onclick = function (e) { if (e.target === ov) document.body.removeChild(ov); };
    document.body.appendChild(ov);
  }
  var SYM = (PX.NET.stakeSymbol === "$HELIXPOINT") ? "$HLX" : "pts";
  function short(a) { return a ? a.slice(0, 6) + "…" + a.slice(-4) : "—"; }
  function injWei(inj) { return BigInt(Math.round(inj * 1e6)) * (10n ** 12n); } // INJ is 18-dec
  // The one-time enable: approve budget (if allowance short) -> grantSession -> fund the key's gas.
  // There is no user-facing per-bet cap: a single bet is bounded by the book's own maxBet + exposure
  // caps, and the session by maxSpend. We still must satisfy the contract's grantSession invariants
  // (maxStake <= maxBet AND maxSpend >= maxStake), so set maxStake = min(maxSpend, maxBet) — the
  // largest non-binding value: it never rejects a bet the budget + book would otherwise allow.
  function doEnable(budgetChips, inj, status) {
    var from = S.acct, prov = PX.wallet.provider;
    var maxSpendWei = PX.chipsToWei(budgetChips);
    var maxBetWei = S.cfg && S.cfg.maxBet ? S.cfg.maxBet : maxSpendWei;
    var maxStakeWei = maxSpendWei < maxBetWei ? maxSpendWei : maxBetWei; // min(maxSpend, maxBet)
    var key = PXSession.ensureKey(PX.NET.key, from).address;
    var expiry = Math.floor(Date.now() / 1000) + 86340; // ~24h, just under MAX_SESSION to clear the bound
    status("Approve budget — confirm in wallet…");
    return PX.allowance(from, PX.NET.book).then(function (a) {
      return a >= maxSpendWei ? null : PXSession.approve(prov, from, maxSpendWei);
    }).then(function () {
      status("Grant the session key — confirm in wallet…");
      return PXSession.grant(prov, from, key, maxStakeWei, expiry, maxSpendWei);
    }).then(function () {
      status("Fund gas (" + inj + " INJ) — confirm in wallet…");
      return PXSession.topupGas(prov, from, key, injWei(inj));
    }).then(function () {
      status("Auto-bet ON — tap UP/DOWN, no more popups.");
      flyPoints("⚡ AUTO ON", PAL.ok, "up");
    }).catch(function (e) { status(txErr(e, "Enable failed.")); throw e; });
  }
  if (el.autobtn) el.autobtn.onclick = showAuto;

  /* ---------- MY STATS (🏆 modal): personal P&L from positionsOf, no backend ---------- */
  // net P&L per bet reconstructed from the Position (the struct has result+stake+payoutBps but not
  // payout/tip). tip = min(maxTip, stake*tipBps/BPS). Matches on-chain: win (m-1)stake-tip, loss
  // -stake, void -tip. Windowed by closeInstant = strikeInstant+dur (the moment the bet resolved).
  var STAT_WINS = [["DAY", 86400], ["WEEK", 604800], ["MONTH", 2592000], ["ALL", 0]];
  function statTip(stakeWei) {
    var bps = BigInt(S.cfg ? S.cfg.tipBps : 100), mx = S.cfg ? S.cfg.maxTip : 5n * (10n ** 18n);
    var t = stakeWei * bps / 10000n; return t > mx ? mx : t;
  }
  function betNet(p) { // wei, BigInt (can be negative)
    if (p.result === PX.RESULT.WIN) return p.stake * BigInt(p.payoutBps) / 10000n - statTip(p.stake) - p.stake;
    if (p.result === PX.RESULT.LOSS) return -p.stake;
    if (p.result === PX.RESULT.VOID) return -statTip(p.stake);
    return 0n; // open — no settled outcome
  }
  function computeStats(bets, winSec) {
    var now = Math.floor(Date.now() / 1000);
    var net = 0n, vol = 0n, w = 0, l = 0, v = 0, biggest = 0n, streak = 0;
    bets.forEach(function (p) {
      var closeAt = p.strikeInstant + p.dur;
      if (winSec > 0 && closeAt < now - winSec) return; // outside the rolling window
      vol += p.stake;
      if (p.result === PX.RESULT.OPEN) return;
      net += betNet(p);
      if (p.result === PX.RESULT.WIN) { w++; var n = betNet(p); if (n > biggest) biggest = n; }
      else if (p.result === PX.RESULT.LOSS) l++;
      else if (p.result === PX.RESULT.VOID) v++;
    });
    for (var i = 0; i < bets.length; i++) { // current streak = leading wins over ALL settled (newest first)
      if (bets[i].result === PX.RESULT.OPEN) continue;
      if (bets[i].result === PX.RESULT.WIN) streak++; else break;
    }
    return { net: net, vol: vol, w: w, l: l, v: v, biggest: biggest, streak: streak, total: w + l + v };
  }
  function signedChips(wei) { var s = wei < 0n ? "-" : "+"; var a = wei < 0n ? -wei : wei; return s + Math.floor(PX.toChips(a)).toLocaleString("en-US"); }
  // ---- global leaderboard (Phase 2): fetched from the indexer JSON, sortable table + bars ----
  var LB_WIN_KEY = ["day", "week", "month", "all"]; // maps STAT_WINS index -> JSON window key
  var LB_SORTS = { net: ["🍀 LUCKIEST", -1], netUp: ["💀 MOST REKT", 1], vol: ["🎰 MOST ACTION", 0] };
  function shortAddr(a) { return a.slice(0, 6) + "…" + a.slice(-4); }
  function fmtSigned(weiStr) { var w = BigInt(weiStr); var s = w < 0n ? "-" : "+"; var a = w < 0n ? -w : w; return s + Math.floor(PX.toChips(a)).toLocaleString("en-US"); }
  function fmtChips(weiStr) { return Math.floor(PX.toChips(BigInt(weiStr))).toLocaleString("en-US"); }
  function sortPlayers(players, sort) {
    var arr = players.slice();
    if (sort === "vol") arr.sort(function (x, y) { var d = BigInt(y.vol) - BigInt(x.vol); return d > 0n ? 1 : d < 0n ? -1 : 0; });
    else { var sgn = sort === "netUp" ? -1n : 1n; arr.sort(function (x, y) { var d = (BigInt(y.net) - BigInt(x.net)) * sgn; return d > 0n ? 1 : d < 0n ? -1 : 0; }); }
    return arr;
  }

  function showStats() {
    if (S.lbMode == null) S.lbMode = (PX.NET.lbUrl ? "global" : "mine"); // board is the headline on mainnet
    if (S.lbSort == null) S.lbSort = "net";
    var ov = document.createElement("div"); ov.id = "statsmodal";
    ov.style.cssText = "position:fixed;inset:0;background:rgba(6,11,22,.82);display:flex;align-items:center;justify-content:center;z-index:9998;padding:16px";
    var box = document.createElement("div");
    box.style.cssText = "background:var(--panel);border:3px solid;border-color:var(--bevel-lt) var(--bevel-dk) var(--bevel-dk) var(--bevel-lt);min-width:300px;max-width:min(96vw,480px);max-height:90vh;display:flex;flex-direction:column";
    var hd = document.createElement("div");
    hd.style.cssText = "display:flex;align-items:center;gap:8px;padding:7px 10px;color:#fff;background:linear-gradient(90deg,var(--stripe-b),var(--stripe-a))";
    hd.innerHTML = "<span id='lbtitle' style='flex:1;font-family:var(--comic);font-weight:bold'>🏆 LEADERBOARD</span>";
    var x = document.createElement("button"); x.className = "tbtn"; x.textContent = "×"; x.onclick = function () { document.body.removeChild(ov); };
    hd.appendChild(x); box.appendChild(hd);
    // mode toggle (only when a global board exists on this network)
    var modeRow = document.createElement("div"); modeRow.style.cssText = "display:flex;gap:4px;padding:6px 8px 0";
    var tabs = document.createElement("div"); tabs.style.cssText = "display:flex;gap:4px;padding:6px 8px";
    var body = document.createElement("div"); body.style.cssText = "padding:10px 12px 14px;font-family:var(--mono);font-size:13px;overflow:auto";
    if (PX.NET.lbUrl) box.appendChild(modeRow);
    box.appendChild(tabs); box.appendChild(body);
    function drawModes() {
      modeRow.innerHTML = "";
      [["global", "🌐 GLOBAL"], ["mine", "👤 MINE"]].forEach(function (m) {
        var b = document.createElement("button"); b.className = "chip"; b.style.cssText = "flex:1;width:auto;padding:6px 0;font-size:12px";
        b.textContent = m[1]; b.setAttribute("aria-pressed", S.lbMode === m[0] ? "true" : "false");
        b.onclick = function () { S.lbMode = m[0]; drawModes(); render(); };
        modeRow.appendChild(b);
      });
    }
    function drawTabs() {
      tabs.innerHTML = "";
      STAT_WINS.forEach(function (wn, i) {
        var b = document.createElement("button"); b.className = "chip"; b.style.cssText = "flex:1;width:auto;padding:6px 0;font-size:12px";
        b.textContent = wn[0]; b.setAttribute("aria-pressed", i === S.statWin ? "true" : "false");
        b.onclick = function () { S.statWin = i; drawTabs(); render(); };
        tabs.appendChild(b);
      });
    }
    function statRow(a, b) {
      return "<div style='display:flex;justify-content:space-between;padding:5px 0;border-top:1px solid var(--bevel-dk)'>" +
        "<span style='opacity:.75'>" + a[0] + "</span><b style='color:" + (a[2] || "var(--ink)") + "'>" + a[1] + "</b>" +
        "<span style='opacity:.75;margin-left:14px'>" + b[0] + "</span><b style='color:" + (b[2] || "var(--ink)") + "'>" + b[1] + "</b></div>";
    }
    function renderMine() {
      $("lbtitle").textContent = "🏆 MY STATS";
      if (!S.acct) { body.innerHTML = "<div style='opacity:.7;text-align:center;padding:14px'>Connect a wallet to see your stats.</div>"; return; }
      if (S.statsBets == null) { body.innerHTML = "<div style='opacity:.7;text-align:center;padding:14px'>crunching your bets…</div>"; if (S.acct) PX.myPositions(S.acct, 150).then(function (r) { S.statsBets = r.positions; if (S.lbMode === "mine") renderMine(); }).catch(function () { S.statsBets = []; if (S.lbMode === "mine") renderMine(); }); return; }
      if (!S.statsBets.length) { body.innerHTML = "<div style='opacity:.7;text-align:center;padding:16px'>No bets yet — tap UP or DOWN to play 🏆</div>"; return; }
      var s = computeStats(S.statsBets, STAT_WINS[S.statWin][1]);
      var col = s.net < 0n ? "var(--bad)" : s.net > 0n ? "var(--ok)" : "var(--ink)";
      var wr = (s.w + s.l) > 0 ? Math.round(100 * s.w / (s.w + s.l)) : 0;
      var streakTxt = (s.streak >= 2 ? "🔥 " : "") + s.streak;
      body.innerHTML =
        "<div style='text-align:center;margin-bottom:8px'>" +
          "<div style='font-size:11px;opacity:.6;letter-spacing:1px'>NET P&L</div>" +
          "<div style='font-size:30px;font-weight:bold;color:" + col + "'>" + signedChips(s.net) + "<span style='font-size:13px;opacity:.6'> pts</span></div>" +
        "</div>" +
        statRow(["win rate", wr + "%"], ["record", s.w + "W " + s.l + "L " + s.v + "V"]) +
        statRow(["volume", Math.floor(PX.toChips(s.vol)).toLocaleString("en-US")], ["biggest hit", s.biggest > 0n ? "+" + Math.floor(PX.toChips(s.biggest)).toLocaleString("en-US") : "—", "var(--ok)"]) +
        statRow(["streak", streakTxt], ["bets", String(s.total)]) +
        (S.statsBets.length >= 150 ? "<div style='opacity:.5;font-size:10px;text-align:center;margin-top:8px'>last 150 bets</div>" : "");
    }
    function renderGlobal() {
      $("lbtitle").textContent = "🏆 " + LB_SORTS[S.lbSort][0];
      if (S.lbData === undefined) { // loading
        body.innerHTML = "<div style='opacity:.7;text-align:center;padding:16px'>crunching the chain… 🏆</div>";
        PX.leaderboard().then(function (d) { S.lbData = d; if (S.lbMode === "global") renderGlobal(); });
        return;
      }
      if (!S.lbData) { body.innerHTML = "<div style='opacity:.7;text-align:center;padding:16px'>couldn't load standings<br><button class='chip' id='lbretry' style='width:auto;margin-top:8px;padding:5px 12px'>RETRY</button></div>"; var rb = $("lbretry"); if (rb) rb.onclick = function () { S.lbData = undefined; renderGlobal(); }; return; }
      var win = S.lbData.windows[LB_WIN_KEY[S.statWin]] || { global: {}, players: [] };
      var g = win.global, players = win.players || [];
      if (!players.length) { body.innerHTML = "<div style='opacity:.7;text-align:center;padding:18px'>No bets in this window yet — be the first 🏆<br><button class='chip' id='lbplay' style='width:auto;margin-top:10px;padding:6px 14px'>TAP TO PLAY</button></div>"; var pb = $("lbplay"); if (pb) pb.onclick = function () { document.body.removeChild(ov); }; return; }
      var sorted = sortPlayers(players, S.lbSort);
      var metric = function (p) { return S.lbSort === "vol" ? BigInt(p.vol) : BigInt(p.net); };
      var maxAbs = 1n; sorted.forEach(function (p) { var m = metric(p); if (m < 0n) m = -m; if (m > maxAbs) maxAbs = m; });
      var me = S.acct ? S.acct.toLowerCase() : null;
      var myRank = -1; for (var i = 0; i < sorted.length; i++) if (sorted[i].addr === me) { myRank = i; break; }
      var houseCol = BigInt(g.housePnl || "0") >= 0n ? "var(--ok)" : "var(--bad)";
      var asset = { "0": "BTC", "1": "ETH", "2": "INJ" }[String(g.topAsset)] || "—";
      var h = "<div style='font-size:11px;opacity:.75;text-align:center;margin-bottom:8px;line-height:1.5'>" +
        "vol " + fmtChips(g.volume || "0") + " · " + (g.bets || 0) + " bets · house <b style='color:" + houseCol + "'>" + fmtSigned(g.housePnl || "0") + "</b> · " + asset + " 🔥</div>";
      // sort header (tap to cycle)
      h += "<div style='display:flex;font-size:10px;opacity:.6;padding:2px 0 4px;cursor:pointer' id='lbsorthd'>" +
        "<span style='width:26px'>#</span><span style='flex:1'>player</span>" +
        "<span style='min-width:74px;text-align:right'>NET ⇅</span><span style='min-width:56px;margin-left:6px;text-align:right'>vol</span><span style='min-width:40px;margin-left:6px;text-align:right'>win%</span></div>";
      var rows = "";
      sorted.slice(0, 20).forEach(function (p, idx) {
        var m = metric(p); var neg = m < 0n; var mag = neg ? -m : m;
        var barPct = Number(mag * 100n / maxAbs);
        var barCol = S.lbSort === "vol" ? "var(--accent)" : (BigInt(p.net) < 0n ? "var(--bad)" : "var(--ok)");
        var medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : (idx + 1);
        var netCol = BigInt(p.net) < 0n ? "var(--bad)" : "var(--ok)";
        var isMe = p.addr === me;
        var badge = (p.streak >= 3 ? " 🔥" : "");
        rows += "<div style='position:relative;display:flex;align-items:center;padding:5px 2px;border-top:1px solid var(--bevel-dk);" + (isMe ? "background:var(--panel-2);" : "") + "'>" +
          "<div style='position:absolute;left:0;top:0;bottom:0;width:" + barPct + "%;background:" + barCol + ";opacity:.12'></div>" +
          "<span style='width:26px;position:relative'>" + medal + "</span>" +
          "<span style='flex:1;position:relative;" + (isMe ? "font-weight:bold" : "") + "'>" + shortAddr(p.addr) + badge + "</span>" +
          "<span style='min-width:74px;text-align:right;position:relative;color:" + netCol + "'>" + fmtSigned(p.net) + "</span>" +
          "<span style='min-width:56px;margin-left:6px;text-align:right;position:relative;opacity:.8'>" + fmtChips(p.vol) + "</span>" +
          "<span style='min-width:40px;margin-left:6px;text-align:right;position:relative;opacity:.8'>" + (p.winRate == null ? "—" : p.winRate + "%") + "</span></div>";
      });
      // sticky YOU row
      var you = "";
      if (me) {
        if (myRank >= 0) {
          var mp = sorted[myRank];
          you = "<div style='display:flex;align-items:center;gap:8px;margin-top:8px;padding:7px 6px;border:2px solid var(--accent);background:var(--panel-2)'>" +
            "<span style='font-weight:bold'>👉 YOU #" + (myRank + 1) + "</span>" +
            "<span style='flex:1;text-align:right;color:" + (BigInt(mp.net) < 0n ? "var(--bad)" : "var(--ok)") + ";font-weight:bold'>" + fmtSigned(mp.net) + "</span>" +
            "<span style='opacity:.7'>vol " + fmtChips(mp.vol) + "</span>" +
            "<button class='chip' id='lbshare' style='width:auto;padding:4px 10px'>SHARE</button></div>";
        } else {
          you = "<div style='margin-top:8px;padding:7px 6px;border:2px solid var(--bevel-dk);opacity:.7;text-align:center'>You're not on this board yet — play a bet 🏆</div>";
        }
      }
      body.innerHTML = h + rows + you;
      var sh = $("lbsorthd"); if (sh) sh.onclick = function () { S.lbSort = S.lbSort === "net" ? "netUp" : S.lbSort === "netUp" ? "vol" : "net"; renderGlobal(); };
      var shb = $("lbshare"); if (shb) shb.onclick = function () {
        var txt = "I'm #" + (myRank + 1) + " on wenpoints predict 🏆 " + (window.location.origin || "https://predict.wenpoints.xyz");
        if (navigator.clipboard) navigator.clipboard.writeText(txt).then(function () { toast("Rank copied — go flex."); }, function () { toast(txt); });
        else toast(txt);
      };
    }
    function render() { if (S.lbMode === "global" && PX.NET.lbUrl) renderGlobal(); else renderMine(); }
    S.statsBets = null; if (S.lbData === null) S.lbData = undefined; // allow re-fetch on reopen
    ov.appendChild(box);
    ov.onclick = function (e) { if (e.target === ov) document.body.removeChild(ov); };
    document.body.appendChild(ov); // must be in the document BEFORE render() (it uses getElementById)
    if (PX.NET.lbUrl) drawModes();
    drawTabs(); render();
  }
  el.statsbtn.onclick = showStats;

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

    // The close instant is a WALL: at/after it the outcome is decided by the price at that instant,
    // and later movement is irrelevant. So during settling we FREEZE the window at the close instant
    // (with a little room to its right) instead of scrolling with `now` — the head stops at the line,
    // it never crosses-then-reverses, and the dashes don't drift.
    var settling = v && v.phase === "settling";
    var futMs = (v && v.tfMs) || S.dur * 1000, histMs = 3 * futMs;
    var rightMargin = futMs * 0.4; // gap kept to the right of the finish line
    var rightT = (v && (v.phase === "live" || v.phase === "settling")) ? v.closeInstantMs + rightMargin : now + futMs;
    var t1 = rightT, t0 = t1 - (histMs + futMs);
    var xOf = function (t) { return (t - t0) / (t1 - t0) * W; };
    // the deterministic close = first Pyth tick at/after closeInstant (the price that actually settles)
    var closeTick = null;
    if (v && (v.phase === "live" || v.phase === "settling") && now >= v.closeInstantMs) {
      var _cs = v.closeInstantMs / 1000;
      for (var ci = 0; ci < f.samples.length; ci++) { if (f.samples[ci].pt && f.samples[ci].pt >= _cs) { closeTick = f.samples[ci]; break; } }
    }
    var closePrice = settling ? (closeTick ? closeTick.p : f.disp) : null; // hold last price during the ~1s reveal gap

    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < f.samples.length; i++) { var sm = f.samples[i]; if (sm.t < t0) continue; if (sm.p < lo) lo = sm.p; if (sm.p > hi) hi = sm.p; }
    if (splitPrice < lo) lo = splitPrice; if (splitPrice > hi) hi = splitPrice;
    if (closePrice != null) { if (closePrice < lo) lo = closePrice; if (closePrice > hi) hi = closePrice; }
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

    // price line + head dot. During settling the line STOPS at the finish line (the wall): post-close
    // ticks aren't drawn and the head doesn't run to `now` — the bet is already decided at the wall.
    ctx.strokeStyle = PAL["accent-2"]; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.beginPath();
    var started = false;
    for (i = 0; i < f.samples.length; i++) {
      sm = f.samples[i]; if (sm.t < t0 - 1000) continue;
      if (settling && sm.t > v.closeInstantMs) continue; // ignore movement past the wall
      var px = xOf(sm.t), py = yOf(sm.p);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    var headX = settling ? xOf(v.closeInstantMs) : xOf(now);
    var headY = settling ? yOf(closePrice) : yOf(f.disp);
    if (started) ctx.lineTo(headX, headY);
    ctx.stroke();
    ctx.fillStyle = PAL["accent-2"];
    ctx.globalAlpha = 0.25; ctx.beginPath(); ctx.arc(headX, headY, 7, 0, 7); ctx.fill();
    ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(headX, headY, 3, 0, 7); ctx.fill();

    // live price readout riding the dot while the bet is running (pre-close): ▲ green above strike / ▼ red below
    if (v && v.phase === "live" && v.strike != null) {
      var live = f.disp, strike = v.strike;
      // colour by whether YOUR bet is winning (ahead), not raw price vs strike: a DOWN bet is
      // ahead (green) when price is BELOW its strike. Arrow still shows price direction vs strike.
      var ahead = v.up ? live > strike : live < strike;
      var behind = v.up ? live < strike : live > strike;
      var col = ahead ? PAL.ok : behind ? PAL.bad : PAL["ink-dim"];
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
    ctx.fillStyle = ready ? PAL.ok : settling ? PAL.accent : PAL.bad;
    ctx.fillText(ready ? ">> TAP TO BET · " + S.dur + "s <<" : (v.phase === "arming" ? "STRIKE LOCKING IN" : settling ? "SETTLING…" : "SWEAT IT"), zx, 12);

    // finish line = the close instant, a STATIC wall (the deadline doesn't move). Once the
    // deterministic close tick lands, stamp the verdict (WON/LOST/PUSH + the exact settle price)
    // right ON the line — the outcome is decided AT the wall, never by movement past it.
    if (v && (v.phase === "live" || v.phase === "settling")) {
      var fx = Math.min(Math.max(xOf(v.closeInstantMs), 1), W - 1);
      ctx.strokeStyle = settling ? PAL.ink : PAL["ink-dim"]; ctx.globalAlpha = settling ? 0.75 : 0.5; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(fx, 0); ctx.lineTo(fx, H); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      if (settling) {
        var vy = Math.max(16, Math.min(H - 8, yOf(closePrice)));
        if (closeTick) {
          var strk = v.strike;
          var tie = strk != null && closeTick.p === strk;
          var won = strk != null && (v.up ? closeTick.p > strk : closeTick.p < strk);
          var vcol = tie ? PAL["ink-dim"] : won ? PAL.ok : PAL.bad;
          ctx.strokeStyle = vcol; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(fx, vy, 6, 0, 7); ctx.stroke();
          ctx.fillStyle = vcol; ctx.font = "bold 11px 'Courier New',monospace"; ctx.textAlign = "center";
          ctx.fillText((tie ? "PUSH" : won ? "WON" : "LOST") + " " + fmt(closeTick.p), fx, vy - 11);
        } else {
          ctx.fillStyle = PAL["ink-dim"]; ctx.font = "bold 9px 'Courier New',monospace"; ctx.textAlign = "center";
          ctx.fillText("settling…", fx, Math.max(16, Math.min(H - 8, yOf(closePrice))) - 11);
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
  // Compact chip label: 100000 -> "100K", 1000000 -> "1M", 10000000 -> "10M".
  function fmtChip(v) {
    if (v >= 1e6) return (v / 1e6).toString().replace(/\.0$/, "") + "M";
    if (v >= 1e3) return (v / 1e3).toString().replace(/\.0$/, "") + "K";
    return String(v);
  }
  // Build the numeric stake chips from the network's presets ($HELIXPOINT scale on mainnet,
  // points scale on testnet), inserting them before the MAX button.
  (function buildChips() {
    var chips = (PX.NET.chips && PX.NET.chips.length) ? PX.NET.chips : [10, 25, 50, 100];
    var maxBtn = document.querySelector('.chip[data-v="max"]');
    var frag = document.createDocumentFragment();
    chips.forEach(function (v) {
      var b = document.createElement("button");
      b.className = "chip"; b.dataset.v = String(v); b.textContent = fmtChip(v);
      frag.appendChild(b);
    });
    maxBtn.parentNode.insertBefore(frag, maxBtn);
    // a stored stake from another network's scale won't exist here — fall back to the first preset
    if (S.stake !== "max" && chips.indexOf(S.stake) < 0) { S.stake = chips[0]; localStorage.predict_stake = S.stake; }
  })();
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
          // ahead/behind is relative to YOUR side: a DOWN bet is ahead when price < strike.
          var even = f.disp === v.strike;
          var ahead = v.up ? f.disp > v.strike : f.disp < v.strike;
          var lead = even ? "• EVEN" : ahead ? "▲ AHEAD" : "▼ BEHIND";
          el.phase.textContent = lead + " @ " + fmt(v.strike);
          el.phase.className = even ? "phase" : ahead ? "phase hot" : "phase locked"; // hot=green, locked=red
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
  if (!HAS_FAUCET) { // mainnet: $HELIXPOINT at stake (no faucet)
    var rn = document.getElementById("realnote"); if (rn) rn.textContent = "mainnet · $HELIXPOINT";
    var tg = document.getElementById("tagline"); if (tg) tg.textContent = "$HELIXPOINT stakes. Pyth prices. Fixed odds vs the house.";
  }
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
