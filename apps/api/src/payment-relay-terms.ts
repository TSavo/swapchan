import { getOrderId } from "@relay-protocol/settlement-sdk";
import { acrossRoute } from "@swapchan/shared";
import { z } from "zod";
export function checkRelayPaymentTerms(
  sourceChain: "solana" | "bitcoin",
  orderData: unknown,
  orderId: string,
  sender: string,
  recipient: string,
  sourceMint: string,
  input: string,
  payout: string,
) {
  const outputMint = acrossRoute(10).destinationToken.toLowerCase();
  const address = z.string().transform((s) => s.toLowerCase());
  const terms = z
    .object({
      solverChainId: z.enum(["base", "optimism"]),
      inputs: z.tuple([
        z.object({
          payment: z.object({
            chainId: z.literal(sourceChain),
            currency: z.literal(sourceMint),
            amount: z.literal(input),
          }),
          refunds: z
            .array(z.object({ chainId: z.string(), currency: z.string(), recipient: z.string() }))
            .min(1),
        }),
      ]),
      output: z.object({
        chainId: z.literal("optimism"),
        calls: z.tuple([]),
        payments: z.tuple([
          z.object({
            currency: address,
            recipient: address,
            minimumAmount: z.literal(payout),
            expectedAmount: z.literal(payout),
          }),
        ]),
        deadline: z
          .number()
          .int()
          .gt(Date.now() / 1000),
      }),
    })
    .parse(orderData);
  const pay = terms.output.payments[0];
  if (
    pay.currency !== outputMint ||
    pay.recipient !== recipient.toLowerCase() ||
    terms.inputs[0].refunds.some(
      (r) =>
        !(
          (r.chainId === sourceChain && r.recipient === sender && r.currency === sourceMint) ||
          (r.chainId === "optimism" &&
            r.recipient.toLowerCase() === pay.recipient &&
            r.currency.toLowerCase() === outputMint)
        ),
    )
  )
    throw Error("Unexpected payout or refund terms");
  const computed = getOrderId(orderData as Parameters<typeof getOrderId>[0], {
    solana: "solana-vm",
    bitcoin: "bitcoin-vm",
    optimism: "ethereum-vm",
    base: "ethereum-vm",
  });
  if (computed !== orderId) throw Error("Relay order ID differs from signed terms");
  return {
    orderId,
    deadline: terms.output.deadline,
    recipient: pay.recipient,
    payoutMicroUsdc: payout,
  };
}
