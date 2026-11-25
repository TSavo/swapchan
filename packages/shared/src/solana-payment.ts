import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
  type Address,
  concatHex,
  decodeFunctionData,
  encodeFunctionData,
  type Hex,
  parseAbi,
  toHex,
  zeroHash,
} from "viem";
import { z } from "zod";
import { EvmAddress } from "./index.js";
import { paymentContracts } from "./payment-batch.js";

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
    feePayer: key.optional(),
    recipient: key,
    amountMicroUsdc: z
      .string()
      .regex(/^[1-9]\d{0,19}$/)
      .refine((s) => BigInt(s) <= 0xffffffffffffffffn),
  })
  .strict()
  .refine(
    (i) =>
      i.sender !== i.recipient &&
      PublicKey.isOnCurve(new PublicKey(i.sender).toBytes()) &&
      (!i.feePayer ||
        (i.feePayer !== i.sender && PublicKey.isOnCurve(new PublicKey(i.feePayer).toBytes()))),
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
  const payer = intent.feePayer ? new PublicKey(intent.feePayer) : sender;
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
            payer,
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
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  return { transaction: new VersionedTransaction(message), destination, source };
}

export const circleDevnetIntent = z
  .object({
    chainId: z.literal("solana:devnet"),
    sourceChainId: z.literal(84532),
    sender: EvmAddress,
    recipient: key,
    amountMicroUsdc: z
      .string()
      .regex(/^[1-9]\d{0,19}$/)
      .refine((s) => BigInt(s) <= 0xffffffffffffffffn),
  })
  .strict();
export type CircleDevnetIntent = z.infer<typeof circleDevnetIntent>;
export function solanaForwardTarget(recipient: string) {
  const owner = new PublicKey(recipient);
  const ata = getAssociatedTokenAddressSync(devnetUsdc, owner, true);
  const hookData = concatHex([
    toHex("cctp-forward", { size: 24 }),
    toHex(0, { size: 4 }),
    toHex(33, { size: 4 }),
    "0x01",
    toHex(owner.toBytes()),
  ]);
  return { ata: ata.toBase58(), mintRecipient: toHex(ata.toBytes()), hookData };
}
const solanaBurnAbi = parseAbi([
  "function depositForBurnWithHookAndFees(uint256,uint32,bytes32,address,bytes32,bytes,(bytes signedQuote,address refundAddress) claim)",
]);
export function matchesSolanaForwardBurn(intent: CircleDevnetIntent, data: Hex) {
  const { args } = decodeFunctionData({ abi: solanaBurnAbi, data });
  const signed = args[6].signedQuote;
  return signed !== "0x" && solanaForwardBurn(intent, signed).toLowerCase() === data.toLowerCase();
}
export function solanaForwardBurn(intent: CircleDevnetIntent, signedQuote: Hex) {
  const { mintRecipient, hookData } = solanaForwardTarget(intent.recipient);
  return encodeFunctionData({
    abi: solanaBurnAbi,
    functionName: "depositForBurnWithHookAndFees",
    args: [
      BigInt(intent.amountMicroUsdc),
      5,
      mintRecipient,
      paymentContracts.usdc,
      zeroHash,
      hookData,
      { signedQuote, refundAddress: intent.sender as Address },
    ],
  });
}
