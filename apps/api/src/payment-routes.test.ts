import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paymentContracts as c, paymentGasLimits } from "@swapchan/shared";
import { type Hex, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { paymentRoutes } from "./payment.js";
import { openPaymentStore } from "./payment-store.js";

const runtime = readFileSync(
  new URL("./fixtures/base-sepolia-simple7702.hex", import.meta.url),
  "utf8",
).trim();
function setup(
  failure: "relay" | "simulation" | "none" | "delegate",
  freshWeth?: bigint,
  store?: ReturnType<typeof openPaymentStore>,
) {
  const account = privateKeyToAccount(generatePrivateKey());
  let sendCount = 0;
  const fetchRpc: typeof fetch = async (_, init) => {
    const { method, params } = JSON.parse(String(init?.body));
    let result: unknown;
    switch (method) {
      case "eth_blockNumber":
        result = "0x10";
        break;
      case "pimlico_getUserOperationGasPrice":
        result = { standard: { maxFeePerGas: "0x7026f0", maxPriorityFeePerGas: "0x100590" } };
        break;
      case "pimlico_getTokenQuotes":
        result = {
          quotes: [{ token: c.usdc, paymaster: c.paymaster, exchangeRate: "0x77359400" }],
        };
        break;
      case "eth_getCode":
        if (params[0].toLowerCase() === c.delegate.toLowerCase()) {
          result = failure === "delegate" ? "0x6000" : runtime;
          break;
        }
        result = freshWeth === undefined ? "0xef0100" + c.delegate.slice(2) : "0x";
        break;
      case "eth_getTransactionCount":
        result = "0x0";
        break;
      case "eth_call":
        if (freshWeth !== undefined) {
          const target = params[0].to.toLowerCase();
          if (target === c.usdc.toLowerCase()) result = "0x0";
          else if (target === c.weth.toLowerCase()) result = toHex(freshWeth);
          else result = toHex(10000n, { size: 32 }) + "0".repeat(192);
        } else result = params[0].to.toLowerCase() === c.usdc.toLowerCase() ? "0xffff" : "0x0";
        break;
      case "pm_getPaymasterStubData":
      case "pm_getPaymasterData":
        result = { paymaster: c.paymaster, paymasterData: "0x01" };
        break;
      case "eth_estimateUserOperationGas":
        if (failure === "simulation") throw Error("simulation rejected");
        result = Object.fromEntries(
          Object.entries(paymentGasLimits(true)).map(([k, v]) => [k, toHex(v)]),
        );
        break;
      case "eth_sendUserOperation":
        sendCount++;
        if (failure === "relay") throw Error("connection lost after request");
        throw Error("unexpected relay");
      case "eth_getUserOperationReceipt":
        result = null;
        break;
      default:
        throw Error(method);
    }
    return Response.json({ jsonrpc: "2.0", id: 1, result });
  };
  const app = paymentRoutes(fetchRpc, store, true);
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const quote = () =>
    post("/quote", {
      chainId: 84532,
      sender: account.address,
      recipient: c.router,
      amountMicroUsdc: "1",
    }).then((r) => r.json());
  return { app, account, post, quote, fetchRpc, sendCount: () => sendCount };
}
describe("payment build and relay", () => {
  it("retains the reviewed quote and the exact simulated bundle across two restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "payment-restart-"));
    const file = join(dir, "payments.db");
    let store = openPaymentStore(file);
    try {
      const h = setup("none", undefined, store);
      const { quoteId } = await h.quote();
      store.close();
      store = openPaymentStore(file);
      const post = (path: string, body: unknown) =>
        paymentRoutes(h.fetchRpc, store, true).request(path, {
          method: "POST",
          body: JSON.stringify(body),
        });
      const { userOpHash, userOperation } = await (await post("/build", { quoteId })).json();
      expect(userOpHash).toMatch(/^0x[0-9a-f]{64}$/);
      store.close();
      store = openPaymentStore(file);
      expect(
        await (await post("/verify", { quoteId, userOpHash, userOperation })).json(),
      ).toMatchObject({ status: "verified", userOpHash });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it.each(["/cross-chain/build", "/build", "/submit", "/verify"])(
    "keeps %s disabled by default",
    async (path) => {
      const app = paymentRoutes(() => {
        throw Error("Unexpected RPC");
      });
      expect((await app.request(path, { method: "POST", body: "{}" })).status).toBe(403);
    },
  );
  it("independently verifies a built operation and rejects changed bytes before signing", async () => {
    const h = setup("none");
    const { quoteId } = await h.quote();
    const { userOperation, userOpHash } = await (await h.post("/build", { quoteId })).json();
    expect(
      await (await h.post("/verify", { quoteId, userOperation, userOpHash })).json(),
    ).toMatchObject({ status: "verified", userOpHash, amountMicroUsdc: "1" });
    expect(
      (
        await h.post("/verify", {
          quoteId,
          userOpHash,
          userOperation: { ...userOperation, callData: "0x" },
        })
      ).status,
    ).toBe(422);
    expect(h.sendCount()).toBe(0);
  });
  it("selects the quoted token gas cap for each payment mode", async () => {
    for (const [balance, mode] of [
      [undefined, "delegatedUsdc"],
      [10500n, "swapOrSetup"],
    ] as const) {
      const h = setup("none", balance);
      const gas = await (await h.post("/gas-quote", { chainId: 84532 })).json();
      expect(BigInt(gas.maxGasMicroUsdc.delegatedUsdc)).toBeLessThan(
        BigInt(gas.maxGasMicroUsdc.swapOrSetup),
      );
      expect(gas).toMatchObject({ token: c.usdc, paymaster: c.paymaster, decimals: 6 });
      expect((await h.quote()).maxGasMicroUsdc).toBe(gas.maxGasMicroUsdc[mode]);
    }
  });
  it("withholds the signing request when the approved address has different runtime code", async () => {
    const h = setup("delegate");
    const { quoteId } = await h.quote();
    expect(await (await h.post("/build", { quoteId })).json()).toEqual({
      error: "unverified_delegate_runtime",
    });
    expect(h.sendCount()).toBe(0);
  });
  it("reports the active delegate, verified runtime and chain-specific revocation nonce", async () => {
    const h = setup("none");
    const result = await h.post("/delegation", {
      sender: h.account.address,
      chainId: 84532,
      proposedDelegate: c.delegate,
    });
    expect(await result.json()).toMatchObject({
      accountType: "delegated",
      existing: { known: true },
      proposed: { known: true },
      revocation: { chainId: 84532, nonce: "0", address: "0x" + "0".repeat(40) },
    });
  });
  it("uses the available WETH for slippage when it covers the exact output", async () => {
    expect(await setup("none", 10010n).quote()).toMatchObject({
      maxWethWei: "10010",
      requiresDelegation: true,
    });
    expect(await setup("none", 9999n).quote()).toMatchObject({
      error: "insufficient_WETH",
      requiredWei: "10100",
    });
  });
  it("withholds the signing request after failed full-operation simulation", async () => {
    const h = setup("simulation");
    const { quoteId } = await h.quote();
    const r = await h.post("/build", { quoteId });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: "payment_build_or_simulation_failed" });
    expect(h.sendCount()).toBe(0);
  });
  it("recovers an ambiguous relay by the exact signed hash", async () => {
    const h = setup("relay");
    const { quoteId } = await h.quote();
    const built = await (await h.post("/build", { quoteId })).json();
    const userOpHash = built.userOpHash as Hex;
    const signature = await h.account.sign({ hash: userOpHash });
    const sent = await h.post("/submit", { quoteId, userOpHash, signature });
    expect(sent.status).toBe(202);
    const expected = { status: "submission_unconfirmed", userOpHash };
    expect(await sent.json()).toEqual(expected);
    expect(await (await h.app.request("/status/" + userOpHash)).json()).toEqual(expected);
    expect(h.sendCount()).toBe(1);
  });
});
