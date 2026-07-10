const { test, expect } = require("@playwright/test");

// Bound frontend tests: mock the JSON-RPC (boardSnapshot/myPositions/balanceOf/allowance),
// the wallet (window.ethereum), and the Pyth Hermes SSE, then drive the arcade. 127.0.0.1 => testnet config.

const POOL = "0xe7773db880bf38574441699a60e53d68a52db680";   // PredictionHouse
const VAULT = "0x15fc2a0020a2a8309e602fc7b148b120c9c3b587";  // HouseVault
const POINTS = "0x52045f671c452b7f91a7e436c64f126e78638f14";
const ACCT = "0xAbC0000000000000000000000000000000001234";
const E18 = 10n ** 18n;
const FEEDS = {
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  INJ: "7a5bc1d2b56ad029048cd63964b3ad2776eadf812edc1a43a31406cb54bff592"
};
const MK = [["BTC", 15], ["ETH", 15], ["INJ", 15]]; // live markets are BTC/ETH/INJ at 15s
const SEL = { board: "0x938be1ab", myPos: "0x98a973bb", balanceOf: "0x70a08231", allowance: "0xdd62ed3e", bet: "0x8decaec0", claim: "0x379607f5", faucet: "0x57915897", approve: "0x095ea7b3", houseStats: "0xaa608dbb", deposit: "0x6e553f65", withdraw: "0xb460af94", maxWithdraw: "0xce96cb77" };

const u = (v) => BigInt(v).toString(16).padStart(64, "0");

// encode RoundInfo[] (dynamic array of a 16-field static struct; house adds payoutBps)
function encodeBoard(list) {
  let body = u(list.length);
  for (const m of list) {
    body += u(m.marketId) + m.feedId + u(m.timeframe) + u(m.marketEnabled ? 1 : 0) + u(m.hasRound ? 1 : 0)
      + u(m.roundId || 0) + u(m.lockTime || 0) + u(m.expiryTime || 0) + u(m.strike || 0) + u(m.close || 0)
      + u(m.upPool || 0n) + u(m.downPool || 0n) + u(m.payoutBps || 0) + u(m.state || 0) + u(m.upWon ? 1 : 0) + u(m.voided ? 1 : 0);
  }
  return "0x" + u(32) + body;
}
function board(rounds) {
  return encodeBoard(MK.map((mk, i) => {
    const r = (rounds && rounds[i]) || {};
    return {
      marketId: i, feedId: FEEDS[mk[0]], timeframe: mk[1], marketEnabled: true,
      hasRound: !!r.hasRound, roundId: r.roundId || 0, lockTime: r.lockTime || 0, expiryTime: r.expiryTime || 0,
      strike: r.strike || 0, close: r.close || 0, upPool: r.upPool || 0n, downPool: r.downPool || 0n,
      payoutBps: r.payoutBps != null ? r.payoutBps : (r.hasRound ? 19500 : 0),
      state: r.state || 0, upWon: !!r.upWon, voided: !!r.voided
    };
  }));
}
// house LP: houseStats() -> (bankroll,reserved,free,sharePrice)
function houseStats(bankroll, reserved, free, sharePrice) {
  return "0x" + u(bankroll) + u(reserved) + u(free) + u(sharePrice);
}
// encode (uint256[] up, uint256[] down, uint256[] claimable, bool[] didClaim)
function positions(up, down, claim, dc) {
  const arr = (a) => u(a.length) + a.map((x) => u(x)).join("");
  const a1 = arr(up), a2 = arr(down), a3 = arr(claim), a4 = arr(dc.map((b) => (b ? 1 : 0)));
  const o1 = 4 * 32, o2 = o1 + a1.length / 2, o3 = o2 + a2.length / 2, o4 = o3 + a3.length / 2;
  return "0x" + u(o1) + u(o2) + u(o3) + u(o4) + a1 + a2 + a3 + a4;
}

async function setup(page, opts) {
  opts = Object.assign({ board: board(), positions: positions([], [], [], []), balance: 0n, allowance: 0n, shares: 0n, stats: houseStats(0n, 0n, 0n, 0n) }, opts);
  let allowCalls = 0;
  await page.route((url) => url.host.includes("k8s.testnet.json-rpc"), async (route) => {
    const req = JSON.parse(route.request().postData() || "{}");
    let result = "0x" + u(0);
    if (req.method === "eth_call") {
      const to = (req.params[0].to || "").toLowerCase();
      const sel = (req.params[0].data || "").slice(0, 10);
      if (sel === SEL.board) result = opts.board;
      else if (sel === SEL.myPos) result = opts.positions;
      else if (sel === SEL.houseStats) result = opts.stats;
      else if (sel === SEL.maxWithdraw) result = "0x" + u(opts.shares);
      else if (sel === SEL.balanceOf) result = "0x" + u(to === VAULT ? opts.shares : opts.balance);
      else if (sel === SEL.allowance) {
        // "flip": first check reads 0 (forces approve), later reads high (approve "landed")
        const v = opts.allowance === "flip" ? (allowCalls++ === 0 ? 0n : (1n << 255n)) : opts.allowance;
        result = "0x" + u(v);
      }
    } else if (req.method === "eth_blockNumber") result = "0x1";
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) });
  });
  await page.addInitScript(({ ACCT, FEEDS }) => {
    const cbs = {}; window.__sent = [];
    window.ethereum = {
      isMetaMask: true,
      request: async ({ method, params }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [ACCT];
        if (method === "eth_chainId") return "0x59f";
        if (method === "eth_sendTransaction") { window.__sent.push(params[0]); return "0x" + "de".repeat(32); }
        return null;
      },
      on(ev, cb) { cbs[ev] = cb; }
    };
    // Pyth Hermes SSE stub: emit one price per feed so the chart has samples
    const P = {}; P[FEEDS.BTC] = "6300000000000"; P[FEEDS.ETH] = "350000000000"; P[FEEDS.INJ] = "470000000";
    window.EventSource = class {
      constructor() {
        setTimeout(() => {
          const arr = Object.keys(FEEDS).map((a) => ({ id: FEEDS[a], price: { price: P[FEEDS[a]], expo: -8 } }));
          if (this.onmessage) this.onmessage({ data: JSON.stringify({ parsed: arr }) });
        }, 30);
      }
      close() {}
    };
  }, { ACCT, FEEDS });
}
const sent = (page) => page.evaluate(() => window.__sent.map((t) => ({ to: (t.to || "").toLowerCase(), sel: (t.data || "").slice(0, 10) })));
async function upZoneClick(page) {
  const box = await page.locator("#cv").boundingBox();
  await page.mouse.click(box.x + box.width * 0.85, box.y + 24); // top-right = UP zone
}

test("board loads; shows WAITING FOR ROUND when none are open", async ({ page }) => {
  await setup(page, {});
  await page.goto("/");
  await expect(page.locator("#phase")).toHaveText(/WAITING FOR ROUND/);
});

test("a live open round renders PLACE YOUR BETS with its id", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  await setup(page, { board: board({ 0: { hasRound: true, roundId: 7, state: 0, lockTime: now + 40, expiryTime: now + 70, upPool: 100n * E18, downPool: 50n * E18 } }) });
  await page.goto("/");
  await expect(page.locator("#rid")).toHaveText("ROUND #7");
  await expect(page.locator("#phase")).toHaveText(/PLACE YOUR BETS/);
});

test("connecting a wallet shows the account", async ({ page }) => {
  await setup(page, {});
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#connect")).toContainText("0xAbC0");
});

test("faucet sends a faucet() tx to the points token", async ({ page }) => {
  await setup(page, { balance: 5n * E18 });
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#getpts")).toBeVisible(); // bal<10 -> faucet cta shows
  await page.click("#getpts");
  await page.waitForFunction((s) => window.__sent.some((t) => (t.data || "").startsWith(s)), SEL.faucet);
  const txs = await sent(page);
  const f = txs.find((t) => t.sel === SEL.faucet);
  expect(f.to).toBe(POINTS);
});

test("bet with allowance = a single bet() tx (no approve)", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  await setup(page, {
    balance: 1000n * E18, allowance: 1n << 255n,
    board: board({ 0: { hasRound: true, roundId: 3, state: 0, lockTime: now + 40, expiryTime: now + 70, upPool: 100n * E18, downPool: 100n * E18 } })
  });
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#phase")).toHaveText(/PLACE YOUR BETS/);
  await upZoneClick(page);
  await page.waitForFunction((s) => window.__sent.some((t) => (t.data || "").startsWith(s)), SEL.bet);
  const txs = await sent(page);
  expect(txs.some((t) => t.sel === SEL.approve)).toBeFalsy(); // allowance ok -> no approve
  expect(txs.find((t) => t.sel === SEL.bet).to).toBe(POOL);
});

test("bet without allowance = approve() then bet()", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  await setup(page, {
    balance: 1000n * E18, allowance: "flip",
    board: board({ 0: { hasRound: true, roundId: 3, state: 0, lockTime: now + 40, expiryTime: now + 70, upPool: 100n * E18, downPool: 100n * E18 } })
  });
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#phase")).toHaveText(/PLACE YOUR BETS/);
  await upZoneClick(page);
  await page.waitForFunction((s) => window.__sent.some((t) => (t.data || "").startsWith(s)), SEL.bet);
  const txs = await sent(page);
  const iApprove = txs.findIndex((t) => t.sel === SEL.approve);
  const iBet = txs.findIndex((t) => t.sel === SEL.bet);
  expect(iApprove).toBeGreaterThanOrEqual(0);
  expect(iApprove).toBeLessThan(iBet); // approve before bet
});

test("balance renders from balanceOf once connected", async ({ page }) => {
  await setup(page, { balance: 1234n * E18 });
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#bal")).toHaveText("1,234");
});

test("LP panel: shows bankroll from houseStats and sends a deposit to the vault", async ({ page }) => {
  await setup(page, {
    balance: 1000n * E18, allowance: "flip", shares: 0n,
    stats: houseStats(100000n * E18, 5000n * E18, 95000n * E18, 1000000000000n) // bankroll 100k, 5% in play
  });
  await page.goto("/");
  await page.click("#connect");
  await page.click("#lpToggle"); // open "BE THE HOUSE"
  await expect(page.locator("#lpBank")).toHaveText("100,000");
  await expect(page.locator("#lpUtil")).toHaveText("5.0%");
  await page.fill("#lpAmt", "500");
  await page.click("#lpDep");
  await page.waitForFunction((s) => window.__sent.some((t) => (t.data || "").startsWith(s)), SEL.deposit);
  const txs = await sent(page);
  expect(txs.some((t) => t.sel === SEL.approve)).toBeTruthy(); // approved points to the vault first
  expect(txs.find((t) => t.sel === SEL.deposit).to).toBe(VAULT); // deposit lands on the vault
});

/* ---------- empty-round roll-through (no fake lock) ---------- */

const emptyPastLock = (now, id) => board({ 0: { hasRound: true, roundId: id != null ? id : 9, state: 0, lockTime: now - 5, expiryTime: now + 10, upPool: 0n, downPool: 0n } });

test("empty round past lockTime rolls: NO BETS label, no clock, tap fires no tx", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  await setup(page, { board: emptyPastLock(now), balance: 100n * E18, allowance: 1n << 255n });
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#phase")).toHaveText(/NO BETS — NEXT ROUND SOON/);
  await expect(page.locator("#clock")).toHaveText("—");
  await upZoneClick(page);
  await page.waitForTimeout(500);
  const txs = await sent(page);
  expect(txs.some((t) => t.sel === SEL.bet)).toBeFalsy(); // disabled tiles: tap does nothing
});

test("my own position suppresses NO BETS on a stale empty board", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  await setup(page, {
    board: emptyPastLock(now),
    positions: positions([25n * E18], [0n], [0n], [false]) // I bet 25 UP; board pools stale at 0
  });
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#phase")).toHaveText(/LOCKING…/); // pending-lock view, never "NO BETS"
});

test("roll transitions straight to next round's betting — LOCKED never rendered", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  await setup(page, { board: emptyPastLock(now) });
  await page.goto("/");
  await expect(page.locator("#phase")).toHaveText(/NO BETS/);
  await page.evaluate(() => {
    window.__phases = [];
    const el = document.getElementById("phase");
    new MutationObserver(() => window.__phases.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  });
  const fresh = board({ 0: { hasRound: true, roundId: 10, state: 0, lockTime: now + 12, expiryTime: now + 27, upPool: 0n, downPool: 0n } });
  await page.route((url) => url.host.includes("k8s.testnet.json-rpc"), async (route) => {
    const req = JSON.parse(route.request().postData() || "{}");
    if (req.method === "eth_call" && (req.params[0].data || "").startsWith(SEL.board)) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: req.id, result: fresh }) });
    } else await route.fallback();
  });
  await expect(page.locator("#phase")).toHaveText(/PLACE YOUR BETS/);
  await expect(page.locator("#rid")).toHaveText("ROUND #10");
  const phases = await page.evaluate(() => window.__phases);
  expect(phases.some((p) => /LOCK/.test(p))).toBeFalsy(); // no fake-lock flap in between
});

test("roll persisting >10s escalates to waiting copy", async ({ page }) => {
  test.setTimeout(30000);
  const now = Math.floor(Date.now() / 1000);
  await setup(page, { board: emptyPastLock(now) });
  await page.goto("/");
  await expect(page.locator("#phase")).toHaveText(/NO BETS — NEXT ROUND SOON/);
  await expect(page.locator("#phase")).toHaveText(/WAITING FOR NEXT ROUND/, { timeout: 15000 });
});

test("regression: non-empty round past lockTime still shows the pending-lock view", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  await setup(page, { board: board({ 0: { hasRound: true, roundId: 11, state: 0, lockTime: now - 3, expiryTime: now + 12, upPool: 40n * E18, downPool: 0n } }) });
  await page.goto("/");
  await expect(page.locator("#phase")).toHaveText(/LOCKING…/);
});
