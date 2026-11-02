// Test-only mock of the SwapChan HTTP API (packages/shared contract). Also runnable: `node src/mockApi.ts`.
import { createServer, type Server } from "node:http";
import { encodeFunctionData, erc20Abi, keccak256, toBytes } from "viem";

// Test mock only; production computes this in apps/api via blocktools.
const appDataHash = (doc: string) => keccak256(toBytes(doc));

import {
  COW_VAULT_RELAYER,
  isReceiveOnly,
  type LimitOrderParams,
  limitAppData,
  limitOrderTypedData,
  NATIVE_TOKEN,
  type Quote,
  SUPPORTED_CHAINS,
  tokenList,
} from "@swapchan/shared";

export const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const ROUTER = "0x1111111254eeb25477b68fb85ed929f73a960582";

export function mockQuote(
  id: string,
  provider: string,
  q: URLSearchParams,
  toAmount: string,
  netUsd: number | null,
  withTx: boolean,
): Quote {
  const from = Number(q.get("fromChainId"));
  const to = Number(q.get("toChainId"));
  const fromToken = q.get("fromToken") as `0x${string}`;
  const toToken = q.get("toToken") as `0x${string}`;
  const amount = q.get("amount") ?? "0";
  return {
    id,
    provider,
    request: {
      fromChainId: from,
      toChainId: to,
      fromToken,
      toToken,
      amount,
      slippageBps: Number(q.get("slippageBps") ?? 50),
    },
    toAmount,
    toAmountMin: ((BigInt(toAmount) * 995n) / 1000n).toString(),
    gasUsd: 1.2,
    feeUsd: 0.3,
    netUsd,
    etaSeconds: from === to ? 15 : 120,
    steps: [
      {
        type: from === to ? "swap" : "bridge",
        tool: provider,
        fromChainId: from,
        toChainId: to,
        fromToken,
        toToken,
        fromAmount: amount,
        toAmount,
      },
    ],
    approvalAddress: fromToken.toLowerCase() === NATIVE_TOKEN.toLowerCase() ? null : ROUTER,
    tx:
      withTx && q.get("taker")
        ? { chainId: from, to: ROUTER, data: "0xdeadbeef", value: "0" }
        : null,
    expiresAt: Math.floor(Date.now() / 1000) + 60,
  };
}

export function startMockApi(port = 0): Promise<{ server: Server; url: string; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    calls.push(`${req.method} ${u.pathname}${u.search}`);
    const send = (s: number, b: unknown) => {
      res.writeHead(s, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    const q = u.searchParams;
    if (u.pathname.startsWith("/contract-tool/")) {
      let raw = "";
      for await (const c of req) raw += c;
      const op = u.pathname.slice("/contract-tool/".length);
      const b = raw ? JSON.parse(raw) : Object.fromEntries(q);
      if (op === "abi")
        return send(200, {
          ok: true,
          chainId: 1,
          address: b.address,
          proxy: null,
          abiSource: b.abi ? "pasted" : "sourcify",
          warnings: [],
          functions: [
            {
              name: "name",
              signature: "name()",
              selector: "0x06fdde03",
              kind: "read",
              payable: false,
              inputs: [],
              outputs: [{ name: "out0", type: "string" }],
            },
          ],
        });
      if (op === "read")
        return send(200, {
          ok: true,
          function: b.function,
          result: [{ name: "out0", type: "string", value: "Mock" }],
        });
      if (op === "encode")
        return send(200, {
          ok: true,
          to: b.address,
          function: b.function,
          value: b.value ?? "0",
          data: "0x06fdde03",
        });
      if (op === "approve")
        return send(200, {
          ok: true,
          request: b,
          verdict: "pass",
          reasons: [],
          to: b.address,
          function: b.function,
          value: b.value ?? "0",
          data: "0x06fdde03",
        });
      if (op === "create")
        return send(200, {
          ok: true,
          verdict: "pass",
          reasons: [],
          to: null,
          data: b.bytecode,
          initcode_keccak256: `0x${"ab".repeat(32)}`,
        });
      return send(404, { ok: false, error_code: "unknown" });
    }
    if (req.method === "POST" && u.pathname.startsWith("/tools/")) {
      let raw = "";
      for await (const c of req) raw += c;
      const tool = u.pathname.slice(7);
      if (tool === "detect-address")
        return send(400, { ok: false, tool, error_code: "unrecognized", error: "unrecognized" });
      // evm-abi encode: production runs blocktools evmAbiEncode; the mock reproduces the same bytes with viem
      // so the approve-calldata path (build_swap_tx / build_limit_order) is exercised end to end.
      const body = raw ? JSON.parse(raw) : {};
      if (tool === "evm-abi" && body.op === "encode" && body.sig === "approve(address,uint256)") {
        const [spender, amount] = body.args as [string, string];
        const data = encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [spender as `0x${string}`, BigInt(amount)],
        });
        return send(200, {
          ok: true,
          tool,
          result: { status: "ok", data, selector: data.slice(0, 10) },
        });
      }
      return send(200, { ok: true, tool, result: { echo: body } });
    }
    switch (u.pathname) {
      case "/chains":
        return send(
          200,
          Object.entries(SUPPORTED_CHAINS).map(([id, c]) => ({
            id: Number(id),
            ...c,
            ...(isReceiveOnly(Number(id))
              ? { receiveOnly: false, thorchainOnly: true, canSend: true, canReceive: true }
              : {}),
          })),
        );
      case "/tokens": {
        const c = q.get("chainId");
        return send(200, c ? tokenList.filter((t) => t.chainId === Number(c)) : tokenList);
      }
      case "/quotes": {
        if (q.get("amount") === "999") return send(500, { error: "all providers down" });
        const cross = q.get("fromChainId") !== q.get("toChainId");
        const quotes = cross
          ? [
              mockQuote("q-across", "across", q, "990000", 0.98, true),
              mockQuote("q-lifi", "lifi", q, "985000", 0.97, false),
            ]
          : [
              mockQuote("q-0x", "0x", q, "2000000000", 1999.5, true),
              mockQuote("q-cow", "cow", q, "1999000000", 1998.4, false),
            ];
        return send(200, {
          quotes,
          best: quotes[0]?.id ?? null,
          errors: [{ provider: "relay", message: "timeout" }],
        });
      }
      case "/build": {
        let body = "";
        for await (const ch of req) body += ch;
        const { quoteId } = JSON.parse(body) as { quoteId: string };
        return send(200, {
          chainId: quoteId === "q-lifi" ? 1 : 1,
          to: ROUTER,
          data: "0xc0ffee",
          value: "0",
          execution: "tx",
          simulation: { ok: true, method: "eth_call", gasUsed: "123456" },
          ...(quoteId.startsWith("q-0x")
            ? {
                permit2: {
                  domain: { name: "Permit2", chainId: 1 },
                  types: { PermitTransferFrom: [{ name: "nonce", type: "uint256" }] },
                  primaryType: "PermitTransferFrom",
                  message: { nonce: "1" },
                },
              }
            : {}),
        });
      }
      case "/limit/build": {
        let body = "";
        for await (const ch of req) body += ch;
        const b = JSON.parse(body) as LimitOrderParams;
        const doc = limitAppData("0xeb0eC7a28E4B6B175806E21D9D3afE45792C5c7B", 10);
        const hash = appDataHash(doc);
        return send(200, {
          order: limitOrderTypedData({ ...b, appDataHash: hash }),
          appData: doc,
          appDataHash: hash,
          approvalAddress: COW_VAULT_RELAYER,
          partnerFee: { volumeBps: 10, recipient: "0xeb0eC7a28E4B6B175806E21D9D3afE45792C5c7B" },
          market: { buyAmount: "2000000000" },
        });
      }
      case "/limit/orders":
        return send(200, [{ uid: "0xaa", status: "open" }]);
      case "/status":
        return send(200, {
          status: q.get("txHash")?.endsWith("00") ? "pending" : "done",
          receivingTxHash: null,
        });
      case "/onchain/money":
        return send(200, {
          address: q.get("address"),
          opportunities: 1,
          totalEstUsd: 3.14,
          atRiskUsd: 0,
          items: [
            {
              rank: 1,
              category: "Forgotten money in old contracts",
              title: "PoWH3D (P3D): dividends",
              estUsd: 3.14,
              estimateKind: "exact",
              swapUrl: "https://swapchan.com/?fromChain=1",
              shortUrl: "https://swapchan.com/s/100",
              steps: [
                {
                  step: 1,
                  kind: "recover",
                  label: "Sign the recovery",
                  call: {
                    chainId: 1,
                    chain: "Ethereum",
                    contract: "0xB3775fB83F7D12A36E0475aBdD1FCA35c091efBe",
                    contractExplorerUrl:
                      "https://etherscan.io/address/0xB3775fB83F7D12A36E0475aBdD1FCA35c091efBe",
                    selector: "0x3ccfd60b",
                    function: "withdraw",
                    signature: "withdraw()",
                    args: [],
                    plain:
                      "Calls withdraw() [selector 0x3ccfd60b] on contract 0xB3775fB83F7D12A36E0475aBdD1FCA35c091efBe on Ethereum with no arguments.",
                  },
                },
              ],
            },
          ],
          next: { label: "#1: PoWH3D", swapUrl: "https://swapchan.com/?fromChain=1" },
        });
      case "/links/swap":
        return send(200, {
          url: `https://swapchan.com/?fromChain=${q.get("fromChain")}`,
          shortUrl: "https://swapchan.com/s/101",
          fromChainId: 8453,
          toChainId: 8453,
        });
      case "/onchain/market":
        return send(200, {
          read: "Sentiment: Neutral (50/100).",
          next: { label: "Swap", swapUrl: "https://swapchan.com" },
        });
      case "/scanner/new":
      case "/scanner/trending":
      case "/scanner/movers":
        return send(200, {
          kind: u.pathname.split("/")[2],
          tokens: [
            {
              chain: q.get("chain") ?? "solana",
              chainId: 792703809,
              address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
              symbol: "BONK",
              name: "Bonk",
              priceUsd: 0.00003,
              liquidityUsd: 300000,
              risk: { level: "low", flags: [] },
              swapUrl:
                "https://swapchan.com/?fromChain=792703809&toChain=792703809&fromToken=11111111111111111111111111111111&toToken=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
            },
          ],
          updatedAt: new Date(0).toISOString(),
          disclaimer: "Not financial advice.",
        });
      case "/scanner/risk":
        return send(200, {
          chain: q.get("chain"),
          address: q.get("address"),
          level: "high",
          flags: ["freeze authority enabled"],
          checks: {},
          swapUrl: "https://swapchan.com/",
          disclaimer: "Not financial advice.",
        });
      default:
        return send(404, { error: "not found" });
    }
  });
  return new Promise((r) =>
    server.listen(port, "127.0.0.1", () => {
      const a = server.address();
      r({ server, url: `http://127.0.0.1:${typeof a === "object" && a ? a.port : port}`, calls });
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await startMockApi(Number(process.env.PORT ?? 8787));
  console.error(`mock SwapChan API on ${url}`);
}
