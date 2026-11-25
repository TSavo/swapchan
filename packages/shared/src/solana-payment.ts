import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";

export const devnetUsdc = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const key = z.string().refine((s) => {
  try {
    return new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
});
export const solanaDevnetIntent = z
  .object({
    chainId: z.literal("solana:devnet"),
    sender: key,
    recipient: key,
    amountMicroUsdc: z
      .string()
      .regex(/^[1-9]\d{0,19}$/)
      .refine((s) => BigInt(s) <= 0xffffffffffffffffn),
  })
  .strict()
  .refine(
    (i) => i.sender !== i.recipient && PublicKey.isOnCurve(new PublicKey(i.sender).toBytes()),
  );
export type DevnetIntent = z.infer<typeof solanaDevnetIntent>;
export function devnetTransfer(
  intent: DevnetIntent,
  blockhash: string,
  createDestination: boolean,
) {
  const sender = new PublicKey(intent.sender),
    recipient = new PublicKey(intent.recipient);
  const source = getAssociatedTokenAddressSync(devnetUsdc, sender);
  const destination = getAssociatedTokenAddressSync(devnetUsdc, recipient, true);
  const instructions = [
    ...(createDestination
      ? [
          createAssociatedTokenAccountIdempotentInstruction(
            sender,
            destination,
            recipient,
            devnetUsdc,
          ),
        ]
      : []),
    createTransferCheckedInstruction(
      source,
      devnetUsdc,
      destination,
      sender,
      BigInt(intent.amountMicroUsdc),
      6,
    ),
  ];
  const message = new TransactionMessage({
    payerKey: sender,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  return { transaction: new VersionedTransaction(message), destination, source };
}
