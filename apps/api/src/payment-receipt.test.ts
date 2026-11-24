import { type PaymentQuote } from "@swapchan/shared";
import { describe, expect, it } from "vitest";
import fixture from "./payment-receipt.fixture.json";
import { chainReceipt, operationReceipt, reconcilePayment } from "./payment-receipt.js";

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
