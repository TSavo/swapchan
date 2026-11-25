import { paymentContracts as contracts, type PaymentQuote } from "@swapchan/shared";
import { toEventSelector } from "viem";
import { z } from "zod";

const hash = z.string().regex(/^0x[0-9a-f]{64}$/i);
const address = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/i)
  .transform((s) => s.toLowerCase());
const log = z.object({ address, topics: z.array(hash), data: z.string(), logIndex: z.string() });
export const operationReceipt = z.object({
  userOpHash: hash,
  entryPoint: address,
  paymaster: address,
  sender: address,
  success: z.boolean(),
  logs: z.array(log),
  receipt: z.object({
    transactionHash: hash,
    blockHash: hash,
    blockNumber: z.string().regex(/^0x[0-9a-f]+$/i),
  }),
});
export const chainReceipt = z.object({
  transactionHash: hash,
  blockHash: hash,
  blockNumber: z.string().regex(/^0x[0-9a-f]+$/i),
  status: z.string(),
  logs: z.array(log),
});
const transfer = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const beforeExecution = "0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972";
const userOperationEvent = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const paymasterCharge = "0x7a270f29ae17e8e2304ff1245deb50c3b6206bca82928d904f3e284d35c5ffd2";
export function reconcilePayment(
  q: PaymentQuote,
  expectedHash: string,
  r: z.infer<typeof operationReceipt>,
  canonical: z.infer<typeof chainReceipt>,
) {
  const sender = q.sender.toLowerCase(),
    recipient = q.recipient.toLowerCase();
  if (
    r.userOpHash !== expectedHash ||
    r.sender !== sender ||
    r.entryPoint !== contracts.entry.toLowerCase() ||
    r.paymaster !== contracts.paymaster.toLowerCase() ||
    canonical.transactionHash !== r.receipt.transactionHash ||
    canonical.blockHash !== r.receipt.blockHash ||
    canonical.blockNumber !== r.receipt.blockNumber
  )
    throw new Error("receipt mismatch");
  const base = {
    userOpHash: expectedHash,
    transactionHash: canonical.transactionHash,
    blockNumber: r.receipt.blockNumber,
  };
  const entryLogs = canonical.logs;
  const end = entryLogs.findIndex(
    (l) =>
      l.address === r.entryPoint &&
      l.topics[0] === userOperationEvent &&
      l.topics[1] === expectedHash,
  );
  const event = entryLogs[end];
  if (
    !event ||
    event.topics[2]?.slice(-40) !== sender.slice(2) ||
    event.topics[3]?.slice(-40) !== r.paymaster.slice(2) ||
    !/^0x[0-9a-f]{256}$/i.test(event.data)
  )
    throw new Error("canonical operation event missing");
  const succeeded = BigInt("0x" + event.data.slice(66, 130)) === 1n;
  if (succeeded !== r.success) throw new Error("operation outcome mismatch");
  if (!succeeded || canonical.status !== "0x1") return { ...base, status: "failed" };
  let start = end - 1;
  while (start >= 0) {
    const previous = entryLogs[start]!;
    if (
      previous.address === r.entryPoint &&
      [beforeExecution, userOperationEvent].includes(previous.topics[0]!)
    )
      break;
    start--;
  }
  if (start < 0) throw new Error("operation log boundary missing");
  let charged: bigint | undefined;
  let wrappedNative = 0n;
  let paid = 0n,
    fee = 0n,
    spent = 0n,
    received = 0n;
  for (const l of entryLogs.slice(start + 1, end)) {
    if (
      l.address === contracts.weth.toLowerCase() &&
      l.topics[0] === toEventSelector("Deposit(address,uint256)") &&
      l.topics[1]?.slice(-40) === sender.slice(2)
    )
      wrappedNative += BigInt(l.data);
    if (l.address === r.paymaster && l.topics[0] === paymasterCharge) {
      if (
        charged !== undefined ||
        l.topics[1] !== expectedHash ||
        l.topics[2]?.slice(-40) !== sender.slice(2) ||
        !/^0x[0-9a-f]{256}$/i.test(l.data) ||
        l.data.slice(90, 130) !== contracts.usdc.slice(2).toLowerCase()
      )
        throw new Error("invalid paymaster fee event");
      charged = BigInt("0x" + l.data.slice(130, 194));
    }
    if (l.topics[0] !== transfer || l.topics.length !== 3) continue;
    const from = "0x" + l.topics[1]!.slice(-40),
      to = "0x" + l.topics[2]!.slice(-40),
      amount = BigInt(l.data);
    if (l.address === contracts.weth.toLowerCase() && from === sender) spent += amount;
    if (l.address !== contracts.usdc.toLowerCase()) continue;
    if (to === sender) received += amount;
    if (from === sender) {
      if (to === recipient) paid += amount;
      else fee += amount;
    }
  }
  if (
    paid !== BigInt(q.amountMicroUsdc) ||
    wrappedNative !== BigInt(q.wrapNativeWei ?? "0") ||
    fee <= 0n ||
    fee !== charged ||
    fee > BigInt(q.maxGasMicroUsdc) ||
    received !== BigInt(q.swapOutputMicroUsdc) ||
    spent > BigInt(q.maxWethWei) ||
    (spent === 0n) !== (received === 0n)
  )
    throw new Error("payment deltas differ from quote");
  return {
    ...base,
    status: "settled",
    paidMicroUsdc: String(paid),
    gasChargedMicroUsdc: String(fee),
    spentWethWei: String(spent),
    wrappedNativeWei: String(wrappedNative),
    receivedFromSwapMicroUsdc: String(received),
  };
}
