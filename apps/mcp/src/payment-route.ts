import {
  acrossTestRoute,
  checkAcrossApproval,
  checkAcrossAtomicOrigin,
  checkAcrossDeposit,
  EvmAddress,
} from "@swapchan/shared";
import { encodeFunctionData, erc20Abi, type Hex, keccak256 } from "viem";
import { z } from "zod";

const units = z.string().regex(/^\d+$/);
const reviewedRoute = z.object({
  quoteId: z.uuid(),
  chainId: z.literal(11155420),
  sourceChainId: z.number().int(),
  provider: z.enum(["direct_transfer", "across", "circle_cctp"]),
  burnDataHash: z
    .string()
    .regex(/^0x[a-f0-9]{64}$/i)
    .optional(),
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
    action: "transfer" | "approve" | "deposit" | "atomic_origin" | "burn";
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
  const { chainId, sender, recipient, amountMicroUsdc } = q;
  const payment = { chainId, sender, recipient, amountMicroUsdc };
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
    return {
      tool: "payment_status",
      arguments: { direct: payment },
      addTransactionHashAt: "direct.transactionHash",
    };
  }
  if (q.sourceChainId !== acrossTestRoute.origin) throw Error("Unexpected bridge route.");
  const cap = q.sourceWallet.requiredApprovalMicroUsdc;
  if (q.provider === "circle_cctp") {
    const messenger = "0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A";
    if (
      build.action === "burn" &&
      tx.to.toLowerCase() === messenger.toLowerCase() &&
      keccak256(tx.data) === q.burnDataHash
    )
      return {
        after: "successful_burn_receipt",
        attestationUrl: "https://iris-api-sandbox.circle.com/v2/messages/6",
        transactionHashParameter: "transactionHash",
        destinationChainId: q.chainId,
        recipient: q.recipient,
        amountMicroUsdc: q.amountMicroUsdc,
      };
    const approvalData = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [messenger, BigInt(cap)],
    });
    if (
      build.action !== "approve" ||
      cap === "0" ||
      cap !== q.maxInputMicroUsdc ||
      tx.to.toLowerCase() !== acrossTestRoute.sourceToken.toLowerCase() ||
      tx.data.toLowerCase() !== approvalData.toLowerCase()
    )
      throw Error("Circle transaction differs from the saved payment.");
  } else if (q.provider !== "across" || !q.fillDeadline || build.action === "burn")
    throw Error("Unexpected bridge action.");
  if (build.action === "approve") {
    if (q.provider === "across") checkAcrossApproval(tx, cap, q.chainId);
    return {
      tool: "pay",
      after: "successful_approval_receipt",
      arguments: { chainId, quoteId: q.quoteId, stage: "after_approval" },
    };
  }
  let reviewedDepositData = tx.data;
  if (build.action === "atomic_origin") reviewedDepositData = checkAcrossAtomicOrigin(tx, q, cap);
  else checkAcrossDeposit(tx, q);
  return {
    tool: "payment_status",
    arguments: {
      crossChain: {
        ...payment,
        sourceChainId: q.sourceChainId,
        maxInputMicroUsdc: q.maxInputMicroUsdc,
        reviewedDepositData,
      },
    },
    addTransactionHashAt: "crossChain.originHash",
  };
}
