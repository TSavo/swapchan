import {
  acrossTestRoute,
  batchAbi,
  checkAcrossApproval,
  checkAcrossAtomicOrigin,
  checkAcrossDeposit,
  checkCircleBatch,
  checkCircleBurn,
  circleMessenger,
  EvmAddress,
  paymentContracts,
  paymentDelegationNotice,
} from "@swapchan/shared";
import { decodeFunctionData, encodeFunctionData, erc20Abi, formatUnits, type Hex } from "viem";
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
    const messenger = circleMessenger;
    if (build.action === "burn" || build.action === "atomic_origin") {
      const atomic = build.action === "atomic_origin";
      if (
        tx.to.toLowerCase() !== (atomic ? q.sender : messenger).toLowerCase() ||
        (atomic && cap !== q.maxInputMicroUsdc)
      )
        throw Error("Unexpected Circle execution target or approval.");
      const intent = { ...q, burnDataHash: q.burnDataHash };
      if (atomic) checkCircleBatch(tx.data, intent);
      else checkCircleBurn(tx.data, intent);
      return {
        after: "successful_burn_receipt",
        tool: "payment_status",
        arguments: {
          circle: {
            sender,
            recipient,
            amountMicroUsdc,
            maxInputMicroUsdc: q.maxInputMicroUsdc,
            burnDataHash: q.burnDataHash,
          },
        },
        addTransactionHashAt: "circle.originHash",
      };
    }
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

export const atomicWalletRequest = z
  .object({
    method: z.literal("wallet_sendCalls"),
    params: z.tuple([
      z
        .object({
          version: z.literal("2.0.0"),
          from: EvmAddress,
          chainId: z.literal("0x14a34"),
          atomicRequired: z.literal(true),
          calls: z
            .array(
              z
                .object({
                  to: EvmAddress,
                  value: z.literal("0x0"),
                  data: z.string().regex(/^0x(?:[a-f0-9]{2})+$/i),
                })
                .strict(),
            )
            .length(2),
        })
        .strict(),
    ]),
  })
  .strict();

/** Accept only a freshly simulated atomic origin using the reviewed delegate and exact bridge calls. */
export function atomicWalletPayment(
  quoteId: string,
  review: Record<string, unknown>,
  raw: unknown,
) {
  const build = z
    .object({
      quoteId: z.literal(quoteId),
      action: z.literal("atomic_origin"),
      expiresAt: z.number().int(),
      originSimulation: z.object({ status: z.literal("succeeded") }),
      estimatedOriginFeeWei: units,
      unsignedTransaction: z.object({
        chainId: z.literal(84532),
        from: EvmAddress,
        to: EvmAddress,
        value: z.literal("0x0"),
        data: z.string().regex(/^0x(?:[a-f0-9]{2})+$/i),
      }),
    })
    .parse(raw);
  const delegate = z.object({ delegate: EvmAddress }).parse(review.atomicOrigin).delegate;
  if (delegate.toLowerCase() !== paymentContracts.delegate.toLowerCase())
    throw Error("Unexpected atomic payment delegate.");
  const next = checkPaymentRoute(review, build);
  const tx = build.unsignedTransaction;
  const batch = decodeFunctionData({ abi: batchAbi, data: tx.data as Hex });
  const walletRequest = atomicWalletRequest.parse({
    method: "wallet_sendCalls",
    params: [
      {
        version: "2.0.0",
        from: tx.from,
        chainId: "0x14a34",
        atomicRequired: true,
        calls: batch.args[0].map((c) => ({
          to: c.target,
          value: "0x" + c.value.toString(16),
          data: c.data,
        })),
      },
    ],
  });
  const approval = decodeFunctionData({ abi: erc20Abi, data: batch.args[0][0]!.data });
  if (approval.functionName !== "approve")
    throw Error("Atomic origin must start with the reviewed approval.");
  return {
    ...build,
    walletRequest,
    verification: {
      status: "verified",
      explanation: [
        `Approve ${approval.args[0]} for exactly ${formatUnits(approval.args[1], 6)} USDC and execute the bridge call in one Base Sepolia transaction.`,
        `The wallet pays source gas in ETH. Expected origin cost is ${build.estimatedOriginFeeWei} wei. Verify the separate Optimism Sepolia payout of ${formatUnits(BigInt(String(review.amountMicroUsdc)), 6)} USDC to ${review.recipient} using payment_status.`,
      ],
      delegate,
      delegation: paymentDelegationNotice,
      recipient: review.recipient,
      amountMicroUsdc: review.amountMicroUsdc,
      maxInputMicroUsdc: review.maxInputMicroUsdc,
      feePayer: tx.from,
      gasToken: "ETH",
      approval: {
        token: paymentContracts.usdc,
        spender: approval.args[0],
        amountMicroUsdc: String(approval.args[1]),
      },
      paymasterChargeMicroUsdc: "0",
      destinationSettlement: "asynchronous",
    },
    walletStatusRequest: { method: "wallet_getCallsStatus", addWalletResultIdAt: "params[0]" },
    next: {
      tool: next.tool,
      arguments: next.arguments,
      addWalletStatusResultAt:
        review.provider === "circle_cctp"
          ? "circle.walletCallsStatus"
          : "crossChain.walletCallsStatus",
      requireAtomic: true,
      requireStatus: 200,
    },
  };
}
