import { describe, expect, it, vi } from "vitest";
import fixture from "./guard/fixtures/relay-sol-op-payment.json" with { type: "json" };
import { checkSolanaRelayOrder } from "./payment-solana-order.js";

describe("Solana exact-output order", () => {
  const { orderData } = fixture.protocol.v2;
  const check = (q: typeof fixture) =>
    checkSolanaRelayOrder(
      q,
      "BUqwuxGmshL5aT9eW79D4c8kVdwCjcZLXjiotAntwFJE",
      "0xa11F5DA00D9a0E9b809E94c4cAe1efa36E8ff50b",
      "11111111111111111111111111111111",
      orderData.inputs[0]!.payment.amount,
      "1000000",
    );
  it("binds the pinned deposit instruction to the reviewed order and payout", () => {
    vi.spyOn(Date, "now").mockReturnValue((orderData.output.deadline - 10) * 1000);
    try {
      expect(check(fixture).orderId).toBe(fixture.protocol.v2.orderId);
      const changed = structuredClone(fixture);
      changed.steps[0]!.items[0]!.data.instructions[0]!.data += "00";
      expect(() => check(changed)).toThrow();
      const redirected = structuredClone(fixture);
      redirected.protocol.v2.orderData.output.payments[0]!.recipient =
        "0x0000000000000000000000000000000000000001";
      expect(() => check(redirected)).toThrow();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
