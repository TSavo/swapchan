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
function quote(result: typeof sample, balance = 0n, allowance = 0n) {
  vi.spyOn(Date, "now").mockReturnValue((sample.quoteExpiryTimestamp - 100) * 1000);
  return paymentRoutes(async (url, init) => {
    if (String(url) === "https://mainnet.base.org") {
      const { method, params } = JSON.parse(String(init?.body));
      if (method === "eth_blockNumber") return Response.json({ result: "0xabc" });
      expect(params.at(-1)).toBe("0xabc");
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
      sourceWallet: { depositShortfallMicroUsdc: "0", requiredApprovalMicroUsdc: required },
    });
  }
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
