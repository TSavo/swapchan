import { acrossDepositAbi, acrossRoute, EvmAddress } from "@swapchan/shared";
import {
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  pad,
  parseAbi,
  toEventSelector,
  zeroHash,
} from "viem";
import { z } from "zod";
import { crossPaymentInput } from "./payment-cross-chain.js";
import { receiptFees } from "./payment-origin-fees.js";

const hash = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/i)
  .transform((v) => v.toLowerCase() as Hex);
const data = z
  .string()
  .regex(/^0x(?:[0-9a-f]{2})*$/i)
  .transform((v) => v.toLowerCase() as Hex);
const height = z.string().regex(/^0x[0-9a-f]+$/i);
const receipt = z.object({
  transactionHash: hash,
  blockHash: hash,
  blockNumber: height,
  transactionIndex: height.optional(),
  from: EvmAddress.optional(),
  to: EvmAddress.nullish(),
  status: z.literal("0x1"),
  gasUsed: height.optional(),
  effectiveGasPrice: height.optional(),
  l1Fee: height.optional(),
  logs: z.array(z.object({ address: EvmAddress, data, topics: z.array(hash) })),
});
export const settlementInput = crossPaymentInput.safeExtend({
  originHash: hash,
  reviewedDepositData: data.optional(),
  approvalHash: hash.optional(),
  fillHash: hash.optional(),
  maxInputMicroUsdc: z.string().regex(/^[1-9][0-9]{0,37}$/),
});
const abi = parseAbi([
  "event FundsDeposited(bytes32 inputToken,bytes32 outputToken,uint256 inputAmount,uint256 outputAmount,uint256 indexed destinationChainId,uint256 indexed depositId,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,bytes32 indexed depositor,bytes32 recipient,bytes32 exclusiveRelayer,bytes message)",
  "event FilledRelay(bytes32 inputToken,bytes32 outputToken,uint256 inputAmount,uint256 outputAmount,uint256 repaymentChainId,uint256 indexed originChainId,uint256 indexed depositId,uint32 fillDeadline,uint32 exclusivityDeadline,bytes32 exclusiveRelayer,bytes32 indexed relayer,bytes32 depositor,bytes32 recipient,bytes32 messageHash,(bytes32 updatedRecipient,bytes32 updatedMessageHash,uint256 updatedOutputAmount,uint8 fillType) relayExecutionInfo)",
]);
type Rpc = (
  chain: 8453 | 10 | 84532 | 11155420,
  method: string,
  params: unknown[],
) => Promise<unknown>;
export async function crossSettlement(
  rpc: Rpc,
  intent: z.infer<typeof settlementInput>,
  f: typeof fetch = fetch,
) {
  const route = acrossRoute(intent.chainId);
  async function canonical(chain: 8453 | 10 | 84532 | 11155420, tx: Hex) {
    const raw = await rpc(chain, "eth_getTransactionReceipt", [tx]);
    if (raw === null) return null;
    const r = receipt.parse(raw);
    const [block, finalized] = await Promise.all([
      rpc(chain, "eth_getBlockByNumber", [r.blockNumber, false]),
      rpc(chain, "eth_getBlockByNumber", ["finalized", false]),
    ]);
    if (r.transactionHash !== tx || z.object({ hash }).parse(block).hash !== r.blockHash)
      throw Error("Noncanonical receipt");
    return {
      r,
      timestamp: z.object({ timestamp: height.optional() }).parse(block).timestamp,
      final:
        BigInt(height.parse(z.object({ number: height }).parse(finalized).number)) >=
        BigInt(r.blockNumber),
    };
  }
  const origin = await canonical(route.origin, intent.originHash);
  if (!origin) return { status: "awaiting_origin_receipt", originHash: intent.originHash };
  const logs = (r: z.infer<typeof receipt>, addr: string) =>
    r.logs
      .filter((l) => l.address.toLowerCase() === addr.toLowerCase())
      .map((l) => ({ ...l, topics: l.topics as [Hex, ...Hex[]] }));
  const deposits = logs(origin.r, route.pool)
    .filter((l) => l.topics[0] === toEventSelector(abi[0]))
    .map((l) => decodeEventLog({ abi: [abi[0]], ...l }));
  if (deposits.length !== 1) throw Error("Ambiguous or missing origin deposit");
  const d = deposits[0]!.args;
  if (intent.reviewedDepositData) {
    const encodeDeposit = (exclusivity: number) =>
      encodeFunctionData({
        abi: acrossDepositAbi,
        functionName: "deposit",
        args: [
          d.depositor,
          d.recipient,
          d.inputToken,
          d.outputToken,
          d.inputAmount,
          d.outputAmount,
          d.destinationChainId,
          d.exclusiveRelayer,
          d.quoteTimestamp,
          d.fillDeadline,
          exclusivity,
          d.message,
        ],
      }).toLowerCase();
    const candidates: string[] = [];
    if (d.exclusivityDeadline === 0 || d.exclusivityDeadline > 31_536_000)
      candidates.push(encodeDeposit(d.exclusivityDeadline));
    if (origin.timestamp) {
      const offset = BigInt(d.exclusivityDeadline) - BigInt(origin.timestamp);
      if (offset > 0n && offset <= 31_536_000n) candidates.push(encodeDeposit(Number(offset)));
    }
    const reviewed = intent.reviewedDepositData;
    if (
      !candidates.some(
        (encoded) => reviewed === encoded || reviewed === encoded + "1dc0de000073c0de",
      )
    )
      throw Error("Origin receipt differs from the reviewed deposit");
  }
  if (
    d.depositor !== pad(intent.sender).toLowerCase() ||
    d.recipient !== pad(intent.recipient).toLowerCase() ||
    d.inputToken !== pad(route.sourceToken).toLowerCase() ||
    d.outputToken !== pad(route.destinationToken).toLowerCase() ||
    d.inputAmount <= 0n ||
    d.inputAmount > BigInt(intent.maxInputMicroUsdc) ||
    d.outputAmount !== BigInt(intent.amountMicroUsdc) ||
    d.destinationChainId !== BigInt(route.destination) ||
    d.message !== "0x" ||
    delta(origin.r, route.sourceToken, intent.sender) !== -d.inputAmount ||
    delta(origin.r, route.sourceToken, route.pool) !== d.inputAmount
  )
    throw Error("Origin deposit differs from payment intent");
  const fees = receiptFees(origin.r);
  const depositReceipt = origin.r;
  // An optional approval reference can be stale after a requote. Attribute its fees
  // only when the mined approval matches this deposit, independently of fill status.
  async function readApproval(tx: Hex) {
    if (tx === intent.originHash) return null;
    const approval = await canonical(route.origin, tx);
    if (
      !approval ||
      approval.r.from?.toLowerCase() !== intent.sender.toLowerCase() ||
      approval.r.to?.toLowerCase() !== route.sourceToken.toLowerCase()
    )
      return null;
    const earlier =
      BigInt(approval.r.blockNumber) < BigInt(depositReceipt.blockNumber) ||
      (approval.r.blockHash === depositReceipt.blockHash &&
        approval.r.transactionIndex !== undefined &&
        depositReceipt.transactionIndex !== undefined &&
        BigInt(approval.r.transactionIndex) < BigInt(depositReceipt.transactionIndex));
    if (!earlier) return null;
    const events = logs(approval.r, route.sourceToken)
      .filter((l) => l.topics[0] === toEventSelector("Approval(address,address,uint256)"))
      .map((l) => decodeEventLog({ abi: erc20Abi, eventName: "Approval", ...l }).args);
    const event = events[0];
    if (
      events.length !== 1 ||
      !event ||
      event.owner.toLowerCase() !== intent.sender.toLowerCase() ||
      event.spender.toLowerCase() !== route.pool.toLowerCase() ||
      event.value !== d.inputAmount
    )
      return null;
    return {
      transactionHash: tx,
      approvedMicroUsdc: String(event.value),
      finalized: approval.final,
      fees: receiptFees(approval.r),
    };
  }
  const approval = intent.approvalHash
    ? await readApproval(intent.approvalHash).catch(() => null)
    : undefined;
  const progress = {
    ...(intent.approvalHash ? { approval } : {}),
    originHash: intent.originHash,
    depositId: String(d.depositId),
    fillDeadline: d.fillDeadline,
    originFinalized: origin.final,
    spentMicroUsdc: String(d.inputAmount),
    depositExecutionFeeWei: fees.executionWei,
    depositL1DataFeeWei: fees.l1DataWei,
  };
  let fillHash = intent.fillHash;
  if (!fillHash) {
    async function pending(status: string, providerStatus?: string) {
      if (Date.now() > d.fillDeadline * 1000) {
        const block = await rpc(route.destination, "eth_getBlockByNumber", [
          "finalized",
          false,
        ]).catch(() => null);
        const finalized = z.object({ timestamp: height }).safeParse(block);
        if (finalized.success && BigInt(finalized.data.timestamp) > BigInt(d.fillDeadline))
          return { ...progress, status: "fill_deadline_passed", providerStatus };
      }
      return { ...progress, status, providerStatus };
    }
    const params = new URLSearchParams({
      originChainId: String(route.origin),
      depositTxnRef: intent.originHash,
    });
    const reply = await f(route.api + "/deposit/status?" + params, {
      signal: AbortSignal.timeout(10000),
    });
    if (reply.status === 404) return pending("awaiting_fill_index");
    if (!reply.ok) throw Error("Across status lookup unavailable");
    const hint = z
      .object({
        status: z.string(),
        originChainId: z.literal(route.origin),
        destinationChainId: z.literal(route.destination),
        depositId: z.union([z.string(), z.number().int().safe()]),
        depositTxnRef: hash,
        fillTxnRef: hash.nullish(),
        depositRefundTxnRef: hash.nullish(),
      })
      .parse(await reply.json());
    if (hint.depositTxnRef !== intent.originHash || String(hint.depositId) !== progress.depositId)
      throw Error("Across index returned a different deposit");
    if (hint.status === "expired") return pending("expiry_reported", hint.status);
    if (hint.status === "refunded") {
      const reported = { ...progress, status: "recovery_reported", providerStatus: hint.status };
      const refundHash = hint.depositRefundTxnRef;
      if (!refundHash || refundHash === intent.originHash) return reported;
      const refund = await canonical(route.origin, refundHash);
      if (!refund || !refund.timestamp || BigInt(refund.timestamp) <= BigInt(d.fillDeadline))
        return { ...reported, refundHash };
      const transfers = logs(refund.r, route.sourceToken)
        .filter((l) => l.topics[0] === toEventSelector("Transfer(address,address,uint256)"))
        .map((l) => decodeEventLog({ abi: erc20Abi, eventName: "Transfer", ...l }).args)
        .filter(
          (t) =>
            t.from.toLowerCase() === route.pool.toLowerCase() &&
            t.to.toLowerCase() === intent.sender.toLowerCase() &&
            t.value === d.inputAmount,
        );
      if (
        transfers.length !== 1 ||
        delta(refund.r, route.sourceToken, intent.sender) !== d.inputAmount
      )
        return { ...reported, refundHash };
      const refundFinalized = origin.final && refund.final;
      return {
        ...reported,
        status: refundFinalized ? "refunded" : "awaiting_refund_finality",
        refundHash,
        returnedMicroUsdc: String(d.inputAmount),
        refundFinalized,
      };
    }
    if (hint.status !== "filled" || !hint.fillTxnRef)
      return pending("awaiting_verified_fill", hint.status);
    fillHash = hint.fillTxnRef;
  }
  const dest = await canonical(route.destination, fillHash);
  if (!dest) return { ...progress, status: "awaiting_destination_receipt", fillHash };
  const fills = logs(dest.r, route.destinationPool)
    .filter((l) => l.topics[0] === toEventSelector(abi[1]))
    .map((l) => decodeEventLog({ abi: [abi[1]], ...l }))
    .filter(
      ({ args }) => args.depositId === d.depositId && args.originChainId === BigInt(route.origin),
    );
  if (fills.length !== 1) throw Error("Ambiguous or missing destination fill");
  const fill = fills[0]!.args;
  if (
    fill.messageHash !== zeroHash ||
    fill.relayExecutionInfo.updatedRecipient !== d.recipient ||
    fill.relayExecutionInfo.updatedOutputAmount !== d.outputAmount ||
    fill.relayExecutionInfo.updatedMessageHash !== zeroHash ||
    (
      [
        "depositId",
        "depositor",
        "recipient",
        "inputToken",
        "outputToken",
        "inputAmount",
        "outputAmount",
        "fillDeadline",
        "exclusiveRelayer",
        "exclusivityDeadline",
      ] as const
    ).some((k) => fill[k] !== d[k])
  )
    throw Error("Relay differs from intent");
  function delta(r: z.infer<typeof receipt>, token: string, who: string) {
    return logs(r, token)
      .filter((l) => l.topics[0] === toEventSelector("Transfer(address,address,uint256)"))
      .map((l) => decodeEventLog({ abi: erc20Abi, eventName: "Transfer", ...l }))
      .reduce(
        (n, e) =>
          n +
          (e.args.to.toLowerCase() === who.toLowerCase() ? e.args.value : 0n) -
          (e.args.from.toLowerCase() === who.toLowerCase() ? e.args.value : 0n),
        0n,
      );
  }
  if (delta(dest.r, route.destinationToken, intent.recipient) !== d.outputAmount)
    throw Error("Token movements differ from relay");
  return {
    status: origin.final && dest.final ? "settled" : "awaiting_finality",
    ...progress,
    fillHash,
    paidMicroUsdc: String(d.outputAmount),
    destinationFinalized: dest.final,
  };
}
