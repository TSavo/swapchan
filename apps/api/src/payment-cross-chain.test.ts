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
function quote(result: typeof sample) {
  vi.spyOn(Date, "now").mockReturnValue((sample.quoteExpiryTimestamp - 100) * 1000);
  return paymentRoutes(async (url) => {
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
