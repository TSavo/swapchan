import { createHash } from "node:crypto";
import { base58 } from "@scure/base";
import { VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";
import { relayPayout } from "./payment-relay-payout.js";
import { checkTokenChanges, tokenBalance } from "./payment-solana-simulation.js";
import { getJson } from "./providers/types.js";
export type ReviewedSolanaPayment = {
  requestId: string;
  orderId: string;
  messageSha256: string;
  sender: string;
  recipient: string;
  payoutMicroUsdc: string;
  sourceToken: string | null;
  tokenUnitsDebited: string;
  networkFeeLamports: string;
  totalLamportsDebited: string;
  expiresAt: number;
};
const hash = z.string().regex(/^0x[0-9a-f]{64}$/i);

const safe = z.number().int().safe().nonnegative();
export async function solanaPaymentStatus(
  f: typeof fetch,
  r: ReviewedSolanaPayment,
  rpc: (url: string, method: string, params: unknown[]) => Promise<unknown>,
) {
  const report = z
    .object({
      status: z.string(),
      originChainId: z.literal(792703809).optional(),
      destinationChainId: z.literal(10).optional(),
      inTxHashes: z.array(z.string()).optional(),
      txHashes: z.array(hash).optional(),
    })
    .parse(
      await getJson(
        f,
        "https://api.relay.link/intents/status/v3?requestId=" + encodeURIComponent(r.requestId),
        { signal: AbortSignal.timeout(10000) },
      ),
    );
  const base = { requestId: r.requestId, orderId: r.orderId, providerStatus: report.status };
  if (!report.inTxHashes?.length) return { ...base, status: "awaiting_origin_receipt" };
  if (report.inTxHashes.length !== 1) throw Error("Ambiguous origin transaction");
  const signature = report.inTxHashes[0]!;
  if (base58.decode(signature).length !== 64) throw Error("Invalid origin signature");
  const source = await rpc(
    process.env.SOLANA_RPC_URL ||
      process.env.RPC_URL_792703809 ||
      "https://api.mainnet-beta.solana.com",
    "getTransaction",
    [signature, { encoding: "base64", commitment: "finalized", maxSupportedTransactionVersion: 0 }],
  );
  if (!source) return { ...base, status: "awaiting_origin_finality", signature };
  const { transaction, slot, meta } = z
    .object({
      slot: safe,
      transaction: z.tuple([z.string(), z.literal("base64")]),
      meta: z.object({
        preTokenBalances: z.array(tokenBalance),
        postTokenBalances: z.array(tokenBalance),
        fee: safe,
        err: z.unknown(),
        preBalances: z.array(z.number()),
        postBalances: z.array(z.number()),
      }),
    })
    .parse(source);
  const tx = VersionedTransaction.deserialize(Buffer.from(transaction[0], "base64"));
  if (
    tx.signatures.length !== 1 ||
    base58.encode(tx.signatures[0]!) !== signature ||
    tx.message.staticAccountKeys[0]?.toBase58() !== r.sender ||
    createHash("sha256").update(tx.message.serialize()).digest("hex") !== r.messageSha256
  )
    throw Error("Mined message differs from reviewed deposit");
  const origin = { signature, slot, finalized: true, networkFeeLamports: String(meta.fee) };
  if (meta.err !== null) return { ...base, origin, status: "origin_failed" };
  if (
    String(meta.fee) !== r.networkFeeLamports ||
    BigInt(safe.parse(meta.preBalances[0])) - BigInt(safe.parse(meta.postBalances[0])) !==
      BigInt(r.totalLamportsDebited)
  )
    throw Error("Mined SOL debit differs from simulation");
  checkTokenChanges(meta, r.sender, r.sourceToken, BigInt(r.tokenUnitsDebited));
  const deposit = {
    ...origin,
    totalLamportsDebited: r.totalLamportsDebited,
    tokenMint: r.sourceToken,
    tokenUnitsDebited: r.tokenUnitsDebited,
  };
  if (report.status !== "success")
    return {
      ...base,
      origin: deposit,
      status:
        report.status === "refund"
          ? "refund_reported"
          : report.status === "failure"
            ? "provider_failed"
            : "awaiting_destination",
    };
  if (
    report.originChainId !== 792703809 ||
    report.destinationChainId !== 10 ||
    report.txHashes?.length !== 1
  )
    throw Error("Ambiguous destination");
  const destHash = report.txHashes[0]!;
  return { ...base, origin: deposit, ...(await relayPayout(rpc, r, destHash)) };
}
