import { getOrderId } from "@relay-protocol/settlement-sdk";
import { acrossRoute, SOLANA } from "@swapchan/shared";
import { z } from "zod";
import { RELAY_DEPOSITORY_PINS } from "./guard/relayPins.js";

export function checkSolanaRelayOrder(
  quote: unknown,
  sender: string,
  recipient: string,
  sourceMint: string,
  input: string,
  payout: string,
) {
  const id = z.string().regex(/^0x[0-9a-f]{64}$/);
  const result = z
    .object({
      protocol: z.object({ v2: z.object({ orderId: id, orderData: z.unknown() }) }),
      steps: z.tuple([
        z.object({
          items: z.tuple([
            z.object({
              data: z.object({
                instructions: z.tuple([
                  z.object({
                    programId: z.string(),
                    data: z.string().regex(/^[0-9a-f]+$/i),
                    keys: z.array(z.object({ pubkey: z.string(), isSigner: z.boolean() })),
                  }),
                ]),
              }),
            }),
          ]),
        }),
      ]),
    })
    .parse(quote);
  const { orderData, orderId } = result.protocol.v2;
  const outputMint = acrossRoute(10).destinationToken.toLowerCase();
  const address = z.string().transform((s) => s.toLowerCase());
  const terms = z
    .object({
      solverChainId: z.enum(["base", "optimism"]),
      inputs: z.tuple([
        z.object({
          payment: z.object({
            chainId: z.literal("solana"),
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
          (r.chainId === "solana" && r.recipient === sender && r.currency === sourceMint) ||
          (r.chainId === "optimism" &&
            r.recipient.toLowerCase() === pay.recipient &&
            r.currency.toLowerCase() === outputMint)
        ),
    )
  )
    throw Error("Unexpected payout or refund terms");
  const computed = getOrderId(orderData as Parameters<typeof getOrderId>[0], {
    solana: "solana-vm",
    optimism: "ethereum-vm",
    base: "ethereum-vm",
  });
  const ix = result.steps[0].items[0].data.instructions[0],
    data = Buffer.from(ix.data, "hex");
  const native = sourceMint === "11111111111111111111111111111111";
  if (
    computed !== orderId ||
    ix.programId !== RELAY_DEPOSITORY_PINS[SOLANA] ||
    data.length !== 48 ||
    data.subarray(0, 8).toString("hex") !== (native ? "0d9e0ddf5fd51c06" : "0b9c60da27a3b413") ||
    data.readBigUInt64LE(8) !== BigInt(input) ||
    "0x" + data.subarray(16).toString("hex") !== orderId ||
    ix.keys.length !== (native ? 5 : 10) ||
    ix.keys[1]?.pubkey !== sender ||
    !ix.keys[1]?.isSigner ||
    ix.keys[2]?.pubkey !== sender ||
    ix.keys.at(-1)?.pubkey !== "11111111111111111111111111111111" ||
    (!native &&
      (ix.keys[4]?.pubkey !== sourceMint ||
        ix.keys[7]?.pubkey !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" ||
        ix.keys[8]?.pubkey !== "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")) ||
    ix.keys.filter((k) => k.isSigner).length !== 1
  )
    throw Error("Deposit differs from Relay order");
  return {
    orderId,
    deadline: terms.output.deadline,
    recipient: pay.recipient,
    payoutMicroUsdc: payout,
  };
}
