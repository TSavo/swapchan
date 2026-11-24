import { expect, it } from "vitest";
import sample from "./fixtures/across-settled-base-op.json";
import { crossSettlement, settlementInput } from "./payment-cross-settlement.js";

const sender = "0x46e25D3756e1Be06c3B477170c3A4DBA6528C7A9";
const intent = settlementInput.parse({
  originHash: sample.origin.transactionHash,
  fillHash: sample.destination.transactionHash,
  sender,
  recipient: sender,
  sourceChainId: 8453,
  chainId: 10,
  amountMicroUsdc: "13440834",
  maxInputMicroUsdc: "13442407",
});
function verify(
  receipts = sample,
  isFinal = true,
  cap = intent.maxInputMicroUsdc,
  lookup?: typeof fetch,
  finalizedTimestamp?: string,
) {
  return crossSettlement(
    async (chain, method, params) => {
      const r = chain === 8453 ? receipts.origin : receipts.destination;
      if (method === "eth_getTransactionReceipt") return r;
      if (params[0] === "finalized")
        return { number: isFinal ? r.blockNumber : "0x0", timestamp: finalizedTimestamp };
      return { hash: r.blockHash };
    },
    { ...intent, maxInputMicroUsdc: cap, fillHash: lookup ? undefined : intent.fillHash },
    lookup,
  );
}
const indexResult = {
  status: "filled",
  originChainId: 8453,
  destinationChainId: 10,
  depositId: "6488685",
  depositTxnRef: intent.originHash,
  fillTxnRef: intent.fillHash,
};
it("uses the index to locate the fill for an origin-only request", async () => {
  expect(
    await verify(sample, true, intent.maxInputMicroUsdc, async (url) => {
      expect(new URL(String(url)).searchParams.get("depositTxnRef")).toBe(intent.originHash);
      return Response.json(indexResult);
    }),
  ).toMatchObject({ status: "settled", fillHash: intent.fillHash });
});
it("rejects a fill hint for a different deposit", async () => {
  await expect(
    verify(sample, true, intent.maxInputMicroUsdc, async () =>
      Response.json({ ...indexResult, depositId: "1" }),
    ),
  ).rejects.toThrow();
});
it("reports a provider refund separately from verified settlement", async () => {
  expect(
    await verify(sample, true, intent.maxInputMicroUsdc, async () =>
      Response.json({ ...indexResult, status: "refunded", fillTxnRef: null }),
    ),
  ).toMatchObject({ status: "recovery_reported", providerStatus: "refunded" });
});
it("reports a finalized destination deadline separately from a fill or refund", async () => {
  const pending = async () =>
    Response.json({ ...indexResult, status: "pending", fillTxnRef: null });
  const before = await verify(sample, true, undefined, pending, "0x1");
  expect(before.status).toBe("awaiting_verified_fill");
  const after = await verify(sample, true, undefined, pending, "0xffffffff");
  expect(after).toMatchObject({ status: "fill_deadline_passed", providerStatus: "pending" });
});
it("reconciles the historical Base deposit with the finalized Optimism payout", async () => {
  expect(await verify()).toMatchObject({
    status: "settled",
    depositId: "6488685",
    spentMicroUsdc: "13442407",
    paidMicroUsdc: "13440834",
  });
});
it("waits for finality on both chains", async () =>
  expect(await verify(sample, false)).toMatchObject({ status: "awaiting_finality" }));
it("reads deposit execution and L1 data fees independently from the origin receipt", async () => {
  const receipts = structuredClone(sample);
  Object.assign(receipts.origin, { gasUsed: "0x100", effectiveGasPrice: "0x10", l1Fee: "0x2a" });
  expect(await verify(receipts)).toMatchObject({
    depositExecutionFeeWei: "4096",
    depositL1DataFeeWei: "42",
  });
});
it("locates the intended fill within a relayer batch and rejects duplicate matches", async () => {
  const batch = structuredClone(sample);
  const anotherFill = structuredClone(batch.destination.logs[0]!);
  batch.destination.logs.push(anotherFill);
  await expect(verify(batch)).rejects.toThrow("Ambiguous");
  anotherFill.topics[2] = "0x" + "0".repeat(64);
  expect(await verify(batch)).toMatchObject({ status: "settled", depositId: "6488685" });
});
it("requires the reviewed source cap", async () =>
  expect(verify(sample, true, "13442406")).rejects.toThrow());
it.each(["transfer", "fill", "origin hash", "deposit id"])(
  "refuses missing or changed %s",
  async (field) => {
    const r = structuredClone(sample);
    if (field === "transfer") r.destination.logs.pop();
    if (field === "fill") r.destination.logs.shift();
    if (field === "origin hash") r.origin.transactionHash = r.destination.transactionHash;
    if (field === "deposit id") r.destination.logs[0]!.topics[2] = "0x" + "0".repeat(64);
    await expect(verify(r)).rejects.toThrow();
  },
);
