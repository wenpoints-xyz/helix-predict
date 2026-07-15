/* session.js — session-key auto-bet for the $HELIXPOINT predict arcade.
   A random per-origin browser EOA (the "session key") signs openBetFor txs LOCALLY and submits them
   via eth_sendRawTransaction, so tapping UP/DOWN fires a bet with NO wallet popup. The key holds no
   POINTS: openBetFor pulls the stake from the MAIN wallet (its allowance) and records the position
   under the main wallet. Blast radius is bounded on-chain by grantSession(maxStake,expiry(<=24h),
   maxSpend); a stolen key can wager at most maxSpend and dies at expiry / on revoke.

   Zero-build: this ESM imports the vendored noble-secp256k1 (secp256k1, WebCrypto-backed RFC-6979)
   and reads the global `keccak256` from the vendored js-sha3 (loaded as a plain <script> first).
   The pure signer core (rlpEncode / signLegacyTx) takes an injected keccak + signer so it can be
   unit-tested in node against ethers; the browser glue (window.PXSession) wires localStorage + PX. */
import * as secp from "./vendor/noble-secp256k1.js";

// keccak256 comes from js-sha3 (global in the browser; injected in node tests via globalThis).
function _keccak() {
  var k = (typeof globalThis !== "undefined" && globalThis.keccak256) || (typeof window !== "undefined" && window.keccak256);
  if (!k) throw new Error("keccak256 unavailable (js-sha3 not loaded)");
  return k;
}

// ---- bytes helpers ----
function hexToBytes(h) {
  h = (h || "").replace(/^0x/, "");
  if (h.length % 2) h = "0" + h;
  var out = new Uint8Array(h.length / 2);
  for (var i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(b) {
  var s = "";
  for (var i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}
function concat(arrs) {
  var n = 0, i;
  for (i = 0; i < arrs.length; i++) n += arrs[i].length;
  var out = new Uint8Array(n), o = 0;
  for (i = 0; i < arrs.length; i++) { out.set(arrs[i], o); o += arrs[i].length; }
  return out;
}
// Minimal big-endian bytes of a non-negative integer (empty array for 0) — RLP's canonical integer form.
function minBytes(v) {
  var n = BigInt(v);
  if (n < 0n) throw new Error("neg");
  if (n === 0n) return new Uint8Array(0);
  var h = n.toString(16);
  if (h.length % 2) h = "0" + h;
  return hexToBytes(h);
}
function keccakBytes(bytes) { return hexToBytes(_keccak().call(null, bytes)); }

// ---- RLP ----
function rlpLen(len, offset) {
  if (len < 56) return new Uint8Array([offset + len]);
  var lenBytes = minBytes(len);
  return concat([new Uint8Array([offset + 55 + lenBytes.length]), lenBytes]);
}
function rlpBytes(b) { // encode a byte string
  if (b.length === 1 && b[0] < 0x80) return b; // single low byte is its own encoding
  return concat([rlpLen(b.length, 0x80), b]);
}
function rlpList(items) { // items: array of already-encoded byte strings
  var body = concat(items);
  return concat([rlpLen(body.length, 0xc0), body]);
}
// Encode a legacy tx field list [f0,f1,...] where each fi is a Uint8Array payload.
function rlpEncodeFields(fields) {
  return rlpList(fields.map(rlpBytes));
}

// ---- legacy EIP-155 tx sign ----
// tx: {nonce, gasPrice, gasLimit, to (0x..20), value, data (0x..), chainId}. signer: async (hash32Bytes)->{r,s,recovery}.
async function signLegacyTx(tx, signer) {
  var base = [
    minBytes(tx.nonce), minBytes(tx.gasPrice), minBytes(tx.gasLimit),
    hexToBytes(tx.to), minBytes(tx.value || 0), hexToBytes(tx.data || "0x"),
    minBytes(tx.chainId), new Uint8Array(0), new Uint8Array(0)
  ];
  var sigHash = keccakBytes(rlpEncodeFields(base)); // 32 bytes
  var sig = await signer(sigHash);
  var v = BigInt(tx.chainId) * 2n + 35n + BigInt(sig.recovery);
  var signed = [
    minBytes(tx.nonce), minBytes(tx.gasPrice), minBytes(tx.gasLimit),
    hexToBytes(tx.to), minBytes(tx.value || 0), hexToBytes(tx.data || "0x"),
    minBytes(v), minBytes(sig.r), minBytes(sig.s)
  ];
  return "0x" + bytesToHex(rlpEncodeFields(signed));
}

// noble-backed signer for a raw private key (hex, no 0x).
function nobleSigner(privHex) {
  return function (hash32) {
    return secp.signAsync(hash32, privHex).then(function (s) {
      return { r: s.r, s: s.s, recovery: s.recovery };
    });
  };
}
// address (0x, checksum-less lowercase) from a private key hex.
function addressFromPriv(privHex) {
  var pub = secp.getPublicKey(privHex, false); // 65-byte uncompressed 0x04||X||Y
  var hash = _keccak().call(null, pub.slice(1)); // keccak(X||Y) hex
  return "0x" + hash.slice(-40);
}
function randomPrivHex() {
  var b = new Uint8Array(32);
  (globalThis.crypto || window.crypto).getRandomValues(b);
  // reduce into [1, n-1] cheaply: noble validates; on the ~2^-128 chance it's invalid, caller regenerates
  return bytesToHex(b);
}

// ---- pure-core export (for node tests) ----
export var core = {
  hexToBytes: hexToBytes, bytesToHex: bytesToHex, minBytes: minBytes,
  rlpEncodeFields: rlpEncodeFields, signLegacyTx: signLegacyTx,
  nobleSigner: nobleSigner, addressFromPriv: addressFromPriv, keccakBytes: keccakBytes
};

// =========================================================================
// Browser glue: window.PXSession — key storage + grant/openBetFor/revoke/sweep
// =========================================================================
// Only wire in a browser (skipped when imported for node tests).
if (typeof window !== "undefined") {
  // Selectors (verified against the compiled PredictionBook ABI).
  var SEL_GRANT = "0x65cb5614";      // grantSession(address,uint64,uint128) — v3 dropped maxStake
  var SEL_OPENCOST = "0x5073a663";   // openCost() -> INJ each bet prepays for its settlement (v3)
  var SEL_REVOKE = "0xc4605d8c";     // revokeSession()
  var SEL_OPENBETFOR = "0x804f7759"; // openBetFor(address,uint256,bool,uint256,uint64)
  var SEL_SESSIONS = "0x431a1b97";   // sessions(address) -> (key,expiry,maxSpend,spent) [v3: no maxStake]
  var SEL_APPROVE = "0x095ea7b3";    // approve(address,uint256) on the stake token
  var SEL_CLAIM = "0x379607f5";      // claim(uint256 betId) — permissionless, always pays the bettor

  // Fixed ceiling for openBetFor (skips a per-bet estimateGas round-trip for responsiveness). Sized
  // for MAINNET: the $HELIXPOINT bank-precompile transferFrom is heavier than a plain ERC20, so
  // openBetFor measures ~439k gas there (testnet MockPoints is ~300k). You only pay gas USED, so
  // over-provisioning the LIMIT is free — keep comfortable headroom above the measured cost.
  var GAS_LIMIT = 1000000n;
  // claim() hits the same bank-precompile transfer (~200-250k on mainnet) + storage writes. An on-chain
  // OOG revert is SILENT (eth_sendRawTransaction returns a hash, so it looks like success) — so DON'T
  // guess tight; over-provision. Confirmation is done by the caller reading owed(betId)->0, not the hash.
  var CLAIM_GAS = 500000n;
  var SWEEP_GAS = 30000n;            // a bare INJ value transfer
  var GAS_TTL = 30000;               // ms to cache eth_gasPrice
  var SEND_TIMEOUT = 20000;          // ms: abort a hung send so the per-key queue can't wedge the tap path

  function NET() { return window.PX && window.PX.NET; }

  // ---- minimal abi encoders ----
  function _u256(v) { return BigInt(v).toString(16).padStart(64, "0"); }
  function _addr32(a) { return (a || "").replace(/^0x/, "").toLowerCase().padStart(64, "0"); }
  function _bool32(b) { return (b ? "1" : "0").padStart(64, "0"); }

  // ---- raw json-rpc (read side reuses PX.NET.rpc). timeoutMs aborts a hung request (send path). ----
  var _rid = 0;
  function rpc(method, params, timeoutMs) {
    var ctrl = (timeoutMs && typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
    var opts = {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++_rid, method: method, params: params || [] })
    };
    if (ctrl) opts.signal = ctrl.signal;
    return fetch(NET().rpc, opts).then(function (r) { return r.json(); }).then(function (j) {
      if (timer) clearTimeout(timer);
      if (j.error) { var e = new Error(j.error.message || "rpc error"); e.rpc = j.error; throw e; }
      return j.result;
    }, function (e) { if (timer) clearTimeout(timer); throw e; });
  }

  // ---- key storage (per network + per main account) ----
  function skey(net, account) { return "px-session:" + net + ":" + (account || "").toLowerCase(); }
  function loadKey(net, account) { try { return localStorage.getItem(skey(net, account)) || null; } catch (e) { return null; } }
  function saveKey(net, account, priv) { try { localStorage.setItem(skey(net, account), priv); } catch (e) {} }
  function dropKey(net, account) { try { localStorage.removeItem(skey(net, account)); } catch (e) {} }
  function ensureKey(net, account) {
    var p = loadKey(net, account);
    if (!p) { p = randomPrivHex(); saveKey(net, account, p); }
    return { priv: p, address: addressFromPriv(p) };
  }

  // ---- v3 open cost (INJ each bet prepays; cached like gas so it's not a per-tap round-trip) ----
  var _oc = { v: null, at: 0 };
  function openCostCached() {
    var now = Date.now();
    if (_oc.v != null && now - _oc.at < GAS_TTL) return Promise.resolve(_oc.v);
    return rpc("eth_call", [{ to: NET().book, data: SEL_OPENCOST }, "latest"]).then(function (h) {
      _oc.v = BigInt(h); _oc.at = now; return _oc.v;
    });
  }

  // ---- gas / nonce (cached for responsiveness; the user chose no per-bet pre-flight) ----
  var _gas = { price: null, at: 0 };
  var _nonce = {}; // sessionAddr -> next nonce (tracked locally, refetched on mismatch)
  function gasPrice() {
    var now = Date.now();
    if (_gas.price && now - _gas.at < GAS_TTL) return Promise.resolve(_gas.price);
    return rpc("eth_gasPrice", []).then(function (h) {
      var p = (BigInt(h) * 12n) / 10n; // +20% headroom so a tick-up doesn't bounce the bet
      _gas.price = p; _gas.at = now; return p;
    });
  }
  function nextNonce(addr) {
    if (_nonce[addr] != null) return Promise.resolve(_nonce[addr]);
    return rpc("eth_getTransactionCount", [addr, "pending"]).then(function (h) {
      _nonce[addr] = BigInt(h); return _nonce[addr];
    });
  }
  function resetNonce(addr) { delete _nonce[addr]; }

  // Classify a send error. Pre-broadcast "insufficient funds" (the session key is out of INJ gas) is
  // SAFE to retry on the main wallet — the tx never entered the mempool, so no double-bet. Anything
  // else (revert, nonce, timeout) is NOT retried (it may have landed).
  function isGasFundsError(e) {
    var m = ((e && (e.message || (e.rpc && e.rpc.message))) || "").toLowerCase();
    return m.indexOf("insufficient funds") !== -1 || m.indexOf("insufficient balance") !== -1;
  }

  // ---- per-key send queue ----
  // The session key now signs BOTH bets (openBetFor, on tap) and claims (on settle, async from poll).
  // sendRaw reads the cached nonce at the start but only advances it after the send resolves, so two
  // overlapping sends would grab the same nonce -> "nonce too low". Serialize per key so only ONE send
  // is in flight at a time. Two guards keep this from wedging the tap path:
  //   • BETS jump ahead of CLAIMS (hi lane) — a background claim never sits in front of a UP/DOWN tap.
  //   • the queue advances on SETTLE (resolve OR reject) via then(res, rej), so a routine
  //     INSUFFICIENT_GAS rejection can't wedge it; rpc() carries SEND_TIMEOUT so a hung send can't either.
  var _q = {}; // addr -> { busy, hi:[bets], lo:[claims/sweeps] }
  function _pump(addr) {
    var q = _q[addr];
    if (!q || q.busy) return;
    var it = q.hi.shift() || q.lo.shift();
    if (!it) return;
    q.busy = true;
    var next = function () { q.busy = false; _pump(addr); };
    it.run().then(function (v) { next(); it.res(v); }, function (e) { next(); it.rej(e); });
  }
  function _enqueue(addr, hi, run) {
    var q = _q[addr] || (_q[addr] = { busy: false, hi: [], lo: [] });
    return new Promise(function (res, rej) {
      (hi ? q.hi : q.lo).push({ run: run, res: res, rej: rej });
      _pump(addr);
    });
  }

  // Sign + broadcast a legacy tx from the session key, serialized per key. `hi` = tap-priority (bets).
  // Bumps the local nonce on success; on any failure resets it (so the next send refetches). Throws
  // with .code='INSUFFICIENT_GAS' when the key is out of INJ (retryable on the wallet), else rethrows.
  function sendRaw(net, account, to, data, valueWei, gasLimit, hi) {
    var k = ensureKey(net, account);
    return _enqueue(k.address, !!hi, function () {
      var chainId = parseInt(NET().chainIdHex, 16);
      return Promise.all([nextNonce(k.address), gasPrice()]).then(function (r) {
        var tx = { nonce: r[0], gasPrice: r[1], gasLimit: gasLimit || GAS_LIMIT, to: to, value: valueWei || 0, data: data, chainId: chainId };
        return signLegacyTx(tx, nobleSigner(k.priv)).then(function (raw) {
          return rpc("eth_sendRawTransaction", [raw], SEND_TIMEOUT).then(function (hash) {
            _nonce[k.address] = r[0] + 1n; // advance locally so rapid taps don't collide
            return hash;
          });
        });
      }).catch(function (e) {
        resetNonce(k.address); // any failure: drop the cached nonce so the next attempt refetches
        if (isGasFundsError(e)) { e.code = "INSUFFICIENT_GAS"; }
        throw e;
      });
    });
  }

  // ---- reads ----
  // sessions(bettor) -> {key,expiry,maxSpend,spent}  (v3: maxStake removed)
  function sessionOf(account) {
    return rpc("eth_call", [{ to: NET().book, data: SEL_SESSIONS + _addr32(account) }, "latest"]).then(function (hex) {
      hex = (hex || "").replace(/^0x/, "");
      function w(i) { return hex.substr(i * 64, 64); }
      var key = "0x" + w(0).slice(24);
      return {
        key: key,
        active: key !== "0x0000000000000000000000000000000000000000",
        expiry: Number(BigInt("0x" + w(1))),
        maxSpend: BigInt("0x" + w(2)),
        spent: BigInt("0x" + w(3))
      };
    });
  }
  function sessionGasBalance(addr) { return rpc("eth_getBalance", [addr, "latest"]).then(function (h) { return BigInt(h); }); }

  // Full status for the UI: derived key address, on-chain grant, remaining budget, gas balance.
  function status(net, account) {
    if (!account) return Promise.resolve(null);
    var addr = addressFromPriv(ensureKey(net, account).priv);
    return Promise.all([sessionOf(account), sessionGasBalance(addr)]).then(function (r) {
      var s = r[0];
      return {
        address: addr, granted: s.active && s.key.toLowerCase() === addr.toLowerCase(),
        key: s.key, expiry: s.expiry, maxSpend: s.maxSpend, spent: s.spent,
        budgetLeft: s.maxSpend > s.spent ? s.maxSpend - s.spent : 0n,
        expired: s.expiry ? Date.now() / 1000 >= s.expiry : true,
        gas: r[1]
      };
    });
  }

  // ---- writes via the MAIN wallet (popups — one-time setup / teardown) ----
  // Preflight before every wallet write. Once auto-bet is on, taps sign via raw RPC and the WALLET is
  // never touched — so by the time the user needs it again (top-up / DISABLE) it may have drifted to
  // another chain or account. Sending blind then either errors opaquely or, worse, lands the tx on the
  // wrong chain. Re-sync the chain (propagate a refused switch — never send cross-chain) and verify
  // the active account still matches `from`.
  function walletPreflight(provider, from) {
    return provider.request({ method: "eth_chainId" }).then(function (cid) {
      if (cid === NET().chainIdHex) return;
      return provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: NET().chainIdHex }] });
    }).then(function () {
      return provider.request({ method: "eth_accounts" }).then(function (accts) {
        var a = ((accts && accts[0]) || "").toLowerCase();
        if (a && from && a !== from.toLowerCase()) {
          var e = new Error("wallet is on account " + a.slice(0, 6) + "… — switch it back to " + from.slice(0, 6) + "…");
          e.code = "ACCOUNT_MISMATCH";
          throw e;
        }
      });
    });
  }
  function walletTx(provider, from, to, data, valueWei) {
    var p = { from: from, to: to, data: data };
    if (valueWei) p.value = "0x" + BigInt(valueWei).toString(16);
    return walletPreflight(provider, from).then(function () {
      return provider.request({ method: "eth_sendTransaction", params: [p] });
    });
  }
  function approve(provider, from, amountWei) {
    return walletTx(provider, from, NET().points, SEL_APPROVE + _addr32(NET().book) + _u256(amountWei));
  }
  function grant(provider, from, keyAddr, expiry, maxSpendWei) {
    var data = SEL_GRANT + _addr32(keyAddr) + _u256(expiry) + _u256(maxSpendWei); // v3: no maxStake
    return walletTx(provider, from, NET().book, data);
  }
  function revoke(provider, from) { return walletTx(provider, from, NET().book, SEL_REVOKE); }
  function topupGas(provider, from, toAddr, valueWei) { return walletTx(provider, from, toAddr, "0x", valueWei); }

  // ---- the no-popup bet: openBetFor signed by the session key (tap-priority in the queue) ----
  function autoBet(net, account, marketId, up, stakeWei, dur) {
    var data = SEL_OPENBETFOR + _addr32(account) + _u256(marketId) + _bool32(up) + _u256(stakeWei) + _u256(dur);
    // v3: openBetFor is payable — attach the settle-fee escrow, over-attached ~1.15x so a fee/param
    // drift between the cached quote and the mine doesn't revert InsufficientOpenFee; the excess refunds.
    return openCostCached().then(function (oc) {
      var value = oc + oc / 10n + oc / 20n; // ~1.15x
      return sendRaw(net, account, NET().book, data, value, GAS_LIMIT, /*hi*/ true);
    });
  }

  // ---- the no-popup claim: claim(betId) signed by the session key (low-priority behind bets) ----
  // claim is permissionless and always pays positions[betId].bettor, so the key needs no grant, just
  // gas. NOTE: a returned tx hash is NOT proof of a claim (an OOG revert still returns a hash) — the
  // caller confirms via owed(betId)->0. CLAIM_GAS is over-provisioned so that path shouldn't trigger.
  function claim(net, account, betId) {
    return sendRaw(net, account, NET().book, SEL_CLAIM + _u256(betId), 0, CLAIM_GAS, /*hi*/ false);
  }

  // Sweep the session key's leftover INJ back to the main wallet (best-effort; called on disable/rotate).
  function sweepGas(net, account) {
    var k = ensureKey(net, account);
    return Promise.all([sessionGasBalance(k.address), gasPrice()]).then(function (r) {
      var bal = r[0], gp = r[1], cost = gp * SWEEP_GAS;
      if (bal <= cost) return null; // nothing worth sweeping
      var send = bal - cost;
      return sendRaw(net, account, account, "0x", send, SWEEP_GAS, /*hi*/ false);
    });
  }

  window.PXSession = {
    core: core,
    addressFromPriv: addressFromPriv, randomPrivHex: randomPrivHex,
    ensureKey: ensureKey, loadKey: loadKey, saveKey: saveKey, dropKey: dropKey, skey: skey,
    status: status, sessionOf: sessionOf, sessionGasBalance: sessionGasBalance,
    approve: approve, grant: grant, revoke: revoke, topupGas: topupGas,
    autoBet: autoBet, claim: claim, sweepGas: sweepGas, isGasFundsError: isGasFundsError,
    openCost: openCostCached, GAS_LIMIT: GAS_LIMIT, CLAIM_GAS: CLAIM_GAS
  };
}
