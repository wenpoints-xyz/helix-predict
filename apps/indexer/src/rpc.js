// Minimal JSON-RPC + paged eth_getLogs. Injective caps the [from,to] range at 10,000 blocks, so we
// page in <=RANGE-block windows (inclusive bounds, no gap/overlap). fetch is global on Node 18+.

const RANGE = 9000; // < 10k cap, with headroom

export function makeRpc(url) {
  let id = 0;
  return async function rpc(method, params) {
    const r = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params || [] })
    });
    const j = await r.json();
    if (j.error) throw new Error(method + ": " + (j.error.message || JSON.stringify(j.error)));
    return j.result;
  };
}

export async function blockNumber(rpc) {
  return Number(BigInt(await rpc("eth_blockNumber", [])));
}

// Fetch all logs for `address` across [fromBlock, toBlock] (inclusive), paging by RANGE. Optionally
// filter to a set of topic0 signatures. Yields them in block/logIndex order.
export async function getLogsPaged(rpc, address, fromBlock, toBlock, topics0) {
  const out = [];
  for (let from = fromBlock; from <= toBlock; from += RANGE + 1) {
    const to = Math.min(from + RANGE, toBlock);
    const filter = {
      address,
      fromBlock: "0x" + from.toString(16),
      toBlock: "0x" + to.toString(16)
    };
    if (topics0 && topics0.length) filter.topics = [topics0];
    const logs = await rpc("eth_getLogs", [filter]);
    for (const l of logs) out.push(l);
  }
  // stable order: by blockNumber then logIndex
  out.sort(function (a, b) {
    const bn = Number(BigInt(a.blockNumber)) - Number(BigInt(b.blockNumber));
    if (bn) return bn;
    return Number(BigInt(a.logIndex)) - Number(BigInt(b.logIndex));
  });
  return out;
}

export { RANGE };
