import {
  acrossTestRoute,
  checkAcrossApproval,
  checkAcrossAtomicOrigin,
  checkAcrossDeposit,
  EvmAddress,
} from "@swapchan/shared";
import { encodeFunctionData, erc20Abi, type Hex } from "viem";
import { z } from "zod";

const units = z.string().regex(/^\d+$/);
const reviewedRoute = z.object({
  quoteId: z.uuid(),
  chainId: z.literal(11155420),
  sourceChainId: z.number().int(),
  provider: z.enum(["direct_transfer", "across"]),
  sender: EvmAddress,
  recipient: EvmAddress,
  execution: z.enum(["unsigned_origin_steps", "unsigned_atomic_origin"]),
  amountMicroUsdc: units,
  maxInputMicroUsdc: units,
  expiresAt: z.number(),
  fillDeadline: z.number().optional(),
  sourceWallet: z.object({ requiredApprovalMicroUsdc: units }),
  originGas: z.object({ estimate: z.object({ totalWei: units }) }),
  atomicOrigin: z.object({ estimatedFeeWei: units }).nullish(),
});

export function checkPaymentRoute(
  raw: unknown,
  build: {
    quoteId: string;
    action: "transfer" | "approve" | "deposit" | "atomic_origin";
    expiresAt: number;
    estimatedOriginFeeWei: string;
    unsignedTransaction: { chainId: number; from: string; to: string; value: string; data: string };
  },
) {
  const q = reviewedRoute.parse(raw);
  const tx = { ...build.unsignedTransaction, data: build.unsignedTransaction.data as Hex };
  const feeCap =
    build.action === "atomic_origin"
      ? q.atomicOrigin?.estimatedFeeWei
      : q.originGas.estimate.totalWei;
  if (
    q.quoteId !== build.quoteId ||
    build.expiresAt > q.expiresAt ||
    build.expiresAt <= Date.now() / 1000 ||
    q.sourceChainId !== tx.chainId ||
    tx.from.toLowerCase() !== q.sender.toLowerCase() ||
    !feeCap ||
    BigInt(build.estimatedOriginFeeWei) > BigInt(feeCap) ||
    (q.execution === "unsigned_atomic_origin" && build.action !== "atomic_origin")
  )
    throw Error("Payment build exceeds or differs from the saved quote.");
  if (build.action === "transfer") {
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [q.recipient, BigInt(q.amountMicroUsdc)],
    });
    if (
      q.provider !== "direct_transfer" ||
      tx.chainId !== q.chainId ||
      tx.to.toLowerCase() !== acrossTestRoute.destinationToken.toLowerCase() ||
      tx.data.toLowerCase() !== data.toLowerCase()
    )
      throw Error("USDC transfer differs from the saved payment.");
    return;
  }
  if (q.provider !== "across" || q.sourceChainId !== acrossTestRoute.origin || !q.fillDeadline)
    throw Error("Unexpected bridge route.");
  const cap = q.sourceWallet.requiredApprovalMicroUsdc;
  if (build.action === "approve") checkAcrossApproval(tx, cap, q.chainId);
  else if (build.action === "atomic_origin") checkAcrossAtomicOrigin(tx, q, cap);
  else checkAcrossDeposit(tx, q);
}
