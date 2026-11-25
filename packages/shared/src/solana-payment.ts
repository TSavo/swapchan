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
export const devnetSources = z
  .array(z.object({ account: key, amountMicroUsdc: z.string().regex(/^[1-9]\d{0,19}$/) }).strict())
  .min(1)
  .max(32);
export type DevnetSources = z.infer<typeof devnetSources>;
export function devnetTransfer(
  intent: DevnetIntent,
  blockhash: string,
  createDestination: boolean,
  sources?: DevnetSources,
) {
  const sender = new PublicKey(intent.sender),
    recipient = new PublicKey(intent.recipient);
  const source = getAssociatedTokenAddressSync(devnetUsdc, sender);
  const destination = getAssociatedTokenAddressSync(devnetUsdc, recipient, true);
  const inputs = sources ?? [
    { account: source.toBase58(), amountMicroUsdc: intent.amountMicroUsdc },
  ];
  if (
    inputs.reduce((sum, input) => sum + BigInt(input.amountMicroUsdc), 0n) !==
      BigInt(intent.amountMicroUsdc) ||
    new Set(inputs.map((input) => input.account)).size !== inputs.length ||
    inputs.some(
      (input) => BigInt(input.amountMicroUsdc) <= 0n || input.account === destination.toBase58(),
    )
  )
    throw Error("Funding accounts differ from exact payment");
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
    ...inputs.map((input) =>
      createTransferCheckedInstruction(
        new PublicKey(input.account),
        devnetUsdc,
        destination,
        sender,
        BigInt(input.amountMicroUsdc),
        6,
      ),
    ),
  ];
  const message = new TransactionMessage({
    payerKey: sender,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  return { transaction: new VersionedTransaction(message), destination, source };
}
