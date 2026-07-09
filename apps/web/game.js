/* PREDICT.EXE — $HELIXPOINT price arcade (POC).
   Zero dependencies. Real prices via Pyth Hermes SSE; pools, bots and points are
   simulated locally. The on-chain parimutuel contract replaces sim.* later. */
(function () {
  "use strict";

  /* ---------- config ---------- */
  var FEEDS = {
    BTC: { id: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", label: "BTC/USD" },
    ETH: { id: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", label: "ETH/USD" },
    INJ: { id: "7a5bc1d2b56ad029048cd63964b3ad2776eadf812edc1a43a31406cb54bff592", label: "INJ/USD" }
  };
  var HIST_MS = 60000, PLAY_MS = 30000, BET_MS = 12000;
  var RAKE = 0.03;
  var CHIPS_MAX_CAP = 1000;

  /* ---------- state ---------- */
  var assets = Object.keys(FEEDS);
  var S = {
    asset: "BTC",
    stake: parseInt(localStorage.predict_stake || "25", 10) || 25,
    bal: parseInt(localStorage.predict_bal || "1000", 10),
    muted: localStorage.predict_mute === "1",
    feeds: {},   // per asset: {samples:[{t,p}], disp, lastTick}
    rounds: {},  // per asset: {n, phase, tEnd, strike, pools:{up,down}, lockMult:{up,down}, my:{up,down}, winEnd}
    hist: {},    // per asset: [{dir, mine, delta}]
    hover: null, press: null, flash: null,
    feedMode: "live", lastAnyTick: 0
  };
  assets.forEach(function (a) {
    S.feeds[a] = { samples: [], disp: null, lastTick: 0 };
    S.rounds[a] = null;
    S.hist[a] = [];
  });

  /* ---------- dom ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var cv = $("cv"), ctx = cv.getContext("2d");
  var wrap = $("chartwrap");
  var el = { rid: $("rid"), phase: $("phase"), clock: $("clock"), bal: $("bal"), hist: $("hist"),
             led: $("led"), px: $("px"), feedlbl: $("feedlbl"), getpts: $("getpts") };

  /* ---------- theme + palette ---------- */
  var PAL = {};
  function readPalette() {
    var cs = getComputedStyle(document.documentElement);
    ["ink", "ink-dim", "accent", "accent-2", "ok", "bad", "panel-2", "bevel-dk"].forEach(function (k) {
      PAL[k] = cs.getPropertyValue("--" + k).trim();
    });
    PAL.comic = cs.getPropertyValue("--comic").trim() || "'Comic Sans MS',cursive";
  }
  window.matchMedia("(max-width: 480px)").addEventListener("change", readPalette);
  document.documentElement.dataset.theme = localStorage.predict_theme || "dark";
  readPalette();
  $("themebtn").onclick = function () {
    var t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = t; localStorage.predict_theme = t; readPalette();
  };

  /* ---------- audio (muted-able, lazy) ---------- */
  var AC = null;
  function beep(f, ms, type, g) {
    if (S.muted) return;
    try {
      AC = AC || new (window.AudioContext || window.webkitAudioContext)();
      var o = AC.createOscillator(), gn = AC.createGain();
      o.type = type || "square"; o.frequency.value = f;
      gn.gain.setValueAtTime(g || 0.04, AC.currentTime);
      gn.gain.exponentialRampToValueAtTime(0.0001, AC.currentTime + ms / 1000);
      o.connect(gn); gn.connect(AC.destination);
      o.start(); o.stop(AC.currentTime + ms / 1000);
    } catch (e) { /* no audio, no problem */ }
  }
  function updateMuteBtn() { $("mutebtn").textContent = S.muted ? "×" : "♪"; }
  $("mutebtn").onclick = function () { S.muted = !S.muted; localStorage.predict_mute = S.muted ? "1" : "0"; updateMuteBtn(); };
  updateMuteBtn();

  /* ---------- price feed: Pyth Hermes SSE, synthetic fallback ---------- */
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
        if (!(p > 0)) return;
        pushSample(a, p);
      });
      retryMs = 1000; S.feedMode = "live"; S.lastAnyTick = performance.now();
    };
    es.onerror = function () { try { es.close(); } catch (e) {} scheduleRetry(); };
  }
  function scheduleRetry() { setTimeout(connectFeed, retryMs); retryMs = Math.min(retryMs * 2, 15000); }

  function pushSample(a, p) {
    var f = S.feeds[a], t = performance.now();
    f.samples.push({ t: t, p: p });
    f.lastTick = t;
    var cutoff = t - (HIST_MS + PLAY_MS + 30000);
    while (f.samples.length && f.samples[0].t < cutoff) f.samples.shift();
    if (f.disp === null) f.disp = p;
  }

  // synthetic random-walk keeps the demo alive if the stream drops
  function syntheticTick(now, dt) {
    if (S.feedMode === "live" && now - S.lastAnyTick < 8000) return;
    S.feedMode = "sim";
    assets.forEach(function (a) {
      var f = S.feeds[a];
      var last = f.samples.length ? f.samples[f.samples.length - 1].p : { BTC: 67000, ETH: 3500, INJ: 25 }[a];
      if (!f._accum) f._accum = 0;
      f._accum += dt;
      if (f._accum > 400) {
        f._accum = 0;
        pushSample(a, last * (1 + (Math.random() - 0.5) * 0.0008));
      }
    });
  }

  /* ---------- round engine (per asset) ---------- */
  function newRound(a, now) {
    var n = (S.rounds[a] ? S.rounds[a].n : parseInt(localStorage["predict_n_" + a] || "0", 10)) + 1;
    localStorage["predict_n_" + a] = n;
    S.rounds[a] = {
      n: n, phase: "bet", tEnd: now + BET_MS, strike: null,
      pools: { up: 60 + Math.random() * 180, down: 60 + Math.random() * 180 },
      lockMult: null, my: { up: 0, down: 0 }, _lastTickSec: null
    };
  }

  function mult(r, side) {
    var pot = r.pools.up + r.pools.down, pool = r.pools[side];
    if (pool <= 0) return 0;
    return pot * (1 - RAKE) / pool;
  }

  function stepRound(a, now) {
    var f = S.feeds[a];
    if (!f.samples.length) return;            // wait for first price
    if (!S.rounds[a]) newRound(a, now);
    var r = S.rounds[a];

    if (r.phase === "bet") {
      // countdown ticks (active asset only)
      if (a === S.asset) {
        var remS = Math.ceil((r.tEnd - now) / 1000);
        if (remS <= 3 && remS >= 1 && r._lastTickSec !== remS) { r._lastTickSec = remS; beep(800, 30); }
      }
      botBets(r, f, now);
      if (now >= r.tEnd) {                    // LOCK: freeze strike + odds
        r.phase = "play";
        r.strike = f.disp || f.samples[f.samples.length - 1].p;
        r.lockT = now; r.tEnd = now + PLAY_MS;
        r.lockMult = { up: mult(r, "up"), down: mult(r, "down") };
        if (a === S.asset) beep(210, 50, "square", 0.05);
      }
    } else if (r.phase === "play" && now >= r.tEnd) {
      settle(a, r, f, now);
    }
  }

  function settle(a, r, f, now) {
    var P = f.samples[f.samples.length - 1].p;
    var dir = Math.abs(P - r.strike) < r.strike * 1e-6 ? "tie" : (P > r.strike ? "up" : "down");
    var mine = null, delta = 0;
    var stakeTotal = r.my.up + r.my.down;

    if (dir === "tie") {
      delta = stakeTotal;                                    // refund
      if (stakeTotal > 0) mine = "tie";
    } else if (stakeTotal > 0) {
      var winStake = r.my[dir];
      if (winStake > 0) {
        var pot = r.pools.up + r.pools.down;
        delta = Math.floor(winStake / r.pools[dir] * pot * (1 - RAKE));
        mine = "win";
      } else mine = "lose";
    }
    if (delta > 0) { S.bal += delta; saveBal(); }

    S.hist[a].unshift({ dir: dir, mine: mine, delta: delta });
    S.hist[a] = S.hist[a].slice(0, 16);

    if (a === S.asset) {
      S.flash = { t0: now, dir: dir, mine: mine };
      if (mine === "win") { beep(660, 90); setTimeout(function () { beep(990, 140); }, 90); flyPoints("+" + delta, PAL.ok, dir); }
      else if (mine === "lose") { beep(120, 180, "sawtooth", 0.05); flyPoints("rekt", PAL.bad, dir); }
      else if (mine === "tie") { flyPoints("push · refund", PAL["ink-dim"], "up"); }
      renderHist(); updateBalance();
    }
    newRound(a, now);
  }

  /* ---------- simulated co-bettors ---------- */
  function botBets(r, f, now) {
    if (!r._bot) r._bot = 0;
    r._bot += 16;
    if (r._bot < 250) return;
    r._bot = 0;
    if (Math.random() > 0.55) return;
    // momentum bias from ~8s of movement
    var s = f.samples, pNow = s[s.length - 1].p, pOld = pNow;
    for (var i = s.length - 1; i >= 0; i--) { if (now - s[i].t > 8000) { pOld = s[i].p; break; } }
    var chg = (pNow - pOld) / pOld;
    var pUp = 0.5 + Math.max(-0.13, Math.min(0.13, chg * 900));
    var side = Math.random() < pUp ? "up" : "down";
    r.pools[side] += Math.floor(5 + Math.pow(Math.random(), 2) * 170);
  }

  /* ---------- betting ---------- */
  function stakeValue() {
    if (S.stake === "max") return Math.max(0, Math.min(S.bal, CHIPS_MAX_CAP));
    return S.stake;
  }
  function placeBet(side) {
    var r = S.rounds[S.asset];
    if (!r || r.phase !== "bet") { beep(160, 40, "sawtooth"); return; }
    var v = stakeValue();
    if (v <= 0 || S.bal < v) { el.getpts.hidden = false; beep(160, 60, "sawtooth"); return; }
    S.bal -= v; saveBal();
    r.pools[side] += v; r.my[side] += v;
    beep(600, 30); if (navigator.vibrate) navigator.vibrate(12);
    updateBalance();
  }
  function saveBal() { localStorage.predict_bal = S.bal; }
  function updateBalance() {
    el.bal.textContent = S.bal.toLocaleString("en-US");
    el.getpts.hidden = S.bal >= 10;
  }
  el.getpts.onclick = function () {
    S.bal += 1000; saveBal(); updateBalance();
    var loans = (parseInt(localStorage.predict_bailouts || "0", 10) + 1);
    localStorage.predict_bailouts = loans;
    flyPoints("+1000 (loan #" + loans + ")", PAL.ok, "up");
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
    var w = wrap.clientWidth;
    var h = Math.max(240, Math.min(Math.round(window.innerHeight * 0.42), 400));
    DPR = window.devicePixelRatio || 1;
    cv.width = Math.round(w * DPR); cv.height = Math.round(h * DPR);
    cv.style.height = h + "px";
    W = w; H = h;
  }
  window.addEventListener("resize", resize);

  var yScale = { min: 0, max: 1, init: false };
  function draw(now) {
    var f = S.feeds[S.asset], r = S.rounds[S.asset];
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var splitX = Math.round(W * (HIST_MS / (HIST_MS + PLAY_MS)));    // 2/3

    if (!f.samples.length) {
      ctx.fillStyle = PAL["ink-dim"]; ctx.font = "bold 14px 'Courier New',monospace"; ctx.textAlign = "center";
      ctx.fillText("dialing up the price feed…", W / 2, H / 2);
      return;
    }

    // eased display price
    var last = f.samples[f.samples.length - 1].p;
    f.disp += (last - f.disp) * 0.18;

    // time window: rolling while betting, pinned to expiry while playing
    var t1 = (r && r.phase === "play") ? r.tEnd : now + PLAY_MS;
    var t0 = t1 - (HIST_MS + PLAY_MS);
    var xOf = function (t) { return (t - t0) / (t1 - t0) * W; };

    // y-scale targets: visible samples + strike, padded
    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < f.samples.length; i++) {
      var sm = f.samples[i];
      if (sm.t < t0) continue;
      if (sm.p < lo) lo = sm.p; if (sm.p > hi) hi = sm.p;
    }
    var strike = r ? (r.phase === "play" ? r.strike : f.disp) : f.disp;
    if (strike < lo) lo = strike; if (strike > hi) hi = strike;
    var pad = Math.max((hi - lo) * 0.35, strike * 0.0004);
    var tMin = lo - pad, tMax = hi + pad;
    if (!yScale.init) { yScale.min = tMin; yScale.max = tMax; yScale.init = true; }
    yScale.min += (tMin - yScale.min) * 0.1; yScale.max += (tMax - yScale.max) * 0.1;
    var yOf = function (p) { return H - (p - yScale.min) / (yScale.max - yScale.min) * H; };
    var strikeY = Math.max(26, Math.min(H - 26, yOf(strike)));

    /* future zone tiles */
    var betting = r && r.phase === "bet";
    var zones = [
      { side: "up", y0: 0, y1: strikeY, col: PAL.ok },
      { side: "down", y0: strikeY, y1: H, col: PAL.bad }
    ];
    zones.forEach(function (z) {
      var alpha = 0.10;
      if (betting && S.hover === z.side) alpha = 0.17;
      if (betting && S.press === z.side) alpha = 0.26;
      if (r && r.my[z.side] > 0) alpha += 0.05;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = z.col;
      ctx.fillRect(splitX, z.y0, W - splitX, z.y1 - z.y0);
      ctx.globalAlpha = 1;
    });

    // settle flash overlay
    if (S.flash && now - S.flash.t0 < 650 && S.flash.dir !== "tie") {
      var k = 1 - (now - S.flash.t0) / 650;
      ctx.globalAlpha = 0.35 * k;
      ctx.fillStyle = S.flash.dir === "up" ? PAL.ok : PAL.bad;
      var zy = S.flash.dir === "up" ? [0, strikeY] : [strikeY, H];
      ctx.fillRect(splitX, zy[0], W - splitX, zy[1] - zy[0]);
      ctx.globalAlpha = 1;
    }

    /* grid */
    ctx.strokeStyle = PAL["ink-dim"]; ctx.globalAlpha = 0.18; ctx.lineWidth = 1;
    ctx.font = "10px 'Courier New',monospace"; ctx.textAlign = "left";
    for (var g = 1; g <= 3; g++) {
      var gy = H * g / 4;
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
    }
    ctx.globalAlpha = 0.55; ctx.fillStyle = PAL["ink-dim"];
    for (g = 1; g <= 3; g++) {
      var gp = yScale.max - (yScale.max - yScale.min) * g / 4;
      ctx.fillText(fmt(gp), 4, H * g / 4 - 3);
    }
    ctx.globalAlpha = 1;

    /* split line */
    ctx.strokeStyle = PAL["ink-dim"]; ctx.globalAlpha = 0.4;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(splitX, 0); ctx.lineTo(splitX, H); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;

    /* strike line */
    ctx.strokeStyle = PAL.accent; ctx.lineWidth = betting ? 1.5 : 2;
    if (betting) ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(0, strikeY); ctx.lineTo(W, strikeY); ctx.stroke();
    ctx.setLineDash([]);
    // strike tag
    var tag = "@ " + fmt(strike);
    ctx.font = "bold 11px 'Courier New',monospace";
    var tw = ctx.measureText(tag).width + 10;
    ctx.fillStyle = PAL.accent;
    ctx.fillRect(splitX - tw - 4, strikeY - 9, tw, 18);
    ctx.fillStyle = "#fff"; ctx.textAlign = "center";
    ctx.fillText(tag, splitX - tw / 2 - 4, strikeY + 4);

    /* price polyline */
    ctx.strokeStyle = PAL["accent-2"]; ctx.lineWidth = 2;
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.beginPath();
    var started = false;
    for (i = 0; i < f.samples.length; i++) {
      sm = f.samples[i];
      if (sm.t < t0 - 1000) continue;
      var px = xOf(sm.t), py = yOf(sm.p);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    var headX = xOf(now), headY = yOf(f.disp);
    if (started) ctx.lineTo(headX, headY);
    ctx.stroke();

    // head glow
    ctx.fillStyle = PAL["accent-2"];
    ctx.globalAlpha = 0.25; ctx.beginPath(); ctx.arc(headX, headY, 7, 0, 7); ctx.fill();
    ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(headX, headY, 3, 0, 7); ctx.fill();

    /* zone labels */
    if (r) {
      var zx = splitX + (W - splitX) / 2;
      zones.forEach(function (z) {
        var mid = (z.y0 + z.y1) / 2;
        var m = r.phase === "play" ? r.lockMult[z.side] : mult(r, z.side);
        var arrow = z.side === "up" ? "▲ UP" : "▼ DOWN";
        ctx.textAlign = "center";
        ctx.fillStyle = z.col;
        ctx.font = "bold 13px " + PAL.comic;
        ctx.fillText(arrow, zx, mid - 22);
        ctx.font = "bold 24px 'Courier New',monospace";
        ctx.fillText("×" + m.toFixed(2), zx, mid + 2);
        ctx.font = "11px 'Courier New',monospace";
        ctx.fillStyle = PAL.ink;
        var v = stakeValue();
        if (betting && v > 0) ctx.fillText("win " + Math.floor(v * m) + " pts", zx, mid + 18);
        if (r.my[z.side] > 0) {
          ctx.fillStyle = z.col;
          ctx.fillText("YOU: " + r.my[z.side], zx, mid + 32);
        }
        ctx.fillStyle = PAL["ink-dim"];
        ctx.fillText("pool " + Math.floor(r.pools[z.side]), zx, z.y1 - 6 < mid + 40 ? z.y0 + 12 : z.y1 - 6);
      });

      // zone header
      ctx.font = "bold 10px 'Courier New',monospace"; ctx.textAlign = "center";
      ctx.fillStyle = betting ? PAL.ok : PAL.bad;
      ctx.fillText(betting ? "◄ BETS OPEN ►" : "LOCKED — SWEAT", splitX + (W - splitX) / 2, 12);
    }

    /* expiry flag while playing */
    if (r && r.phase === "play") {
      ctx.strokeStyle = PAL.ink; ctx.globalAlpha = 0.5; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(W - 1, 0); ctx.lineTo(W - 1, H); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
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
    var splitX = W * (HIST_MS / (HIST_MS + PLAY_MS));
    if (x < splitX) return null;
    var f = S.feeds[S.asset], r = S.rounds[S.asset];
    if (!r || !f.samples.length) return null;
    var strike = r.phase === "play" ? r.strike : f.disp;
    var strikeY = Math.max(26, Math.min(H - 26, H - (strike - yScale.min) / (yScale.max - yScale.min) * H));
    return y < strikeY ? "up" : "down";
  }
  function evPos(e) {
    var rct = cv.getBoundingClientRect();
    return { x: e.clientX - rct.left, y: e.clientY - rct.top };
  }
  cv.addEventListener("pointerdown", function (e) {
    var p = evPos(e), z = zoneAt(p.x, p.y);
    if (z) { S.press = z; placeBet(z); }
  });
  cv.addEventListener("pointerup", function () { S.press = null; });
  cv.addEventListener("pointermove", function (e) {
    var p = evPos(e), z = zoneAt(p.x, p.y);
    S.hover = z;
    cv.style.cursor = z && S.rounds[S.asset] && S.rounds[S.asset].phase === "bet" ? "pointer" : "default";
  });
  cv.addEventListener("pointerleave", function () { S.hover = null; S.press = null; });

  /* ---------- tabs + chips ---------- */
  $("tabs").addEventListener("click", function (e) {
    var b = e.target.closest(".tab"); if (!b) return;
    S.asset = b.dataset.asset;
    yScale.init = false;
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
      s.textContent = x.dir === "up" ? "▲" : x.dir === "down" ? "▼" : "•";
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
    } else if (r) {
      var rem = Math.max(0, r.tEnd - now), s = Math.ceil(rem / 1000);
      el.clock.textContent = Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2);
      el.rid.textContent = "ROUND #" + r.n;
      if (r.phase === "bet") { el.phase.textContent = "PLACE YOUR BETS"; el.phase.className = "phase hot"; }
      else { el.phase.textContent = "LOCKED @ " + fmt(r.strike); el.phase.className = "phase locked"; }
    }
    var fresh = now - f.lastTick < 5000;
    el.led.className = "led" + ((fresh || S.feedMode === "sim") ? " on" : "");
    el.feedlbl.textContent = S.feedMode === "sim" ? "sim·feed" : "pyth·hermes";
    if (f.disp) el.px.textContent = FEEDS[S.asset].label + " " + fmt(f.disp);
  }

  /* ---------- main loop ---------- */
  var lastFrame = performance.now();
  function frame(now) {
    var dt = now - lastFrame; lastFrame = now;
    syntheticTick(now, dt);
    assets.forEach(function (a) { stepRound(a, now); });
    draw(now);
    updateHud(now);
    requestAnimationFrame(frame);
  }

  /* ---------- boot ---------- */
  resize();
  updateBalance();
  renderHist();
  connectFeed();
  requestAnimationFrame(frame);
})();
