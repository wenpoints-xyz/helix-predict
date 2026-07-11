const { test, expect } = require("@playwright/test");

// Bound frontend tests for the PredictionBook (per-user positions) model: mock the JSON-RPC
// (markets/bookConfig/positionsOf/getPosition/houseStats/balanceOf/allowance/owed), the wallet
// (window.ethereum), and the Pyth Hermes SSE, then drive the arcade. 127.0.0.1 => testnet config.

const BOOK = "0x6ea22353f4e6be0a4d193ce7bb3f63186bdf74e3";  // PredictionBook
const VAULT = "0x745d463b01667bf15915a27c23746d6d2ad59f2b"; // HouseVault (fresh)
const POINTS = "0x52045f671c452b7f91a7e436c64f126e78638f14";
const ACCT = "0xAbC0000000000000000000000000000000001234";
const E18 = 10n ** 18n;
const FEEDS = {
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  INJ: "7a5bc1d2b56ad029048cd63964b3ad2776eadf812edc1a43a31406cb54bff592"
};
const FEED_LIST = [FEEDS.BTC, FEEDS.ETH, FEEDS.INJ];
const SEL = {
  marketsLength: "0xa5402544", markets: "0xb1283e77",
  payoutBps: "0x020f09b7", minBet: "0x9619367d", maxBet: "0x2e5b2168",
  minDur: "0x67b38200", maxDur: "0xeab50bd2", strikeDelay: "0x51fd4c2a",
  positionsOf: "0xdc9d54ef", getPosition: "0xeb02c301", owed: "0xb1276604", settleGrace: "0x12ae6491",
  voidExpired: "0xb04fe3fa", tipBps: "0xe79ce788", maxTip: "0x7b45eb36",
  balanceOf: "0x70a08231", allowance: "0xdd62ed3e",
  openBet: "0x058a345d", claim: "0x379607f5", faucet: "0x57915897", approve: "0x095ea7b3",
  houseStats: "0xaa608dbb", deposit: "0x6e553f65", withdraw: "0xb460af94", maxWithdraw: "0xce96cb77"
};

const u = (v) => BigInt(v).toString(16).padStart(64, "0");
const lastWord = (data) => BigInt("0x" + data.slice(-64)); // decode a single uint arg

// markets(i) -> (bytes32 feedId, bool enabled)
function market(i) { return "0x" + FEED_LIST[Number(i)] + u(1); }
// getPosition -> Position (11 static fields, inline)
function position(p) {
  const addr = (p.bettor || ACCT).toLowerCase().replace(/^0x/, "").padStart(64, "0");
  return "0x" + addr + u(p.marketId || 0) + u(p.payoutBps || 19500) + u(p.up ? 1 : 0) + u(p.result || 0)
    + u(p.stake || 0n) + u(p.reserve || 0n) + u(p.strikeInstant || 0) + u(p.dur || 0) + u(p.strike || 0) + u(p.close || 0);
}
// positionsOf -> (uint256[] ids, uint256 total)
function positionsOf(ids) {
  return "0x" + u(64) + u(ids.length) + u(ids.length) + ids.map((x) => u(x)).join("");
}
// houseStats() -> (bankroll,reserved,free,sharePrice)
function houseStats(bankroll, reserved, free, sharePrice) {
  return "0x" + u(bankroll) + u(reserved) + u(free) + u(sharePrice);
}

async function setup(page, opts) {
  opts = Object.assign({
    ids: [], pos: {}, balance: 0n, allowance: 0n, shares: 0n, owed: 0n,
    stats: houseStats(0n, 0n, 0n, 0n),
    cfg: { payoutBps: 19500, minBet: E18, maxBet: 2000n * E18, minDur: 5, maxDur: 300, strikeDelay: 3, settleGrace: 3600, tipBps: 100, maxTip: 5n * E18 }
  }, opts);
  let allowCalls = 0;
  await page.route((url) => url.host.includes("k8s.testnet.json-rpc"), async (route) => {
    const req = JSON.parse(route.request().postData() || "{}");
    let result = "0x" + u(0);
    if (req.method === "eth_call") {
      const to = (req.params[0].to || "").toLowerCase();
      const data = req.params[0].data || "";
      const sel = data.slice(0, 10);
      if (sel === SEL.marketsLength) result = "0x" + u(3);
      else if (sel === SEL.markets) result = market(lastWord(data));
      else if (sel === SEL.payoutBps) result = "0x" + u(opts.cfg.payoutBps);
      else if (sel === SEL.minBet) result = "0x" + u(opts.cfg.minBet);
      else if (sel === SEL.maxBet) result = "0x" + u(opts.cfg.maxBet);
      else if (sel === SEL.minDur) result = "0x" + u(opts.cfg.minDur);
      else if (sel === SEL.maxDur) result = "0x" + u(opts.cfg.maxDur);
      else if (sel === SEL.strikeDelay) result = "0x" + u(opts.cfg.strikeDelay);
      else if (sel === SEL.settleGrace) result = "0x" + u(opts.cfg.settleGrace);
      else if (sel === SEL.tipBps) result = "0x" + u(opts.cfg.tipBps);
      else if (sel === SEL.maxTip) result = "0x" + u(opts.cfg.maxTip);
      else if (sel === SEL.positionsOf) result = positionsOf(opts.ids);
      else if (sel === SEL.getPosition) { const gid = Number(lastWord(data)); result = position((opts.byId && opts.byId[gid]) || opts.pos); }
      else if (sel === SEL.owed) { const oid = Number(lastWord(data)); result = "0x" + u(opts.owedById ? (opts.owedById[oid] || 0n) : opts.owed); }
      else if (sel === SEL.houseStats) result = opts.stats;
      else if (sel === SEL.maxWithdraw) result = "0x" + u(opts.shares);
      else if (sel === SEL.balanceOf) result = "0x" + u(to === VAULT ? opts.shares : opts.balance);
      else if (sel === SEL.allowance) {
        const v = opts.allowance === "flip" ? (allowCalls++ === 0 ? 0n : (1n << 255n)) : opts.allowance;
        result = "0x" + u(v);
      }
    } else if (req.method === "eth_blockNumber") result = "0x1";
    else if (req.method === "eth_getBalance") result = "0x" + (10n ** 18n).toString(16); // 1 INJ gas
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) });
  });
  await page.addInitScript(({ ACCT, FEEDS, PT }) => {
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
    const P = {}; P[FEEDS.BTC] = "6300000000000"; P[FEEDS.ETH] = "350000000000"; P[FEEDS.INJ] = "470000000";
    window.EventSource = class {
      constructor() {
        setTimeout(() => {
          const pt = PT != null ? PT : Math.floor(Date.now() / 1000);
          const arr = Object.keys(FEEDS).map((a) => ({ id: FEEDS[a], price: { price: P[FEEDS[a]], expo: -8, publish_time: pt } }));
          if (this.onmessage) this.onmessage({ data: JSON.stringify({ parsed: arr }) });
        }, 30);
      }
      close() {}
    };
  }, { ACCT, FEEDS, PT: opts.pt != null ? opts.pt : null });
}
const sent = (page) => page.evaluate(() => window.__sent.map((t) => ({ to: (t.to || "").toLowerCase(), sel: (t.data || "").slice(0, 10) })));
async function upZoneClick(page) {
  const box = await page.locator("#cv").boundingBox();
  await page.mouse.click(box.x + box.width * 0.85, box.y + 24); // top-right = UP zone
}

test("boots to TAP UP OR DOWN once the feed has a sample", async ({ page }) => {
  await setup(page, {});
  await page.goto("/");
  await expect(page.locator("#phase")).toHaveText(/TAP UP OR DOWN/);
  await expect(page.locator("#rid")).toHaveText("BET #—");
});

test("duration button cycles 15 -> 30 -> 60", async ({ page }) => {
  await setup(page, {});
  await page.goto("/");
  await expect(page.locator("#durbtn")).toHaveText("15s");
  await page.click("#durbtn");
  await expect(page.locator("#durbtn")).toHaveText("30s");
  await page.click("#durbtn");
  await expect(page.locator("#durbtn")).toHaveText("60s");
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
  await expect(page.locator("#getpts")).toBeVisible();
  await page.click("#getpts");
  await page.waitForFunction((s) => window.__sent.some((t) => (t.data || "").startsWith(s)), SEL.faucet);
  const txs = await sent(page);
  expect(txs.find((t) => t.sel === SEL.faucet).to).toBe(POINTS);
});

test("balance renders from balanceOf once connected", async ({ page }) => {
  await setup(page, { balance: 1234n * E18 });
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#bal")).toHaveText("1,234");
});

test("tapping a zone with allowance = a single openBet() tx (no approve)", async ({ page }) => {
  await setup(page, { balance: 1000n * E18, allowance: 1n << 255n });
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#phase")).toHaveText(/TAP UP OR DOWN/);
  await upZoneClick(page);
  await page.waitForFunction((s) => window.__sent.some((t) => (t.data || "").startsWith(s)), SEL.openBet);
  const txs = await sent(page);
  expect(txs.some((t) => t.sel === SEL.approve)).toBeFalsy();
  expect(txs.find((t) => t.sel === SEL.openBet).to).toBe(BOOK);
});

test("tapping without allowance = approve() then openBet()", async ({ page }) => {
  await setup(page, { balance: 1000n * E18, allowance: "flip" });
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#phase")).toHaveText(/TAP UP OR DOWN/);
  await upZoneClick(page);
  await page.waitForFunction((s) => window.__sent.some((t) => (t.data || "").startsWith(s)), SEL.openBet);
  const txs = await sent(page);
  const iApprove = txs.findIndex((t) => t.sel === SEL.approve);
  const iOpen = txs.findIndex((t) => t.sel === SEL.openBet);
  expect(iApprove).toBeGreaterThanOrEqual(0);
  expect(iApprove).toBeLessThan(iOpen); // approve before openBet
});

test("an active position renders BET #<id> and its phase", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  // live phase: strike already locked (strikeInstant in the past), close in the future
  await setup(page, {
    ids: [4],
    pos: { bettor: ACCT, marketId: 0, up: true, result: 0, stake: 25n * E18, reserve: 24n * E18, strikeInstant: now - 5, dur: 30 }
  });
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#rid")).toHaveText("BET #4");
});

test("strike shows LOCKING… (not a jumpy number) until the exact tick confirms", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  // strikeInstant has passed, but the only streamed tick is STALE (pt before strikeInstant), so the
  // exact strike hasn't arrived -> the HUD must read LOCKING…, never a premature/jumpy price.
  await setup(page, {
    pt: now - 100,
    ids: [8],
    pos: { bettor: ACCT, marketId: 0, up: true, result: 0, stake: 25n * E18, reserve: 24n * E18, strikeInstant: now - 5, dur: 60 }
  });
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#rid")).toHaveText("BET #8");
  await expect(page.locator("#phase")).toHaveText(/LOCKING…/);
});

test("pending strip: a matured open bet shows 'settling…'", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  await setup(page, {
    ids: [3],
    pos: { bettor: ACCT, marketId: 0, up: true, result: 0, stake: 25n * E18, reserve: 24n * E18, strikeInstant: now - 40, dur: 15 } // closed 25s ago, within grace
  });
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#pending")).toBeVisible();
  await expect(page.locator("#pendingMsg")).toHaveText(/settling/);
});

test("a matured-but-unsettled bet reads SETTLING… (chart freezes at the wall)", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  await setup(page, {
    ids: [3],
    pos: { bettor: ACCT, marketId: 0, up: true, result: 0, stake: 25n * E18, reserve: 24n * E18, strikeInstant: now - 40, dur: 15 } // closed 25s ago, keeper not yet settled
  });
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#rid")).toHaveText("BET #3");
  await expect(page.locator("#phase")).toHaveText(/SETTLING…/);
});

test("pending strip: unclaimed winnings show CLAIM and fire claim()", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  await setup(page, {
    ids: [6], owed: 195n * E18,
    pos: { bettor: ACCT, marketId: 0, up: true, result: 1, stake: 100n * E18, strikeInstant: now - 60, dur: 15, strike: 100, close: 200 } // WIN, owed 195
  });
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#pendingMsg")).toHaveText(/ready to claim/);
  await page.click("#pendingBtn");
  await page.waitForFunction((s) => window.__sent.some((t) => (t.data || "").startsWith(s)), SEL.claim);
  const txs = await sent(page);
  expect(txs.find((t) => t.sel === SEL.claim).to).toBe(BOOK);
});

test("pending strip: a bet past grace shows REFUND and fires voidExpired()", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  await setup(page, {
    ids: [7],
    pos: { bettor: ACCT, marketId: 0, up: true, result: 0, stake: 25n * E18, reserve: 24n * E18, strikeInstant: now - 5000, dur: 15 } // closed >1h ago (past grace)
  });
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#pendingMsg")).toHaveText(/stuck/);
  await page.click("#pendingBtn");
  await page.waitForFunction((s) => window.__sent.some((t) => (t.data || "").startsWith(s)), SEL.voidExpired);
  const txs = await sent(page);
  expect(txs.find((t) => t.sel === SEL.voidExpired).to).toBe(BOOK);
});

test("my stats modal: net P&L, win rate, record from positionsOf", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  await setup(page, {
    ids: [1, 2],
    byId: {
      1: { bettor: ACCT, marketId: 0, up: true, result: 1, stake: 100n * E18, payoutBps: 19500, strikeInstant: now - 100, dur: 15, strike: 100, close: 200 }, // WIN: net = 195 - 1(tip) - 100 = +94
      2: { bettor: ACCT, marketId: 1, up: false, result: 2, stake: 50n * E18, payoutBps: 19500, strikeInstant: now - 200, dur: 30, strike: 200, close: 300 } // LOSS: -50
    }
  });
  await page.goto("/");
  await page.click("#connect");
  await page.click("#statsbtn");
  const m = page.locator("#statsmodal");
  await expect(m.getByText("MY STATS")).toBeVisible();
  await expect(m.getByText("NET P&L")).toBeVisible();
  await expect(m.getByText("+44", { exact: false })).toBeVisible(); // 94 win − 50 loss
  await expect(m.getByText("1W 1L 0V")).toBeVisible();
  await expect(m.getByText("50%")).toBeVisible();
});

test("bet history modal: lists results and claims an unclaimed win", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  await setup(page, {
    ids: [6, 7],
    byId: {
      6: { bettor: ACCT, marketId: 0, up: true, result: 1, stake: 100n * E18, payoutBps: 19500, strikeInstant: now - 90, dur: 15, strike: 100, close: 200 }, // WON
      7: { bettor: ACCT, marketId: 1, up: false, result: 2, stake: 25n * E18, payoutBps: 19500, strikeInstant: now - 200, dur: 30, strike: 200, close: 300 } // LOST
    },
    owedById: { 6: 195n * E18, 7: 0n }
  });
  await page.goto("/");
  await page.click("#connect");
  await page.click("#histbtn");
  const modal = page.locator("#histmodal");
  await expect(modal.getByText("won", { exact: true })).toBeVisible();
  await expect(modal.getByText("lost", { exact: true })).toBeVisible();
  const claim = modal.getByRole("button", { name: "CLAIM" });
  await expect(claim).toBeVisible();
  await claim.click();
  await page.waitForFunction((s) => window.__sent.some((t) => (t.data || "").startsWith(s)), SEL.claim);
  const txs = await sent(page);
  expect(txs.find((t) => t.sel === SEL.claim).to).toBe(BOOK);
});

test("LP panel: shows bankroll from houseStats and deposits to the vault", async ({ page }) => {
  await setup(page, {
    balance: 1000n * E18, allowance: "flip", shares: 0n,
    stats: houseStats(100000n * E18, 5000n * E18, 95000n * E18, 1000000000000n)
  });
  await page.goto("/");
  await page.click("#connect");
  await page.click("#lpToggle");
  await expect(page.locator("#lpBank")).toHaveText("100,000");
  await expect(page.locator("#lpUtil")).toHaveText("5.0%");
  await page.fill("#lpAmt", "500");
  await page.click("#lpDep");
  await page.waitForFunction((s) => window.__sent.some((t) => (t.data || "").startsWith(s)), SEL.deposit);
  const txs = await sent(page);
  expect(txs.some((t) => t.sel === SEL.approve)).toBeTruthy();
  expect(txs.find((t) => t.sel === SEL.deposit).to).toBe(VAULT);
});

test("BE THE HOUSE toggles the LP panel (hidden by default)", async ({ page }) => {
  await setup(page, {});
  await page.goto("/");
  await expect(page.locator("#lp")).toBeHidden();
  await page.click("#lpToggle");
  await expect(page.locator("#lp")).toBeVisible();
  await expect(page.locator("#lpToggle")).toHaveText(/▾/);
  await page.click("#lpToggle");
  await expect(page.locator("#lp")).toBeHidden();
});

test("wallet connection survives a reload (silent reconnect)", async ({ page }) => {
  await setup(page, {});
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#connect")).toContainText("0xAbC0");
  await page.reload();
  await expect(page.locator("#connect")).toContainText("0xAbC0");
});
