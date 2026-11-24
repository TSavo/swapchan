import { EvmAddress } from "@swapchan/shared";
import { decodeEventLog, erc20Abi, type Hex, pad, parseAbi, toEventSelector, zeroHash } from "viem";
import { z } from "zod";
import { crossPaymentInput, acrossBaseRoute as route } from "./payment-cross-chain.js";

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
  status: z.literal("0x1"),
  logs: z.array(z.object({ address: EvmAddress, data, topics: z.array(hash) })),
});
export const settlementInput = crossPaymentInput.safeExtend({
  originHash: hash,
  fillHash: hash,
  maxInputMicroUsdc: z.string().regex(/^[1-9][0-9]{0,37}$/),
});
const abi = parseAbi([
  "event FundsDeposited(bytes32 inputToken,bytes32 outputToken,uint256 inputAmount,uint256 outputAmount,uint256 indexed destinationChainId,uint256 indexed depositId,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,bytes32 indexed depositor,bytes32 recipient,bytes32 exclusiveRelayer,bytes message)",
  "event FilledRelay(bytes32 inputToken,bytes32 outputToken,uint256 inputAmount,uint256 outputAmount,uint256 repaymentChainId,uint256 indexed originChainId,uint256 indexed depositId,uint32 fillDeadline,uint32 exclusivityDeadline,bytes32 exclusiveRelayer,bytes32 indexed relayer,bytes32 depositor,bytes32 recipient,bytes32 messageHash,(bytes32 updatedRecipient,bytes32 updatedMessageHash,uint256 updatedOutputAmount,uint8 fillType) relayExecutionInfo)",
]);
type Rpc = (chain: 8453 | 10, method: string, params: unknown[]) => Promise<unknown>;
export async function crossSettlement(rpc: Rpc, intent: z.infer<typeof settlementInput>) {
  async function canonical(chain: 8453 | 10, tx: Hex) {
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
      final:
        BigInt(height.parse(z.object({ number: height }).parse(finalized).number)) >=
        BigInt(r.blockNumber),
    };
  }
  const [origin, dest] = await Promise.all([
    canonical(8453, intent.originHash),
    canonical(10, intent.fillHash),
  ]);
  if (!origin || !dest) return { status: "awaiting_receipts" };
  const logs = (r: z.infer<typeof receipt>, addr: string) =>
    r.logs
      .filter((l) => l.address.toLowerCase() === addr.toLowerCase())
      .map((l) => ({ ...l, topics: l.topics as [Hex, ...Hex[]] }));
  const deposits = logs(origin.r, route.pool)
    .filter((l) => l.topics[0] === toEventSelector(abi[0]))
    .map((l) => decodeEventLog({ abi: [abi[0]], ...l }));
  const fills = logs(dest.r, route.destinationPool)
    .filter((l) => l.topics[0] === toEventSelector(abi[1]))
    .map((l) => decodeEventLog({ abi: [abi[1]], ...l }));
  if (deposits.length !== 1 || fills.length !== 1) throw Error("Ambiguous or missing relay events");
  const d = deposits[0]!.args,
    f = fills[0]!.args;
  if (
    d.depositor !== pad(intent.sender).toLowerCase() ||
    d.recipient !== pad(intent.recipient).toLowerCase() ||
    d.inputToken !== pad(route.sourceToken).toLowerCase() ||
    d.outputToken !== pad(route.destinationToken).toLowerCase() ||
    d.inputAmount <= 0n ||
    d.inputAmount > BigInt(intent.maxInputMicroUsdc) ||
    d.outputAmount !== BigInt(intent.amountMicroUsdc) ||
    d.destinationChainId !== 10n ||
    f.originChainId !== 8453n ||
    d.message !== "0x" ||
    f.messageHash !== zeroHash ||
    f.relayExecutionInfo.updatedRecipient !== d.recipient ||
    f.relayExecutionInfo.updatedOutputAmount !== d.outputAmount ||
    f.relayExecutionInfo.updatedMessageHash !== zeroHash ||
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
    ).some((k) => f[k] !== d[k])
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
  if (
    delta(origin.r, route.sourceToken, intent.sender) !== -d.inputAmount ||
    delta(origin.r, route.sourceToken, route.pool) !== d.inputAmount ||
    delta(dest.r, route.destinationToken, intent.recipient) !== d.outputAmount
  )
    throw Error("Token movements differ from relay");
  return {
    status: origin.final && dest.final ? "settled" : "awaiting_finality",
    originHash: intent.originHash,
    fillHash: intent.fillHash,
    depositId: String(d.depositId),
    spentMicroUsdc: String(d.inputAmount),
    paidMicroUsdc: String(d.outputAmount),
    originFinalized: origin.final,
    destinationFinalized: dest.final,
  };
}
