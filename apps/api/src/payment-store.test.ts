import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaymentQuote } from "@swapchan/shared";
import { expect, it } from "vitest";
import { paymentRoutes } from "./payment.js";
import { openPaymentStore } from "./payment-store.js";

it("recovers a signed relay intent and acknowledged submission across API restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swapchan-payment-"));
  const file = join(dir, "payments.db"),
    hash = "0x" + "ab".repeat(32);
  const quote: PaymentQuote = {
    chainId: 84532,
    sender: "0x18eE1D19Ab2030e5dd6f52c6be152ffeA0d08c0D",
    recipient: "0xa11F5DA00D9a0E9b809E94c4cAe1efa36E8ff50b",
    amountMicroUsdc: "1",
    maxGasMicroUsdc: "10538",
    maxWethWei: "0",
    swapOutputMicroUsdc: "0",
    expiresAt: 1,
    requiresDelegation: false,
    maxFeePerGas: "0x1",
    maxPriorityFeePerGas: "0x1",
  };
  let store = openPaymentStore(file);
  const rpc = async () => Response.json({ jsonrpc: "2.0", id: 1, result: null });
  try {
    store.remember(hash, quote);
    store.close();
    store = openPaymentStore(file);
    const status = () =>
      paymentRoutes(rpc, store)
        .request("/status/" + hash)
        .then((r) => r.json());
    expect(await status()).toEqual({ status: "submission_unconfirmed", userOpHash: hash });
    store.markRelayed(hash);
    store.close();
    store = openPaymentStore(file);
    expect(await status()).toEqual({ status: "pending", userOpHash: hash });
    store.remember(hash, { ...quote, amountMicroUsdc: "2" });
    expect(store.get(hash)?.quote).toEqual(quote);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
