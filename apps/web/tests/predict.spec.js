const { test, expect } = require("@playwright/test");

// Bound frontend tests for the PredictionBook (per-user positions) model: mock the JSON-RPC
// (markets/bookConfig/positionsOf/getPosition/houseStats/balanceOf/allowance/owed), the wallet
// (window.ethereum), and the Pyth Hermes SSE, then drive the arcade. 127.0.0.1 => testnet config.

const BOOK = "0x2cfe1841f28256282f7904c0ee56d18fff437a3d";  // PredictionBook (session-key openBetFor)
const VAULT = "0x58ab94cb3a5cab117a32019cd3d1f7bf01bcb541"; // HouseVault (fresh, wired to the new Book)
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
  maxBetExposureBps: "0x6faa2d3a", maxAggExposureBps: "0xd2b4eda2",
  balanceOf: "0x70a08231", allowance: "0xdd62ed3e",
  openBet: "0x058a345d", claim: "0x379607f5", faucet: "0x57915897", approve: "0x095ea7b3",
  houseStats: "0xaa608dbb", deposit: "0x6e553f65", withdraw: "0xb460af94", maxWithdraw: "0xce96cb77",
  openBetFor: "0x804f7759", grantSession: "0x65cb5614", revokeSession: "0xc4605d8c", sessions: "0x431a1b97",
  claimMany: "0x925489a8", openCost: "0x5073a663"
};
const OPEN_COST = 11500000000000000n; // ~0.0115 INJ, v3 settle-fee escrow (mock openCost())
// A known session key used by the auto-bet tests: priv -> derived EOA address (matches session.js).
const SESS_PRIV = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const SESS_ADDR = "0x639d6caadb5617d324c1ad0becb16262fc58ce5f";
// sessions(bettor) -> (address key, uint64 expiry, uint128 maxSpend, uint128 spent)  [v3: no maxStake]
function sessionsResult(s) {
  s = s || {};
  const key = (s.key || "0x0000000000000000000000000000000000000000").toLowerCase().replace(/^0x/, "").padStart(64, "0");
  return "0x" + key + u(s.expiry || 0) + u(s.maxSpend || 0n) + u(s.spent || 0n);
}

const u = (v) => BigInt(v).toString(16).padStart(64, "0");
const lastWord = (data) => BigInt("0x" + data.slice(-64)); // decode a single uint arg

// markets(i) -> (bytes32 feedId, bool enabled)
function market(i) { return "0x" + FEED_LIST[Number(i)] + u(1); }
// getPosition -> Position (12 static fields, inline; +feeEscrow in v3)
function position(p) {
  const addr = (p.bettor || ACCT).toLowerCase().replace(/^0x/, "").padStart(64, "0");
  return "0x" + addr + u(p.marketId || 0) + u(p.payoutBps || 19500) + u(p.up ? 1 : 0) + u(p.result || 0)
    + u(p.stake || 0n) + u(p.reserve || 0n) + u(p.strikeInstant || 0) + u(p.dur || 0) + u(p.strike || 0) + u(p.close || 0)
    + u(p.feeEscrow || 0n);
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
    stats: houseStats(1000000n * E18, 0n, 1000000n * E18, 1000000000000n), // funded house so bets pass pre-flight by default
    cfg: { payoutBps: 19500, minBet: E18, maxBet: 2000n * E18, minDur: 5, maxDur: 300, strikeDelay: 3, settleGrace: 3600, tipBps: 100, maxTip: 5n * E18, maxBetExposureBps: 500, maxAggExposureBps: 3000 }
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
      else if (sel === SEL.maxBetExposureBps) result = "0x" + u(opts.cfg.maxBetExposureBps);
      else if (sel === SEL.maxAggExposureBps) result = "0x" + u(opts.cfg.maxAggExposureBps);
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
      else if (sel === SEL.sessions) result = sessionsResult(opts.session);
      else if (sel === SEL.openCost) result = "0x" + u(OPEN_COST);
    } else if (req.method === "eth_blockNumber") result = "0x1";
    else if (req.method === "eth_getBalance") result = "0x" + (opts.sessionGas != null ? opts.sessionGas : 10n ** 18n).toString(16); // INJ gas (1 INJ default)
    else if (req.method === "eth_gasPrice") result = "0x" + (1000000000n).toString(16); // 1 gwei
    else if (req.method === "eth_getTransactionCount") result = "0x0";
    else if (req.method === "eth_sendRawTransaction") {
      if (opts.rawFail) {
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "insufficient funds for gas * price + value" } }) });
        return;
      }
      result = "0x" + "ab".repeat(32);
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) });
  });
  await page.addInitScript(({ ACCT, FEEDS, PT, REVERT, SESS }) => {
    const cbs = {}; window.__sent = [];
    if (SESS) { try { localStorage.setItem(SESS.skey, SESS.priv); } catch (e) {} } // seed a known session key
    window.ethereum = {
      isMetaMask: true,
      request: async ({ method, params }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [ACCT];
        if (method === "eth_chainId") return "0x59f";
        if (method === "eth_sendTransaction") {
          window.__sent.push(params[0]);
          if (REVERT) { const er = new Error("execution reverted"); er.code = 3; er.data = REVERT; throw er; }
          return "0x" + "de".repeat(32);
        }
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
  }, { ACCT, FEEDS, PT: opts.pt != null ? opts.pt : null, REVERT: opts.txRevert || null,
       SESS: opts.sessionPriv ? { skey: "px-session:test:" + ACCT.toLowerCase(), priv: opts.sessionPriv } : null });
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

test("MAX stake is clamped to the house's per-bet cap, not just balance", async ({ page }) => {
  // house 19,000 LP, 5% cap, 1.95x -> max bet = 19000*0.05/0.95 = 1,000 pts; balance is huge
  await setup(page, { balance: 1000000n * E18, allowance: 1n << 255n, stats: houseStats(19000n * E18, 0n, 19000n * E18, 1000000000000n) });
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#phase")).toHaveText(/TAP UP OR DOWN/);
  await page.click('.chip[data-v="max"]');
  await page.waitForTimeout(400); // let a poll cache S.house
  await upZoneClick(page);
  await page.waitForFunction((s) => window.__sent.some((t) => (t.data || "").startsWith(s)), SEL.openBet);
  const stake = await page.evaluate((s) => {
    const t = window.__sent.find((x) => (x.data || "").startsWith(s));
    return BigInt("0x" + t.data.slice(10 + 128, 10 + 192)).toString(); // 3rd arg = stake
  }, SEL.openBet);
  expect(stake).toBe((1000n * (10n ** 18n)).toString()); // clamped to 1,000, not the 1,000,000 balance
});

test("pre-flight: a bet over the house's per-bet cap is blocked with a precise message (no tx)", async ({ page }) => {
  // tiny house (100 pts, 5% cap = 5 pts exposure); default 25-stake reserves 23.75 > cap -> blocked before signing
  await setup(page, { balance: 1000n * E18, allowance: 1n << 255n, stats: houseStats(100n * E18, 0n, 100n * E18, 1000000000000n) });
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#phase")).toHaveText(/TAP UP OR DOWN/);
  await upZoneClick(page);
  await expect(page.getByText(/Too big for the house/)).toBeVisible();
  const txs = await sent(page);
  expect(txs.some((t) => t.sel === SEL.openBet)).toBeFalsy(); // never sent — caught client-side
});

test("a contract revert maps to a plain-language message (not 'Bet failed')", async ({ page }) => {
  // openBet reverts with AggCapExceeded selector -> user sees the human message, not the raw error
  await setup(page, { balance: 1000n * E18, allowance: 1n << 255n, txRevert: "0x137b0798" });
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#phase")).toHaveText(/TAP UP OR DOWN/);
  await upZoneClick(page);
  await expect(page.getByText(/The house is full right now/)).toBeVisible();
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
    ids: [6], owed: 195n * E18, sessionGas: 0n, // no funded session key -> manual user, claim via wallet
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
    owedById: { 6: 195n * E18, 7: 0n }, sessionGas: 0n // no funded session key -> manual user, claim via wallet
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

// ---- session-key auto-bet ----
test("auto-bet: a live session grant lights the ⚡ button (granted status)", async ({ page }) => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  await setup(page, {
    balance: 1000n * E18, allowance: (1n << 255n), sessionPriv: SESS_PRIV,
    session: { key: SESS_ADDR, expiry: future, maxSpend: 1000n * E18, spent: 0n }
  });
  await page.goto("/");
  await page.click("#connect");
  // refreshAuto derives the key from localStorage, reads sessions(), and lights the button green
  await expect.poll(() => page.evaluate(() => document.getElementById("autobtn").style.color)).not.toBe("");
});

test("auto-bet: with a grant, tapping fires openBetFor as a raw tx (NO wallet popup)", async ({ page }) => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  await setup(page, {
    balance: 1000n * E18, allowance: (1n << 255n), sessionPriv: SESS_PRIV,
    session: { key: SESS_ADDR, expiry: future, maxSpend: 1000n * E18, spent: 0n }
  });
  await page.goto("/");
  await page.click("#connect");
  await expect.poll(() => page.evaluate(() => document.getElementById("autobtn").style.color)).not.toBe("");
  const rawReq = page.waitForRequest((r) => r.url().includes("k8s.testnet") && (r.postData() || "").includes("eth_sendRawTransaction"));
  await upZoneClick(page);
  await rawReq; // the bet went out as a locally-signed raw tx
  const txs = await sent(page);
  expect(txs.find((t) => t.sel === SEL.openBet)).toBeUndefined(); // never touched the wallet
});

test("auto-bet: a pre-broadcast gas shortfall falls back to a wallet openBet (exactly one bet)", async ({ page }) => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  await setup(page, {
    balance: 1000n * E18, allowance: (1n << 255n), sessionPriv: SESS_PRIV, sessionGas: 0n, rawFail: true,
    session: { key: SESS_ADDR, expiry: future, maxSpend: 1000n * E18, spent: 0n }
  });
  await page.goto("/");
  await page.click("#connect");
  await expect.poll(() => page.evaluate(() => document.getElementById("autobtn").style.color)).not.toBe("");
  await upZoneClick(page);
  // raw send errors with "insufficient funds" -> catch-and-retry lands one wallet openBet
  await page.waitForFunction((s) => window.__sent.some((t) => (t.data || "").startsWith(s)), SEL.openBet);
  const txs = await sent(page);
  expect(txs.filter((t) => t.sel === SEL.openBet).length).toBe(1); // one bet, no double-fire
});

test("auto-bet: TOP UP BUDGET re-grants the SAME key with (budget left + added) as the new maxSpend", async ({ page }) => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  await setup(page, {
    balance: 1000n * E18, allowance: (1n << 255n), sessionPriv: SESS_PRIV,
    session: { key: SESS_ADDR, expiry: future, maxSpend: 1000n * E18, spent: 200n * E18 } // 800 left
  });
  await page.goto("/");
  await page.click("#connect");
  await expect.poll(() => page.evaluate(() => document.getElementById("autobtn").style.color)).not.toBe("");
  await page.click("#autobtn"); // grant is live -> the ⚡ modal opens on the STATUS view
  const modal = page.locator("#automodal");
  await modal.locator("input").first().fill("500");
  await modal.getByRole("button", { name: /ADD/ }).click();
  // grantSession goes out via the wallet; new maxSpend = 800 (left) + 500 = 1300, SAME key
  await page.waitForFunction((s) => window.__sent.some((t) => (t.data || "").startsWith(s)), SEL.grantSession);
  const g = (await page.evaluate(() => window.__sent.map((t) => t.data || ""))).find((d) => d.startsWith(SEL.grantSession));
  expect(g).toBeTruthy();
  expect(g.slice(10, 74).slice(-40)).toBe(SESS_ADDR.replace(/^0x/, "")); // key unchanged
  expect(BigInt("0x" + g.slice(-64))).toBe(1300n * E18);                 // maxSpend = left + added
});


// ---- auto-claim (session key) ----
// Decode the nonce out of a signed legacy tx (RLP list: [nonce, gasPrice, ...]). Small nonces only.
function txNonce(raw) {
  const h = raw.replace(/^0x/, "");
  let b0 = parseInt(h.substr(0, 2), 16), i = 2;
  if (b0 >= 0xf8) i += (b0 - 0xf7) * 2; // skip the list length-of-length bytes
  const n0 = parseInt(h.substr(i, 2), 16);
  if (n0 === 0x80) return 0;            // empty string -> 0
  if (n0 < 0x80) return n0;             // single low byte is its own value
  return parseInt(h.substr(i + 2, (n0 - 0x80) * 2), 16); // string of (n0-0x80) bytes
}
function rawSendCollector(page) {
  const raws = [];
  page.on("request", (req) => {
    const pd = req.postData();
    if (pd && pd.indexOf("eth_sendRawTransaction") !== -1) { try { raws.push(JSON.parse(pd).params[0]); } catch (e) {} }
  });
  return raws;
}
const CLAIM_SEL = "379607f5"; // claim(uint256) selector, embedded in the raw calldata

test("auto-claim: a funded session key claims a win via raw tx (no wallet popup)", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  const raws = rawSendCollector(page);
  await setup(page, {
    sessionPriv: SESS_PRIV, sessionGas: 10n ** 18n, ids: [6], owed: 195n * E18, // funded key -> auto-claim
    pos: { bettor: ACCT, marketId: 0, up: true, result: 1, stake: 100n * E18, strikeInstant: now - 60, dur: 15, strike: 100, close: 200 }
  });
  await page.goto("/");
  await page.click("#connect");
  await expect.poll(() => raws.some((r) => r.indexOf(CLAIM_SEL) !== -1)).toBeTruthy(); // claim went out as a raw tx
  const txs = await sent(page);
  expect(txs.find((t) => t.sel === SEL.claim)).toBeUndefined(); // never via the wallet
});

test("auto-claim: a manual user (no funded key) does NOT auto-claim; the win waits in the strip", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  const raws = rawSendCollector(page);
  await setup(page, {
    sessionGas: 0n, ids: [6], owed: 195n * E18, // no funded key -> manual, no auto-claim
    pos: { bettor: ACCT, marketId: 0, up: true, result: 1, stake: 100n * E18, strikeInstant: now - 60, dur: 15, strike: 100, close: 200 }
  });
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#pendingMsg")).toHaveText(/ready to claim/); // surfaced, not auto-claimed
  await page.waitForTimeout(1500);
  const txs = await sent(page);
  expect(txs.find((t) => t.sel === SEL.claim)).toBeUndefined(); // no wallet auto-claim
  expect(raws.some((r) => r.indexOf(CLAIM_SEL) !== -1)).toBeFalsy(); // no raw auto-claim either
});

test("auto-claim: bet + claim from one session key get DISTINCT nonces (serialize queue)", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  const future = now + 3600;
  const raws = rawSendCollector(page);
  await setup(page, {
    sessionPriv: SESS_PRIV, sessionGas: 10n ** 18n, balance: 1000n * E18, allowance: (1n << 255n),
    session: { key: SESS_ADDR, expiry: future, maxSpend: 1000n * E18, spent: 0n },
    ids: [6], owed: 195n * E18, // a settled win -> auto-claim fires concurrently with the tap-bet
    pos: { bettor: ACCT, marketId: 0, up: true, result: 1, stake: 100n * E18, strikeInstant: now - 60, dur: 15, strike: 100, close: 200 }
  });
  await page.goto("/");
  await page.click("#connect");
  await expect.poll(() => page.evaluate(() => document.getElementById("autobtn").style.color)).not.toBe("");
  await upZoneClick(page); // a bet, while the auto-claim is also firing
  await expect.poll(() => raws.length).toBeGreaterThanOrEqual(2); // at least the bet + the claim went out
  const nonces = raws.map(txNonce);
  expect(new Set(nonces).size).toBe(nonces.length); // every raw send has a UNIQUE nonce (no collision)
});

// ---- v3 fee escrow (frontend) ----
test("v3: a wallet bet attaches the INJ oracle-fee escrow (value >= openCost)", async ({ page }) => {
  await setup(page, { balance: 1000n * E18, allowance: (1n << 255n), sessionGas: 0n }); // manual -> wallet openBet
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#feeline")).toContainText(/oracle fee/); // fee line shows
  await upZoneClick(page);
  await page.waitForFunction((s) => window.__sent.some((t) => (t.data || "").startsWith(s)), SEL.openBet);
  const sent = await page.evaluate(() => window.__sent.map((t) => ({ sel: (t.data || "").slice(0, 10), value: t.value || "0x0" })));
  const bet = sent.find((t) => t.sel === SEL.openBet);
  expect(BigInt(bet.value) >= OPEN_COST).toBeTruthy(); // attached at least openCost (over-attached ~1.15x)
});

test("v3: CASH OUT ALL claims multiple wins in ONE claimMany tx", async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  await setup(page, {
    ids: [6, 7], sessionGas: 0n, owedById: { 6: 195n * E18, 7: 195n * E18 },
    byId: {
      6: { bettor: ACCT, marketId: 0, up: true, result: 1, stake: 100n * E18, strikeInstant: now - 60, dur: 15, strike: 100, close: 200 },
      7: { bettor: ACCT, marketId: 0, up: true, result: 1, stake: 100n * E18, strikeInstant: now - 60, dur: 15, strike: 100, close: 200 }
    }
  });
  await page.goto("/");
  await page.click("#connect");
  await expect(page.locator("#pendingMsg")).toHaveText(/ready to claim/);
  await page.click("#pendingBtn");
  await page.waitForFunction((s) => window.__sent.some((t) => (t.data || "").startsWith(s)), SEL.claimMany);
  const txs = await page.evaluate(() => window.__sent.map((t) => (t.data || "").slice(0, 10)));
  expect(txs.filter((s) => s === SEL.claimMany).length).toBe(1); // exactly one bulk claim
  expect(txs.find((s) => s === SEL.claim)).toBeUndefined(); // not N single claims
});
