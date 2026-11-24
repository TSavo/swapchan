import { type PaymentQuote } from "@swapchan/shared";
import { describe, expect, it } from "vitest";
import { paymentRoutes } from "./payment.js";
import fixture from "./payment-receipt.fixture.json";
import { chainReceipt, operationReceipt, reconcilePayment } from "./payment-receipt.js";
import { openPaymentStore } from "./payment-store.js";

const operation = operationReceipt.parse({ ...fixture, logs: [] });
const receipt = chainReceipt.parse({ ...fixture.receipt, logs: fixture.logs });
const quote: PaymentQuote = {
  chainId: 84532,
  sender: "0x18eE1D19Ab2030e5dd6f52c6be152ffeA0d08c0D",
  recipient: "0xa11F5DA00D9a0E9b809E94c4cAe1efa36E8ff50b",
  amountMicroUsdc: "1",
  maxGasMicroUsdc: "6996",
  maxWethWei: "0",
  swapOutputMicroUsdc: "0",
  requiresDelegation: false,
  expiresAt: 0,
  maxFeePerGas: "0x7026f0",
  maxPriorityFeePerGas: "0x100590",
};
describe("canonical repeat-payment receipt", () => {
  it("requires a finalized canonical block before reporting the payment settled", async () => {
    const store = openPaymentStore();
    try {
      store.remember(operation.userOpHash, quote);
      let finalizedHeight = "0x0";
      let inclusionHash = receipt.blockHash;
      const app = paymentRoutes(async (_url, init) => {
        const { method, params } = JSON.parse(String(init?.body));
        if (method === "eth_getUserOperationReceipt") return Response.json({ result: operation });
        if (method === "eth_getTransactionReceipt") return Response.json({ result: receipt });
        if (method === "eth_call") return Response.json({ result: "0x0" });
        expect(method).toBe("eth_getBlockByNumber");
        if (params[0] === "finalized")
          return Response.json({ result: { number: finalizedHeight } });
        expect(params).toEqual([receipt.blockNumber, false]);
        return Response.json({ result: { hash: inclusionHash } });
      }, store);
      const status = () => app.request("/status/" + operation.userOpHash).then((r) => r.json());
      expect(await status()).toMatchObject({ status: "awaiting_finality", finalized: false });
      finalizedHeight = receipt.blockNumber;
      expect(await status()).toMatchObject({
        status: "settled",
        finalized: true,
        paidMicroUsdc: "1",
      });
      inclusionHash = "0x" + "00".repeat(32);
      expect(await status()).toMatchObject({ error: "settlement_unverified" });
    } finally {
      store.close();
    }
  });
  it("finds the exact payout and fee independently of the bundler's log selection", () => {
    expect(reconcilePayment(quote, operation.userOpHash, operation, receipt)).toMatchObject({
      status: "settled",
      paidMicroUsdc: "1",
      gasChargedMicroUsdc: "2246",
      spentWethWei: "0",
    });
  });
  it.each([0, 1, 3, 4, 5])("requires each settlement event at index %i", (index) => {
    expect(() =>
      reconcilePayment(quote, operation.userOpHash, operation, {
        ...receipt,
        logs: receipt.logs.filter((_, i) => i !== index),
      }),
    ).toThrow();
  });
  it("excludes payout logs belonging to a preceding operation", () => {
    const logs = [...receipt.logs];
    const payout = logs.splice(1, 1)[0]!;
    logs.unshift(payout);
    expect(() =>
      reconcilePayment(quote, operation.userOpHash, operation, { ...receipt, logs }),
    ).toThrow();
  });
});
