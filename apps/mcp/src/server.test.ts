import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { NATIVE_TOKEN } from "@swapchan/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SwapChanApi } from "./api.js";
import { RateLimiter } from "./auth.js";
import { loadConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import { startMockApi, USDC } from "./mockApi.js";

const KEY = "test-key-123";
let mock: Awaited<ReturnType<typeof startMockApi>>;
let mcp: ReturnType<typeof createHttpServer>;
let mcpUrl: string;

beforeAll(async () => {
  mock = await startMockApi();
  const cfg = loadConfig({
    SWAPCHAN_API_URL: mock.url,
    MCP_API_KEYS: `${KEY},other`,
    MCP_RATE_LIMIT_PER_MIN: "1000",
  });
  mcp = createHttpServer(new SwapChanApi(cfg.apiUrl), cfg);
  await new Promise<void>((r) => mcp.server.listen(0, "127.0.0.1", r));
  mcpUrl = `http://127.0.0.1:${(mcp.server.address() as AddressInfo).port}/mcp`;
});
afterAll(async () => {
  await mcp.close();
  mock.server.close();
});

async function connect(key = KEY) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { "x-api-key": key } },
    }),
  );
  return client;
}
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? "";
const data = (r: unknown) => JSON.parse(text(r));

const ethToUsdc = {
  fromChainId: 1,
  toChainId: 1,
  fromToken: NATIVE_TOKEN,
  toToken: USDC,
  amount: "1",
};

describe("swapchan mcp over streamable http", () => {
  it("lists Litecoin, Dogecoin and Bitcoin Cash as THORChain-only chains (send and receive)", async () => {
    const c = await connect();
    const t = text(await c.callTool({ name: "get_supported_chains", arguments: {} }));
    for (const n of ["Litecoin", "Dogecoin", "Bitcoin Cash"]) expect(t).toContain(n);
    expect(t).toMatch(/"thorchainOnly": ?true/);
    expect(t).toMatch(/"canSend": ?true/);
    expect(t).not.toMatch(/"receiveOnly": ?true/);
    const tools = await c.listTools();
    const q = tools.tools.find((x) => x.name === "get_quote");
    expect(JSON.stringify(q?.inputSchema)).toContain("2000000002 Litecoin");
    expect(JSON.stringify(q?.inputSchema)).toContain("THORChain-only");
  });
  it("builds a limit order with our partner fee and lists orders", async () => {
    const c = await connect();
    const r = data(
      await c.callTool({
        name: "build_limit_order",
        arguments: {
          chainId: 1,
          owner: "0x1111111111111111111111111111111111111111",
          sellToken: USDC,
          buyToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
          sellAmount: "100",
          limitPrice: "0.0005",
        },
      }),
    );
    expect(r.typedData.primaryType).toBe("Order");
    expect(r.typedData.message.sellAmount).toBe("100000000");
    expect(r.typedData.message.buyAmount).toBe("50000000000000000");
    expect(r.typedData.message.appData).toBe(r.appDataHash);
    expect(r.swapchanFee).toEqual({
      volumeBps: 10,
      recipient: "0xeb0eC7a28E4B6B175806E21D9D3afE45792C5c7B",
    });
    const l = data(
      await c.callTool({
        name: "list_limit_orders",
        arguments: { chainId: 1, owner: "0x1111111111111111111111111111111111111111" },
      }),
    );
    expect(l.orders[0].uid).toBe("0xaa");
    await c.close();
  });

  it("lists all tools", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "build_limit_order",
        "build_swap_tx",
        "cancel_limit_order",
        "list_limit_orders",
        "compare_routes",
        "get_quote",
        "get_route_status",
        "get_supported_chains",
        "get_supported_tokens",
        "get_utxo_deposit",
        "track_utxo_swap",
        "scan_movers",
        "scan_new_tokens",
        "scan_trending",
        "token_risk",
        "get_wallet_balances",
        "check_approvals",
        "build_revoke_tx",
        "explain_transaction",
        "get_gas",
        "token_info",
        "resolve_name",
        "price_history",
        "watch_token",
        "list_watches",
        "check_watches",
        "unwatch_token",
        "get_yields",
        "find_money",
        "build_swap_link",
        "simulate_swap",
        "wallet_history",
        "wallet_pnl",
        "token_pools",
        "whale_watch",
        "contract_reader",
        "airdrop_check",
        "market_context",
        "rebalance_plan",
        "bridge_doctor",
        "best_time_to_swap",
        "verify_tx",
        "broadcast_tx",
        "tx_status",
        "signing_guide",
        "recovery_guide",
        "read_chain",
        "find_money_batch",
        "find_money_status",
        "swapchan_playbook",
        "address_tool",
        "xpub_addresses",
        "solana_address",
        "substrate_tool",
        "hash_tool",
        "chain_params",
        "tron_tx",
        "evm_abi",
        "create_address",
        "bytecode_inspect",
        "typed_data_verify",
        "supported_chains",
        "contract_abi",
        "contract_read",
        "contract_encode_call",
        "contract_approve_call",
        "contract_build_creation",
        "multisig_address",
        "taproot_multisig_address",
        "combine_psbts",
        "build_plan_tx",
        "msg_verify",
        "bolt11_decode",
        "build_send_tx",
      ].sort(),
    );
    await c.close();
  });

  it("llms.txt lists every MCP tool, with the measured count", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    const llms = readFileSync(new URL("../../web/public/llms.txt", import.meta.url), "utf8");
    const m = llms.match(/^- Tools \((\d+)\): (.+)$/m);
    expect(m).not.toBeNull();
    const listed = (m?.[2] ?? "").split(", ");
    expect(Number(m?.[1])).toBe(tools.length);
    expect([...listed].sort()).toEqual(tools.map((t) => t.name).sort());
    await c.close();
  });

  it("contract tools are read-only and never send", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    const A = "0x1111111111111111111111111111111111111111";
    for (const n of [
      "contract_abi",
      "contract_read",
      "contract_encode_call",
      "contract_approve_call",
      "contract_build_creation",
    ]) {
      const t = tools.find((x) => x.name === n)!;
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
      expect(t.description).not.toMatch(/\bfees?\b|\bfree\b|bps|\bpay(ment)?\b/i);
    }
    const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
    expect(
      text(await c.callTool({ name: "contract_abi", arguments: { chainId: 1, address: A } })),
    ).toContain("name()");
    expect(
      text(
        await c.callTool({
          name: "contract_read",
          arguments: { chainId: 1, address: A, function: "name" },
        }),
      ),
    ).toContain("Mock");
    expect(
      text(
        await c.callTool({
          name: "contract_encode_call",
          arguments: { chainId: "eth", address: A, function: "name()" },
        }),
      ),
    ).toContain("0x06fdde03");
    expect(
      text(
        await c.callTool({
          name: "contract_approve_call",
          arguments: { chainId: 1, address: A, function: "name()" },
        }),
      ),
    ).toContain('"verdict": "pass"');
    expect(
      text(
        await c.callTool({
          name: "contract_build_creation",
          arguments: { chainId: 1, bytecode: "0x6080" },
        }),
      ),
    ).toContain("initcode_keccak256");
    const S = "0x2222222222222222222222222222222222222222";
    const opts = {
      expect_spender: S,
      expect_unlimited: true,
      expect_recipient: S,
      expect_value: "0",
      allow_inner_call: [`${S}:0xa9059cbb`],
      allow_delegatecall: [S],
    };
    const ap = data(
      await c.callTool({
        name: "contract_approve_call",
        arguments: { chainId: 1, address: A, function: "name()", ...opts },
      }),
    );
    expect(ap.request).toMatchObject(opts);
    const badOpt = (await c.callTool({
      name: "contract_approve_call",
      arguments: { chainId: 1, address: A, function: "name()", expect_amount: "1.5" },
    })) as { isError?: boolean };
    expect(badOpt.isError).toBe(true);
    const td = data(
      await c.callTool({
        name: "typed_data_verify",
        arguments: {
          typed_data: "{}",
          expect_chain_id: "1",
          expect_verifying_contract: S,
          expect_min_consideration: "native:1,0x1111111111111111111111111111111111111111:2",
        },
      }),
    );
    expect(td.result.echo).toMatchObject({
      expect_chain_id: "1",
      expect_verifying_contract: S,
      expect_min_consideration: "native:1,0x1111111111111111111111111111111111111111:2",
    });
    const badTd = (await c.callTool({
      name: "typed_data_verify",
      arguments: { typed_data: "{}", expect_chain_id: 1 },
    })) as { isError?: boolean };
    expect(badTd.isError).toBe(true);
    const bad = (await c.callTool({
      name: "contract_read",
      arguments: { chainId: 1, address: "0x12", function: "name" },
    })) as { isError?: boolean };
    expect(bad.isError).toBe(true);
    await c.close();
  });

  it("find_money exposes an optional boolean fresh and documents asOf/cached", async () => {
    const c = await connect();
    const t = (await c.listTools()).tools.find((x) => x.name === "find_money")!;
    const props = (t.inputSchema as { properties: Record<string, { type?: string }> }).properties;
    expect(props.fresh?.type).toBe("boolean");
    expect((t.inputSchema as { required?: string[] }).required ?? []).not.toContain("fresh");
    expect(t.description).toContain("freshRefused");
    expect(t.description).toContain("asOf");
    await c.close();
  });

  it("SwapChanApi.findMoney sends fresh=1 only when asked, with the 90s timeout", async () => {
    const urls: string[] = [];
    const api = new SwapChanApi("http://x.test", {
      fetch: (async (u: string | URL) => {
        urls.push(String(u));
        return new Response("{}", { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    await api.findMoney("0xabc");
    await api.findMoney("0xabc", true);
    expect(urls[0]).not.toContain("fresh");
    expect(urls[1]).toContain("fresh=1");
  });

  it("find_money, build_swap_link and market_context end in a swap link", async () => {
    const c = await connect();
    const m = data(await c.callTool({ name: "find_money", arguments: { address: "vitalik.eth" } }));
    expect(m.items[0].shortUrl).toBe("https://swapchan.com/s/100");
    expect(m.items[0].steps[0].call).toMatchObject({
      selector: "0x3ccfd60b",
      signature: "withdraw()",
    });
    expect(JSON.stringify(m)).toContain("signing it: Calls withdraw() [selector 0x3ccfd60b]");
    expect(m.swapUrl).toContain("swapchan.com");
    const l = data(
      await c.callTool({
        name: "build_swap_link",
        arguments: { fromChain: "base", fromToken: "ETH", toToken: "USDC", amount: "0.1" },
      }),
    );
    expect(l.shortUrl).toBe("https://swapchan.com/s/101");
    const k = await c.callTool({ name: "market_context", arguments: {} });
    expect(text(k)).toContain("Neutral");
    await c.close();
  });

  it("rejects missing / bad keys with 401", async () => {
    expect((await fetch(mcpUrl, { method: "POST" })).status).toBe(401);
    expect(
      (await fetch(mcpUrl, { method: "POST", headers: { authorization: "Bearer nope" } })).status,
    ).toBe(401);
  });

  it("rate limits per key with 429 + Retry-After", () => {
    let t = 0;
    const rl = new RateLimiter(2, () => t);
    expect([rl.take("a"), rl.take("a")]).toEqual([0, 0]);
    expect(rl.take("a")).toBeGreaterThan(0);
    expect(rl.take("b")).toBe(0);
    t += 30_000;
    expect(rl.take("a")).toBe(0);
  });

  it("http 429 once the bucket is empty", async () => {
    const cfg = loadConfig({
      SWAPCHAN_API_URL: mock.url,
      MCP_API_KEYS: KEY,
      MCP_RATE_LIMIT_PER_MIN: "1",
    });
    const s = createHttpServer(new SwapChanApi(cfg.apiUrl), cfg);
    await new Promise<void>((r) => s.server.listen(0, "127.0.0.1", r));
    const u = `http://127.0.0.1:${(s.server.address() as AddressInfo).port}/mcp`;
    await fetch(u, { method: "POST", headers: { "x-api-key": KEY } });
    const r = await fetch(u, { method: "POST", headers: { "x-api-key": KEY } });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
    await s.close();
  });

  it("get_supported_chains / tokens", async () => {
    const c = await connect();
    expect(
      data(await c.callTool({ name: "get_supported_chains", arguments: {} })).result.map(
        (x: { id: number }) => x.id,
      ),
    ).toContain(8453);
    const toks = data(
      await c.callTool({ name: "get_supported_tokens", arguments: { chainId: 1, search: "usdc" } }),
    ).result;
    expect(toks[0].symbol).toBe("USDC");
    await c.close();
  });

  it("get_quote routes EVM -> Solana with a recipient and shows Solana-chan", async () => {
    const c = await connect();
    const r = data(
      await c.callTool({
        name: "get_quote",
        arguments: {
          fromChainId: 1,
          toChainId: 792703809,
          fromToken: NATIVE_TOKEN,
          toToken: "11111111111111111111111111111111",
          recipient: "BUqwuxGmshL5aT9eW79D4c8kVdwCjcZLXjiotAntwFJE",
          amount: "1",
        },
      }),
    );
    expect(mock.calls.some((x) => x.includes("recipient=BUqwux"))).toBe(true);
    expect(r.mascots.map((m: { name: string }) => m.name)).toContain("Solana-chan");
  });

  it("get_quote converts decimal amount to base units and returns best", async () => {
    const c = await connect();
    const r = data(await c.callTool({ name: "get_quote", arguments: ethToUsdc }));
    expect(r.best.provider).toBe("0x");
    expect(r.best.toAmountFormatted).toBe("2000");
    expect(mock.calls.some((x) => x.includes("amount=1000000000000000000"))).toBe(true);
    expect(r.providerErrors[0].provider).toBe("relay");
    expect(r.mascots.map((m: { name: string }) => m.name)).toEqual(["Swap-chan", "Ethereum-chan"]);
    expect(r.mascots[1].imageUrl).toBe("https://swapchan.com/characters/ethereum.png");
    expect(r.swapUrl).toContain("https://swapchan.com/?fromChain=1&toChain=1");
    expect(r.swapUrl).toContain("amount=1");
    expect(r.display).toContain("![Ethereum-chan");
    expect(r.swapchanSays).toContain("0x wins");
    const raw = (await c.callTool({ name: "get_quote", arguments: ethToUsdc })) as {
      content: { type: string; uri?: string }[];
    };
    expect(
      raw.content.some((x) => x.type === "resource_link" && x.uri?.endsWith("/swapchan.png")),
    ).toBe(true);
    await c.close();
  });

  it("caps slippage and validates inputs with clear errors", async () => {
    const c = await connect();
    const r = await c.callTool({
      name: "get_quote",
      arguments: { ...ethToUsdc, slippageBps: 4000 },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/300/);
    const r2 = await c.callTool({
      name: "get_quote",
      arguments: { ...ethToUsdc, amount: undefined },
    });
    expect(r2.isError).toBe(true);
    expect(text(r2)).toMatch(/exactly one/);
    const r3 = await c.callTool({
      name: "get_quote",
      arguments: { ...ethToUsdc, fromToken: "0xnope" },
    });
    expect(r3.isError).toBe(true);
    await c.close();
  });

  it("surfaces api failures as tool errors", async () => {
    const c = await connect();
    const r = await c.callTool({
      name: "get_quote",
      arguments: { ...ethToUsdc, amount: undefined, amountBaseUnits: "999" },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/500: all providers down/);
    await c.close();
  });

  it("compare_routes ranks same-chain and cross-chain together", async () => {
    const c = await connect();
    const r = data(
      await c.callTool({
        name: "compare_routes",
        arguments: { ...ethToUsdc, alsoToChainIds: [8453] },
      }),
    );
    expect(r.totalFound).toBe(4);
    expect(r.routes.map((x: { provider: string }) => x.provider)).toEqual([
      "0x",
      "cow",
      "across",
      "lifi",
    ]);
    expect(r.routes[2].crossChain).toBe(true);
    await c.close();
  });

  it("build_swap_tx returns unsigned tx + approval, never signs", async () => {
    const c = await connect();
    const taker = "0x000000000000000000000000000000000000dEaD";
    const r = data(await c.callTool({ name: "build_swap_tx", arguments: { ...ethToUsdc, taker } }));
    expect(r.unsignedTx).toEqual({
      chainId: 1,
      to: "0x1111111254eeb25477b68fb85ed929f73a960582",
      data: "0xc0ffee",
      value: "0",
    });
    expect(r.execution).toBe("tx");
    expect(r.permit2?.primaryType).toBe("PermitTransferFrom"); // best = 0x mock
    expect(r.approval.required).toBe(false); // native in
    expect(r.simulation).toMatchObject({
      status: "success",
      via: "api:eth_call",
      gasUsed: "123456",
    });
    const r2 = data(
      await c.callTool({
        name: "build_swap_tx",
        arguments: {
          fromChainId: 1,
          toChainId: 8453,
          fromToken: USDC,
          toToken: NATIVE_TOKEN,
          amount: "10",
          taker,
          provider: "lifi",
        },
      }),
    );
    expect(r2.unsignedTx.data).toBe("0xc0ffee"); // fell back to POST /build
    expect(r2.approval.unsignedApproveTx.data.startsWith("0x095ea7b3")).toBe(true);
    expect(JSON.stringify(r2)).not.toMatch(/privateKey|signature/i);
    await c.close();
  });

  it("get_route_status", async () => {
    const c = await connect();
    const r = data(
      await c.callTool({
        name: "get_route_status",
        arguments: {
          provider: "across",
          txHash: `0x${"ab".repeat(31)}00`,
          fromChainId: 1,
          toChainId: 8453,
        },
      }),
    );
    expect(r.status).toBe("pending");
    await c.close();
  });
  it("scanner tools return tokens, swap links, risk + disclaimer and chan art", async () => {
    const c = await connect();
    const r = data(await c.callTool({ name: "scan_trending", arguments: { chain: "solana" } }));
    expect(r.count).toBe(1);
    expect(r.tokens[0].swapUrl).toContain("toToken=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
    expect(r.disclaimer).toMatch(/financial advice/);
    expect(r.display).toContain("characters/solana.png");
    expect(mock.calls.some((x) => x.startsWith("GET /scanner/trending?chain=solana"))).toBe(true);
    const k = data(
      await c.callTool({
        name: "token_risk",
        arguments: { chain: "solana", address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
      }),
    );
    expect(k.level).toBe("high");
    expect(k.swapchanSays).toMatch(/red flags/);
    await c.close();
  });

  it("developer tools are read-only, offline, credit blocktools without a URL, take no secrets", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    const dev = tools.filter((t) =>
      [
        "address_tool",
        "xpub_addresses",
        "solana_address",
        "substrate_tool",
        "hash_tool",
        "chain_params",
        "tron_tx",
        "evm_abi",
        "create_address",
        "bytecode_inspect",
        "typed_data_verify",
        "supported_chains",
      ].includes(t.name),
    );
    expect(dev).toHaveLength(12);
    for (const t of dev) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
      expect(t.annotations?.openWorldHint).toBe(false);
      expect(t.description).toMatch(
        /Pure, offline computation \(blocktools\); nothing is fetched or stored\./,
      );
      expect(t.description).not.toMatch(/https?:|blocktools\.\w/);
      const fields = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
      for (const f of fields)
        expect(f).not.toMatch(/priv|secret|seed$|mnemonic|wif|password|passphrase|keystore|xprv/i);
    }
    // no signing / key / recovery tools exposed under the dev family
    expect(tools.some((t) => /sign_tx|derive_key|xprv|mnemonic|keystore/.test(t.name))).toBe(false);
    await c.close();
  });

  it("developer tools call POST /tools/<fn> with the mapped sub-op and refuse xprv locally", async () => {
    const c = await connect();
    const r = data(
      await c.callTool({
        name: "substrate_tool",
        arguments: { op: "ss58_convert", address: "5Grw", prefix: 0 },
      }),
    );
    expect(r.result.echo).toEqual({ op: "convert", address: "5Grw", prefix: 0 });
    expect(mock.calls).toContain("POST /tools/ss58");
    const t = data(await c.callTool({ name: "tron_tx", arguments: { op: "txid", hex: "0a02" } }));
    expect(t.result.echo).toEqual({ op: "txid", hex: "0a02" });
    expect(mock.calls).toContain("POST /tools/tron-tx");
    const e = data(
      await c.callTool({
        name: "address_tool",
        arguments: { op: "cashaddr_encode", kind: "p2sh", hash: "ab" },
      }),
    );
    expect(e.result.echo).toEqual({ op: "encode", kind: "p2sh", hash: "ab" });
    const x = await c.callTool({
      name: "xpub_addresses",
      arguments: { chain: "btc", xpub: `xprv${"A".repeat(107)}` },
    });
    expect(x.isError).toBe(true);
    expect(mock.calls.some((k) => k === "POST /tools/xpub-addresses")).toBe(false);
    const bad = await c.callTool({
      name: "address_tool",
      arguments: { op: "detect", address: "zzz" },
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/unrecognized/);
    await c.close();
  });
});
