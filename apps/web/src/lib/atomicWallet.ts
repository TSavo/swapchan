import { type Address, type Hex, toHex } from "viem";
import { z } from "zod";

const chain = toHex(84532);
export function walletRejectedRequest(error: unknown) {
  const seen = new Set<object>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    if ("code" in error && error.code === 4001) return true;
    error = "cause" in error ? error.cause : undefined;
  }
  return false;
}
export function supportsAtomicOrigin(capabilities: unknown) {
  const record = z.record(z.string(), z.unknown()).safeParse(capabilities);
  if (!record.success) return false;
  return Object.entries(record.data).some(
    ([key, entry]) =>
      /^0x[0-9a-f]+$/i.test(key) &&
      BigInt(key) === 84532n &&
      z.object({ atomic: z.object({ status: z.literal("supported") }) }).safeParse(entry).success,
  );
}
export function atomicWalletRequest(
  sender: Address,
  id: Hex,
  calls: readonly { target: Address; value: bigint; data: Hex }[],
) {
  return {
    version: "2.0.0" as const,
    id,
    chainId: chain,
    from: sender,
    atomicRequired: true,
    calls: calls.map(({ target: to, value, data }) => ({ to, value: toHex(value), data })),
  };
}
export function walletBatchReceipt(raw: unknown, id: Hex) {
  const s = z
    .object({
      id: z.string(),
      chainId: z.string().regex(/^0x[0-9a-f]+$/i),
      version: z.literal("2.0.0"),
      status: z.number().int(),
      atomic: z.boolean().optional(),
      receipts: z
        .array(
          z.object({ transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/i), status: z.string() }),
        )
        .optional(),
    })
    .parse(raw);
  if (s.id !== id || BigInt(s.chainId) !== 84532n)
    throw Error("Wallet status belongs to another batch or network.");
  if (s.status >= 100 && s.status < 200) return null;
  if (s.status === 400)
    throw Error(
      "The wallet reports the batch failed before inclusion. Open the batch in your wallet to review it.",
    );
  if (s.status === 500)
    throw Error(
      "The wallet reports the whole batch reverted. Check the origin receipt for the gas charge.",
    );
  if (s.status === 600)
    throw Error(
      "The wallet reports partial execution. Review its receipts for any approval or deposit before another payment.",
    );
  if (
    s.status !== 200 ||
    s.atomic !== true ||
    !s.receipts?.length ||
    s.receipts.some((r) => r.status !== "0x1")
  )
    throw Error("The wallet has not confirmed atomic execution. Check the batch in your wallet.");
  const hashes = new Set(s.receipts.map((r) => r.transactionHash.toLowerCase()));
  if (hashes.size !== 1)
    throw Error("Multiple origin receipts require independent reconciliation.");
  return s.receipts[0]!.transactionHash as Hex;
}
