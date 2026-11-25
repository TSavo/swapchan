import { readFileSync } from "node:fs";
import { acrossRoute, batchAbi, checkAcrossAtomicOrigin, paymentContracts } from "@swapchan/shared";
import { type Address, decodeFunctionData, encodeFunctionData, type Hex } from "viem";
import { afterEach, expect, it, vi } from "vitest";
import sample from "./fixtures/across-exact-base-op.json";
import sepolia from "./fixtures/across-exact-sepolia.json";
import { paymentRoutes } from "./payment.js";

const intent = {
  sourceChainId: 8453,
  chainId: 10,
  sender: "0x182764751e965C703E2219FC9619326E11376747",
  recipient: "0xa11F5DA00D9a0E9b809E94c4cAe1efa36E8ff50b",
  amountMicroUsdc: "1000000",
};
function app(
  result: typeof sample,
  balance = 0n,
  allowance = 0n,
  depositReverts = false,
  feeUnavailable = false,
  native = "0x0",
  delegation: "none" | "verified" | "changed" | "revert" = "none",
) {
  const fixture = result.swapTx.chainId === 84532 ? sepolia : sample;
  const route = acrossRoute(result.swapTx.chainId === 84532 ? 11155420 : 10);
  vi.spyOn(Date, "now").mockReturnValue((fixture.quoteExpiryTimestamp - 100) * 1000);
  return paymentRoutes(
    async (url, init) => {
      if (
        String(url) ===
        (route.origin === 84532 ? "https://sepolia.base.org" : "https://mainnet.base.org")
      ) {
        const { method, params } = JSON.parse(String(init?.body));
        if (method === "eth_blockNumber") return Response.json({ result: "0xabc" });
        if (method === "eth_gasPrice") return Response.json({ result: "0xa" });
        if (method === "eth_maxPriorityFeePerGas") return Response.json({ result: "0x1" });
        expect(params.at(-1)).toBe("0xabc");
        if (method === "eth_getCode") {
          if (delegation === "none") return Response.json({ result: "0x" });
          if (params[0].toLowerCase() === intent.sender.toLowerCase())
            return Response.json({ result: "0xef0100" + paymentContracts.delegate.slice(2) });
          expect(params[0]).toBe(paymentContracts.delegate);
          return Response.json({
            result:
              delegation === "changed"
                ? "0x6000"
                : readFileSync(
                    new URL("./fixtures/base-sepolia-simple7702.hex", import.meta.url),
                    "utf8",
                  ).trim(),
          });
        }
        if (method === "eth_getTransactionCount") return Response.json({ result: "0x3" });
        if (
          method === "eth_call" &&
          params[0].to === "0x420000000000000000000000000000000000000F"
        ) {
          if (feeUnavailable) return Response.json({ error: { message: "oracle unavailable" } });
          return Response.json({ result: "0x" + "2".padStart(64, "0") });
        }
        if (method === "eth_simulateV1") {
          const calls = params[0].blockStateCalls[0].calls;
          if (calls.length === 1 && calls[0].to === intent.sender) {
            checkAcrossAtomicOrigin(
              { ...calls[0], value: "0x0", chainId: 84532 },
              {
                ...intent,
                sender: intent.sender as Address,
                recipient: intent.recipient as Address,
                chainId: 11155420,
                maxInputMicroUsdc: result.maxInputAmount,
                expiresAt: result.quoteExpiryTimestamp,
              },
              result.inputAmount,
            );
            return Response.json({
              result: [
                {
                  calls: [
                    {
                      status: delegation === "revert" ? "0x0" : "0x1",
                      returnData: "0x",
                      gasUsed: "0x100",
                    },
                  ],
                },
              ],
            });
          }
          expect(calls.at(-1)).toMatchObject({
            from: intent.sender,
            to: fixture.swapTx.to,
            data: fixture.swapTx.data,
          });
          const needsApproval = allowance < BigInt(result.inputAmount);
          expect(calls).toHaveLength(needsApproval ? 2 : 1);
          if (needsApproval)
            expect(calls[0].data).toBe(
              "0x095ea7b3" +
                fixture.swapTx.to.slice(2).toLowerCase().padStart(64, "0") +
                BigInt(result.inputAmount).toString(16).padStart(64, "0"),
            );
          return Response.json({
            result: [
              {
                calls: calls.map((_: unknown, i: number) => ({
                  status: depositReverts && i === calls.length - 1 ? "0x0" : "0x1",
                  gasUsed: "0x100",
                  returnData: needsApproval && i === 0 ? "0x" + "0".repeat(63) + "1" : "0x",
                })),
              },
            ],
          });
        }
        if (method === "eth_getBalance") return Response.json({ result: native });
        expect(method).toBe("eth_call");
        expect(params[0].to.toLowerCase()).toBe(route.sourceToken.toLowerCase());
        const calldata = String(params[0].data).toLowerCase();
        const arg = intent.sender.slice(2).toLowerCase().padStart(64, "0");
        const spender = route.pool.toLowerCase().slice(2).padStart(64, "0");
        expect(["0x70a08231" + arg, "0xdd62ed3e" + arg + spender]).toContain(calldata);
        return Response.json({
          result:
            "0x" +
            (calldata.startsWith("0x70a08231") ? balance : allowance)
              .toString(16)
              .padStart(64, "0"),
        });
      }
      const p = new URL(String(url)).searchParams;
      expect(p.get("tradeType")).toBe("exactOutput");
      expect(p.get("recipient")).toBe(intent.recipient);
      return Response.json(result);
    },
    undefined,
    true,
  );
}
function post(app: ReturnType<typeof paymentRoutes>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function quote(...args: Parameters<typeof app>) {
  return post(app(...args), "/quote", intent);
}
it.each([false, true])("keeps a funded mainnet route read-only (approved=%s)", async (approved) => {
  const amount = BigInt(sample.inputAmount);
  const test = app(sample, amount, approved ? amount : 0n, false, false, "0xffff");
  const q = await (await post(test, "/quote", intent)).json();
  expect(q.execution).toBe("quote_only");
  expect(
    (await post(test, "/cross-chain/build", { quoteId: q.quoteId, stage: "initial" })).status,
  ).toBe(403);
});
it.each([false, true])(
  "builds only the next simulated testnet step (approved=%s)",
  async (approved) => {
    const amount = BigInt(sepolia.inputAmount);
    const providerTerms = structuredClone(sepolia);
    const a = app(providerTerms, amount, approved ? amount : 0n, false, false, "0xffff");
    const q = await (
      await post(a, "/quote", { ...intent, sourceChainId: 84532, chainId: 11155420 })
    ).json();
    expect(q.execution).toBe("unsigned_origin_steps");
    // Future provider quotes can change. The build must simulate the retained deposit.
    providerTerms.expectedOutputAmount = "2";
    expect(
      await (await post(a, "/cross-chain/build", { quoteId: q.quoteId, stage: "initial" })).json(),
    ).toMatchObject({
      action: approved ? "deposit" : "approve",
      unsignedTransaction: { chainId: 84532 },
    });
    expect(
      (await post(a, "/cross-chain/build", { quoteId: q.quoteId, stage: "after_approval" })).status,
    ).toBe(approved ? 200 : 409);
  },
);
it.each(["none", "verified", "changed", "revert"] as const)(
  "binds atomic origin execution to a verified delegate and successful outer simulation (%s)",
  async (mode) => {
    const a = app(sepolia, BigInt(sepolia.inputAmount), 0n, false, false, "0xffff", mode);
    const target = { ...intent, sourceChainId: 84532, chainId: 11155420 };
    const q = await (await post(a, "/quote", target)).json();
    const build = await post(a, "/cross-chain/build", {
      quoteId: q.quoteId,
      stage: "atomic_origin",
    });
    if (mode !== "verified") {
      expect(q.atomicOrigin).toBeNull();
      expect(build.status).toBe(422);
      return;
    }
    expect(q.atomic).toBe(false);
    expect(q.atomicOrigin.delegate).toBe(paymentContracts.delegate);
    expect(build.status).toBe(200);
    const { action, unsignedTransaction: tx } = await build.json();
    expect(action).toBe("atomic_origin");
    const review = {
      ...target,
      sender: intent.sender as Address,
      recipient: intent.recipient as Address,
      maxInputMicroUsdc: q.maxInputMicroUsdc,
      expiresAt: q.expiresAt,
    };
    expect(() => checkAcrossAtomicOrigin(tx, review, q.inputMicroUsdc)).not.toThrow();
    expect(() =>
      checkAcrossAtomicOrigin(
        tx,
        { ...review, fillDeadline: q.fillDeadline + 1 },
        q.inputMicroUsdc,
      ),
    ).toThrow();
    const [calls] = decodeFunctionData({ abi: batchAbi, data: tx.data as Hex }).args;
    for (const bad of [
      [...calls].reverse(),
      [...calls, calls[0]!],
      [{ ...calls[0]!, value: 1n }, calls[1]!],
    ]) {
      const data = encodeFunctionData({ abi: batchAbi, functionName: "executeBatch", args: [bad] });
      expect(() => checkAcrossAtomicOrigin({ ...tx, data }, review, q.inputMicroUsdc)).toThrow();
    }
  },
);
it("quotes the lower simulated gas shortfall without enabling an unfunded batch", async () => {
  const a = app(sepolia, BigInt(sepolia.inputAmount), 0n, false, false, "0x1", "verified");
  const comparison = await (
    await post(a, "/quote", {
      sender: intent.sender,
      recipient: intent.recipient,
      amountMicroUsdc: intent.amountMicroUsdc,
      chainId: 11155420,
    })
  ).json();
  const q = comparison.routes.find((route: { provider: string }) => route.provider === "across");
  expect(q.execution).toBe("quote_only");
  expect(q.atomicOrigin).toBeNull();
  expect(q.fundingFeeWei).toBe(q.originGas.atomicEstimateWei);
  expect(BigInt(q.fundingFeeWei)).toBeLessThan(BigInt(q.originGas.estimate.totalWei));
  expect(q.fundingShortfall).toEqual({
    microUsdc: "0",
    estimatedWei: String(BigInt(q.fundingFeeWei) - 1n),
  });
  expect(comparison.recommendedQuoteId).toBeNull();
  expect(
    (await post(a, "/cross-chain/build", { quoteId: q.quoteId, stage: "atomic_origin" })).status,
  ).toBe(422);
});
it("offers only the atomic path when the wallet can afford one batch but cannot afford two transactions", async () => {
  const a = app(sepolia, BigInt(sepolia.inputAmount), 0n, false, false, "0xbbb", "verified");
  const q = await (
    await post(a, "/quote", { ...intent, sourceChainId: 84532, chainId: 11155420 })
  ).json();
  expect(q.execution).toBe("unsigned_atomic_origin");
  expect(
    (await post(a, "/cross-chain/build", { quoteId: q.quoteId, stage: "atomic_origin" })).status,
  ).toBe(200);
  expect(
    (await post(a, "/cross-chain/build", { quoteId: q.quoteId, stage: "initial" })).status,
  ).toBe(422);
});
it("checks only local holdings for an ordinary Optimism send", async () => {
  const hosts = new Set<string>();
  const a = paymentRoutes(
    async (url, init) => {
      hosts.add(String(url));
      const { method } = JSON.parse(String(init?.body));
      return Response.json({
        result:
          method === "eth_getCode" ? "0x" : method === "eth_call" ? "0x" + "0".repeat(64) : "0x1",
      });
    },
    undefined,
    true,
  );
  const { sourceChainId, ...local } = intent;
  const q = await (await post(a, "/quote", local)).json();
  expect(q.routes).toHaveLength(1);
  expect(q.routes[0]).toMatchObject({
    provider: "direct_transfer",
    sourceChainId: 10,
    execution: "quote_only",
  });
  expect([...hosts]).toEqual(["https://mainnet.optimism.io"]);
});
it("withholds unsigned calls for an unfunded review", async () => {
  const test = app(sample);
  const q = await (await post(test, "/quote", intent)).json();
  const r = await post(test, "/cross-chain/build", { quoteId: q.quoteId, stage: "initial" });
  expect(r.status).toBe(403);
  expect(await r.json()).toEqual({ error: "mainnet_payment_build_disabled" });
});
afterEach(() => vi.restoreAllMocks());
it("decodes the exact USDC deposit on a live Base to Optimism quote", async () => {
  const r = await quote(sample);
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({
    execution: "quote_only",
    originSimulation: { status: "insufficient_usdc" },
    atomic: false,
    amountMicroUsdc: "1000000",
    maxInputMicroUsdc: sample.maxInputAmount,
    sourceWallet: {
      blockNumber: "0xabc",
      depositShortfallMicroUsdc: sample.inputAmount,
      requiredApprovalMicroUsdc: sample.inputAmount,
    },
  });
});
it("requires the full approval amount only when the existing allowance is insufficient", async () => {
  const amount = BigInt(sample.inputAmount);
  for (const [existing, required] of [
    [amount, "0"],
    [amount - 1n, sample.inputAmount],
  ] as const) {
    expect(await (await quote(sample, amount, existing)).json()).toMatchObject({
      originSimulation: { status: "succeeded" },
      originGas: { estimate: { totalWei: required === "0" ? "2564" : "5128" } },
      sourceWallet: { depositShortfallMicroUsdc: "0", requiredApprovalMicroUsdc: required },
    });
  }
});
it("keeps unknown fees separate from a successful origin simulation", async () => {
  const r = await quote(sample, BigInt(sample.inputAmount), 0n, false, true);
  expect(await r.json()).toMatchObject({
    originSimulation: { status: "succeeded" },
    originGas: { estimate: null, estimatedShortfallWei: null },
  });
});
it("reports a reverted deposit even when the preceding approval succeeds", async () => {
  expect(await (await quote(sample, BigInt(sample.inputAmount), 0n, true)).json()).toMatchObject({
    execution: "quote_only",
    originSimulation: { status: "reverted" },
  });
});
it.each(["recipient", "payout", "cap", "pool", "expiry", "calldata suffix"])(
  "rejects a mismatched %s",
  async (field) => {
    const bad = structuredClone(sample);
    if (field === "recipient")
      bad.swapTx.data = bad.swapTx.data.replace(
        intent.recipient.slice(2).toLowerCase(),
        intent.sender.slice(2).toLowerCase(),
      );
    if (field === "payout") bad.expectedOutputAmount = "1000001";
    if (field === "cap") bad.maxInputAmount = "1";
    if (field === "pool") bad.swapTx.to = intent.sender;
    if (field === "expiry") bad.quoteExpiryTimestamp = 1;
    if (field === "calldata suffix") bad.swapTx.data += "01";
    expect((await quote(bad)).status).toBe(503);
  },
);
