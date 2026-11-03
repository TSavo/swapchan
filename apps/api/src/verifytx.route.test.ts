// HTTP-level tests for POST /onchain/verify-tx: expected.spender / expected.amount must survive the
// route body schema and reach verifyTx (a zod schema without them silently stripped both).
import { Hono } from "hono";
import { encodeFunctionData, parseAbi } from "viem";
import { describe, expect, it, vi } from "vitest";

vi.mock("./onchain.js", async (orig) => {
  const m = (await orig()) as Record<string, unknown>;
  // No network: every RPC call on the client fails, so only offline calldata checks decide.
  const dead = new Proxy({}, { get: () => () => Promise.reject(new Error("offline test")) });
  return { ...m, evmClient: () => dead };
});

const { intelRoutes } = await import("./intel.js");

const ME = "0xeb0eC7a28E4B6B175806E21D9D3afE45792C5c7B";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ROUTER = "0x111111125421cA6dc452d289314280a0f8842A65";
const DRAINER = "0x000000000000000000000000000000000000dEaD";
const abi = parseAbi(["function approve(address,uint256)", "function multicall(bytes[] data)"]);
const approve = (s: `0x${string}`, n: bigint) =>
  encodeFunctionData({ abi, functionName: "approve", args: [s, n] });

const noFetch = (() => Promise.reject(new Error("offline test"))) as unknown as typeof fetch;
const app = new Hono();
app.route("/onchain", intelRoutes(noFetch as never, {}, null, (async () => null) as never, null));
const post = (body: unknown) =>
  app.request("/onchain/verify-tx", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
type Res = { verdict?: string; findings?: { check: string }[]; error?: string };
const checks = (r: Res) => (r.findings ?? []).map((x) => x.check);

describe("POST /onchain/verify-tx expected.spender / amount", () => {
  it("wrong spender is danger with spender-not-expected", async () => {
    const res = await post({
      chainId: 1,
      tx: { from: ME, to: USDC, data: approve(DRAINER, 1234n), value: "0" },
      expected: { spender: ROUTER },
    });
    const j = (await res.json()) as Res;
    expect(res.status, JSON.stringify(j)).toBe(200);
    expect(j.verdict).toBe("danger");
    expect(checks(j)).toContain("spender-not-expected");
  });
  it("matching spender + amount gives no spender/amount flags", async () => {
    const res = await post({
      chainId: 1,
      tx: { from: ME, to: USDC, data: approve(ROUTER, 1234n), value: "0" },
      expected: { spender: ROUTER.toLowerCase(), amount: "1234" },
    });
    const j = (await res.json()) as Res;
    expect(res.status, JSON.stringify(j)).toBe(200);
    expect(checks(j)).not.toContain("spender-not-expected");
    expect(checks(j)).not.toContain("amount-not-expected");
    expect(checks(j)).not.toContain("spender-unchecked");
  });
  it("amount without spender is 400 expected_amount_needs_spender", async () => {
    const res = await post({
      chainId: 1,
      tx: { from: ME, to: USDC, data: approve(ROUTER, 1n), value: "0" },
      expected: { amount: "1" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Res).error).toMatch(/expected_amount_needs_spender/);
  });
  it("bad spender / bad amount are 400", async () => {
    const tx = { from: ME, to: USDC, data: approve(ROUTER, 1n), value: "0" };
    const a = await post({ chainId: 1, tx, expected: { spender: "0x12" } });
    expect(a.status).toBe(400);
    expect(((await a.json()) as Res).error).toMatch(/bad_expected_spender/);
    const b = await post({ chainId: 1, tx, expected: { spender: ROUTER, amount: "-1" } });
    expect(b.status).toBe(400);
    expect(((await b.json()) as Res).error).toMatch(/bad_expected_amount/);
  });
  it.each(["solana", "tron"])("%s with spender is 400 expected_spender_evm_only", async (c) => {
    const res = await post({ chainId: c, tx: "AA==", expected: { spender: ROUTER } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Res).error).toMatch(/expected_spender_evm_only/);
  });
  it("multicall with an inner wrong-spender approval is danger", async () => {
    const mc = encodeFunctionData({
      abi,
      functionName: "multicall",
      args: [[approve(DRAINER, 5n)]],
    });
    const res = await post({
      chainId: 1,
      tx: { from: ME, to: ROUTER, data: mc, value: "0" },
      expected: { spender: ROUTER },
    });
    const j = (await res.json()) as Res;
    expect(res.status, JSON.stringify(j)).toBe(200);
    expect(j.verdict).toBe("danger");
    expect(checks(j)).toContain("spender-not-expected");
  });
});
