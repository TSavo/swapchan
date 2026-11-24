import { afterEach, expect, it, vi } from "vitest";
import sample from "./fixtures/across-exact-base-op.json";
import { paymentRoutes } from "./payment.js";

const intent = {
  sourceChainId: 8453,
  chainId: 10,
  sender: "0x182764751e965C703E2219FC9619326E11376747",
  recipient: "0xa11F5DA00D9a0E9b809E94c4cAe1efa36E8ff50b",
  amountMicroUsdc: "1000000",
};
function quote(
  result: typeof sample,
  balance = 0n,
  allowance = 0n,
  depositReverts = false,
  feeUnavailable = false,
) {
  vi.spyOn(Date, "now").mockReturnValue((sample.quoteExpiryTimestamp - 100) * 1000);
  return paymentRoutes(async (url, init) => {
    if (String(url) === "https://mainnet.base.org") {
      const { method, params } = JSON.parse(String(init?.body));
      if (method === "eth_blockNumber") return Response.json({ result: "0xabc" });
      if (method === "eth_gasPrice") return Response.json({ result: "0xa" });
      if (method === "eth_maxPriorityFeePerGas") return Response.json({ result: "0x1" });
      expect(params.at(-1)).toBe("0xabc");
      if (method === "eth_getTransactionCount") return Response.json({ result: "0x3" });
      if (method === "eth_call" && params[0].to === "0x420000000000000000000000000000000000000F") {
        if (feeUnavailable) return Response.json({ error: { message: "oracle unavailable" } });
        return Response.json({ result: "0x" + "2".padStart(64, "0") });
      }
      if (method === "eth_simulateV1") {
        const calls = params[0].blockStateCalls[0].calls;
        expect(calls.at(-1)).toMatchObject({
          from: intent.sender,
          to: sample.swapTx.to,
          data: sample.swapTx.data,
        });
        const needsApproval = allowance < BigInt(result.inputAmount);
        expect(calls).toHaveLength(needsApproval ? 2 : 1);
        if (needsApproval)
          expect(calls[0].data).toBe(
            "0x095ea7b3" +
              sample.swapTx.to.slice(2).toLowerCase().padStart(64, "0") +
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
      if (method === "eth_getBalance") return Response.json({ result: "0x0" });
      expect(method).toBe("eth_call");
      expect(params[0].to.toLowerCase()).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
      const calldata = String(params[0].data).toLowerCase();
      const arg = intent.sender.slice(2).toLowerCase().padStart(64, "0");
      const spender = "09aea4b2242abc8bb4bb78d537a67a245a7bec64".padStart(64, "0");
      expect(["0x70a08231" + arg, "0xdd62ed3e" + arg + spender]).toContain(calldata);
      return Response.json({
        result:
          "0x" +
          (calldata.startsWith("0x70a08231") ? balance : allowance).toString(16).padStart(64, "0"),
      });
    }
    const p = new URL(String(url)).searchParams;
    expect(p.get("tradeType")).toBe("exactOutput");
    expect(p.get("recipient")).toBe(intent.recipient);
    return Response.json(result);
  }).request("/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(intent),
  });
}
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
