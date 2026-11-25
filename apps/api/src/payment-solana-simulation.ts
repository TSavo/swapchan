import { createHash } from "node:crypto";
import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";

const integer = z.number().int().nonnegative().safe();
const address = z.string().transform((v) => new PublicKey(v));
const instruction = z.object({
  programId: address,
  keys: z
    .array(z.object({ pubkey: address, isSigner: z.boolean(), isWritable: z.boolean() }))
    .max(256),
  data: z
    .string()
    .regex(/^(?:[a-f0-9]{2})*$/i)
    .transform((s) => Buffer.from(s, "hex")),
});
const step = z.object({
  id: z.literal("deposit"),
  kind: z.literal("transaction"),
  items: z.tuple([
    z.object({
      data: z.object({
        instructions: z.array(instruction).min(1).max(64),
        addressLookupTableAddresses: z.array(address).max(32).optional(),
      }),
    }),
  ]),
});
const tokenBalance = z.object({
  owner: z.string().optional(),
  mint: z.string(),
  uiTokenAmount: z.object({ amount: z.string().regex(/^\d+$/) }),
});

export async function simulateSolanaDeposit(
  f: typeof fetch,
  url: string,
  rpc: (method: string, params: unknown[]) => Promise<unknown>,
  quote: unknown,
  sender: string,
  token: string | null,
  amount: bigint,
) {
  const {
    steps: [
      {
        items: [{ data }],
      },
    ],
  } = z.object({ steps: z.tuple([step]) }).parse(quote);
  const connection = new Connection(url, {
    commitment: "confirmed",
    fetch: f,
    disableRetryOnRateLimit: true,
  });
  const [block, tables] = await Promise.all([
    connection.getLatestBlockhashAndContext(),
    Promise.all(
      (data.addressLookupTableAddresses ?? []).map(async (key) => {
        const table = await connection.getAddressLookupTable(key);
        if (!table.value) throw Error("Missing lookup table");
        return table.value;
      }),
    ),
  ]);
  const message = new TransactionMessage({
    payerKey: new PublicKey(sender),
    instructions: data.instructions,
    recentBlockhash: block.value.blockhash,
  }).compileToV0Message(tables);
  if (
    message.header.numRequiredSignatures !== 1 ||
    message.staticAccountKeys[0]?.toBase58() !== sender
  )
    throw Error("Unexpected Solana signers");
  const tx = new VersionedTransaction(message).serialize();
  if (tx.length > 1232) throw Error("Oversized Solana deposit");
  const simulation = z
    .object({
      result: z.object({
        context: z.object({ slot: integer }),
        value: z.object({
          err: z.null(),
          fee: integer.positive(),
          preBalances: z.array(z.number()).min(1),
          postBalances: z.array(z.number()).min(1),
          preTokenBalances: z.array(tokenBalance),
          postTokenBalances: z.array(tokenBalance),
        }),
      }),
    })
    .parse(
      await rpc("simulateTransaction", [
        Buffer.from(tx).toString("base64"),
        {
          encoding: "base64",
          sigVerify: false,
          replaceRecentBlockhash: false,
          commitment: "confirmed",
          minContextSlot: block.context.slot,
        },
      ]),
    ).result;
  const v = simulation.value;
  const nativeSpent =
    BigInt(integer.parse(v.preBalances[0])) - BigInt(integer.parse(v.postBalances[0]));
  const changes = new Map<string, bigint>();
  for (const [sign, balances] of [
    [1n, v.preTokenBalances],
    [-1n, v.postTokenBalances],
  ] as const)
    for (const b of balances) {
      if (!b.owner) throw Error("Missing token owner in simulation");
      if (b.owner === sender)
        changes.set(b.mint, (changes.get(b.mint) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount));
    }
  if (
    nativeSpent !== BigInt(v.fee) + (token ? 0n : amount) ||
    (token && changes.get(token) !== amount) ||
    Array.from(changes).some(([mint, delta]) => mint !== token && delta !== 0n)
  )
    throw Error("Source balance changes differ from quote");
  return {
    status: "simulated" as const,
    slot: simulation.context.slot,
    networkFeeLamports: String(v.fee),
    totalLamportsDebited: String(nativeSpent),
    tokenUnitsDebited: String(token ? amount : 0n),
    requiredSignatures: 1,
    messageSha256: createHash("sha256").update(message.serialize()).digest("hex"),
    lastValidBlockHeight: block.value.lastValidBlockHeight,
  };
}
