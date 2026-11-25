import {
  acrossTestRoute,
  checkCircleBatch,
  checkCircleBurn,
  circleMessenger,
  EvmAddress,
  paymentContracts,
} from "@swapchan/shared";
import {
  type CircleDevnetIntent,
  matchesSolanaForwardBurn,
  solanaForwardTarget,
} from "@swapchan/shared/solana-payment";
import {
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  keccak256,
  pad,
  parseAbi,
  slice,
  toEventSelector,
} from "viem";
import { entryPoint08Abi } from "viem/account-abstraction";
import { z } from "zod";
import { solanaCircleMint } from "./payment-circle-solana.js";
import { receiptFees } from "./payment-origin-fees.js";

const hash = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/i)
  .transform((v) => v.toLowerCase() as Hex);
const data = z
  .string()
  .regex(/^0x(?:[a-f0-9]{2})*$/i)
  .transform((v) => v.toLowerCase() as Hex);
const quantity = z.string().regex(/^0x[a-f0-9]+$/i);
const amount = z.string().regex(/^[1-9][0-9]{0,37}$/);
export const circleStatusInput = z
  .object({
    originHash: hash,
    approvalHash: hash.optional(),
    burnDataHash: hash,
    sender: EvmAddress,
    recipient: EvmAddress,
    amountMicroUsdc: amount,
    maxInputMicroUsdc: amount,
  })
  .strict();
const transmitter = "0xe737e5cebeeba77efe34d4aa090756590b1ce275";
const events = parseAbi([
  "event MessageSent(bytes message)",
  "event MessageReceived(address indexed caller,uint32 sourceDomain,bytes32 indexed nonce,bytes32 sender,uint32 indexed finalityThresholdExecuted,bytes messageBody)",
]);
const receipt = z.object({
  transactionHash: hash,
  blockHash: hash,
  blockNumber: quantity,
  transactionIndex: quantity,
  from: EvmAddress,
  to: EvmAddress,
  status: quantity,
  gasUsed: quantity,
  effectiveGasPrice: quantity,
  l1Fee: quantity.optional(),
  logs: z.array(z.object({ address: EvmAddress, topics: z.array(hash), data })),
});
type Rpc = (chain: 84532 | 11155420, method: string, p: unknown[]) => Promise<unknown>;
function transfers(r: z.infer<typeof receipt>, token: string, owner: string) {
  let total = 0n;
  for (const l of r.logs) {
    if (
      l.address.toLowerCase() !== token.toLowerCase() ||
      l.topics[0] !== toEventSelector("Transfer(address,address,uint256)")
    )
      continue;
    const { args: t } = decodeEventLog({
      abi: erc20Abi,
      eventName: "Transfer",
      data: l.data,
      topics: l.topics as [Hex, ...Hex[]],
    });
    if (t.to.toLowerCase() === owner.toLowerCase()) total += t.value;
    if (t.from.toLowerCase() === owner.toLowerCase()) total -= t.value;
  }
  return total;
}
// Restrict wallet-bundled receipts to the same reviewed Simple7702Account batch.
export function circleWalletOperation(
  input: Hex,
  logs: z.infer<typeof receipt>["logs"],
  intent: z.infer<typeof circleStatusInput>,
) {
  const decoded = decodeFunctionData({ abi: entryPoint08Abi, data: input });
  if (decoded.functionName !== "handleOps") throw Error("Unsupported Circle wallet transaction");
  const [ops] = decoded.args;
  const matches = ops
    .map((op, index) => ({ op, index }))
    .filter(({ op }) => op.sender.toLowerCase() === intent.sender.toLowerCase());
  if (matches.length !== 1) throw Error("Ambiguous wallet operation");
  const { op, index } = matches[0]!;
  if (op.paymasterAndData !== "0x") throw Error("Unreviewed wallet paymaster");
  const paid = checkCircleBatch(op.callData, intent);
  const events = logs
    .map((log, position) => ({ log, position }))
    .filter(({ log }) => log.address.toLowerCase() === paymentContracts.entry.toLowerCase());
  const boundaries = events.filter(
    ({ log }) => log.topics[0] === toEventSelector("BeforeExecution()"),
  );
  const completed = events.filter(
    ({ log }) =>
      log.topics[0] ===
      toEventSelector("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)"),
  );
  if (
    completed.length !== ops.length ||
    boundaries.length !== 1 ||
    boundaries[0]!.position >= completed[0]!.position
  )
    throw Error("Incomplete wallet operation events");
  const { log, position } = completed[index]!;
  const { args: event } = decodeEventLog({
    abi: entryPoint08Abi,
    eventName: "UserOperationEvent",
    topics: log.topics as [Hex, ...Hex[]],
    data: log.data,
  });
  if (
    !event.success ||
    event.sender.toLowerCase() !== intent.sender.toLowerCase() ||
    event.nonce !== op.nonce ||
    BigInt(event.paymaster) !== 0n
  )
    throw Error("Wallet operation failed or changed");
  const previous = index ? completed[index - 1]! : boundaries[0]!;
  return {
    paid,
    logs: logs.slice(previous.position + 1, position),
    fees: { userOpHash: event.userOpHash, entryPointGasCostWei: event.actualGasCost.toString() },
  };
}
// Circle fills nonce, executed finality, fee and expiry after the origin burn.
function sameBurnMessage(original: Hex, attested: Hex) {
  return (
    original.length === attested.length &&
    original.length >= 2 + 376 * 2 &&
    (
      [
        [0, 12],
        [44, 144],
        [148, 312],
        [376, undefined],
      ] as const
    ).every(
      ([start, end]) =>
        original.slice(2 + 2 * start, end === undefined ? undefined : 2 + 2 * end) ===
        attested.slice(2 + 2 * start, end === undefined ? undefined : 2 + 2 * end),
    )
  );
}

export async function circleStatus(
  i:
    | z.infer<typeof circleStatusInput>
    | (CircleDevnetIntent & {
        originHash: Hex;
        approvalHash?: Hex;
        burnDataHash: Hex;
        maxInputMicroUsdc: string;
        solanaRpc: (method: string, params: unknown[]) => Promise<unknown>;
      }),
  rpc: Rpc,
  f: typeof fetch,
  sponsored?: {
    blockHash: string;
    gasChargedMicroUsdc: string;
    receivedFromSwapMicroUsdc: string;
    logs: unknown[];
  },
) {
  async function canonical(chain: 84532 | 11155420, tx: Hex) {
    const raw = await rpc(chain, "eth_getTransactionReceipt", [tx]);
    if (raw === null) return null;
    const r = receipt.parse(raw);
    const [b, final] = await Promise.all([
      rpc(chain, "eth_getBlockByNumber", [r.blockNumber, false]),
      rpc(chain, "eth_getBlockByNumber", ["finalized", false]),
    ]);
    const block = z.object({ hash, parentHash: hash }).parse(b);
    if (r.transactionHash !== tx || block.hash !== r.blockHash)
      throw Error("Noncanonical Circle receipt");
    return {
      r,
      parentHash: block.parentHash,
      finalized:
        BigInt(z.object({ number: quantity }).parse(final).number) >= BigInt(r.blockNumber),
    };
  }
  async function balances(chain: 84532 | 11155420, owner: Hex, before: Hex, after: Hex) {
    const token = chain === 84532 ? acrossTestRoute.sourceToken : acrossTestRoute.destinationToken;
    async function at(blockHash: Hex) {
      const block = { blockHash, requireCanonical: true };
      const [eth, usd] = await Promise.all([
        rpc(chain, "eth_getBalance", [owner, block]),
        rpc(chain, "eth_call", [
          {
            to: token,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
          },
          block,
        ]),
      ]);
      return {
        blockHash,
        ethWei: String(BigInt(quantity.parse(eth))),
        microUsdc: String(BigInt(hash.parse(usd))),
      };
    }
    const [first, last] = await Promise.all([at(before), at(after)]);
    return { before: first, after: last };
  }
  const origin = await canonical(84532, i.originHash);
  if (!origin) return { status: "awaiting_origin_receipt" };
  const allOriginLogs = origin.r.logs;
  let paid: bigint;
  let walletFees: { userOpHash: Hex; entryPointGasCostWei: string } | undefined;
  if (sponsored) {
    if (origin.r.blockHash !== sponsored.blockHash || i.approvalHash)
      throw Error("Sponsored origin changed");
    origin.r.logs = receipt.shape.logs.parse(sponsored.logs);
    paid = BigInt(i.amountMicroUsdc);
  } else {
    const tx = z
      .object({ input: data, hash, blockHash: hash, value: quantity })
      .parse(await rpc(84532, "eth_getTransactionByHash", [i.originHash]));
    if (tx.hash !== i.originHash || tx.blockHash !== origin.r.blockHash || BigInt(tx.value) !== 0n)
      throw Error("Unexpected Circle transaction");
    if ("solanaRpc" in i) {
      if (
        origin.r.from.toLowerCase() !== i.sender.toLowerCase() ||
        origin.r.to.toLowerCase() !== circleMessenger.toLowerCase() ||
        keccak256(tx.input) !== i.burnDataHash ||
        !matchesSolanaForwardBurn(i, tx.input)
      )
        throw Error("Unexpected Circle burn for Solana");
      paid = BigInt(i.amountMicroUsdc);
    } else if (origin.r.to.toLowerCase() === paymentContracts.entry.toLowerCase()) {
      if (i.approvalHash || origin.r.status !== "0x1") throw Error("Invalid Circle wallet batch");
      const operation = circleWalletOperation(tx.input, origin.r.logs, i);
      paid = operation.paid;
      origin.r.logs = operation.logs;
      walletFees = operation.fees;
    } else {
      const atomic = origin.r.to.toLowerCase() === i.sender.toLowerCase();
      if (
        origin.r.from.toLowerCase() !== i.sender.toLowerCase() ||
        (!atomic && origin.r.to.toLowerCase() !== circleMessenger.toLowerCase()) ||
        (atomic && i.approvalHash)
      )
        throw Error("Unexpected Circle burn");
      paid = atomic ? checkCircleBatch(tx.input, i) : checkCircleBurn(tx.input, i);
    }
  }
  const base = {
    originHash: i.originHash,
    originFinalized: origin.finalized,
    originFees: sponsored
      ? { gasChargedMicroUsdc: sponsored.gasChargedMicroUsdc }
      : (walletFees ?? receiptFees(origin.r)),
  };
  if (origin.r.status === "0x0") return { ...base, status: "burn_reverted" };
  const spent =
    -transfers(origin.r, acrossTestRoute.sourceToken, i.sender) -
    BigInt(sponsored?.gasChargedMicroUsdc ?? "0") +
    BigInt(sponsored?.receivedFromSwapMicroUsdc ?? "0");
  const sent = origin.r.logs.filter(
    (l) => l.address.toLowerCase() === transmitter && l.topics[0] === toEventSelector(events[0]),
  );
  if (
    origin.r.status !== "0x1" ||
    sent.length !== 1 ||
    spent !== BigInt(i.maxInputMicroUsdc) ||
    spent < paid
  )
    throw Error("Unexpected Circle token spend");
  const original = decodeEventLog({
    abi: [events[0]],
    topics: sent[0]!.topics as [Hex, ...Hex[]],
    data: sent[0]!.data,
  }).args.message;
  const matchingBurns = allOriginLogs
    .filter(
      (l) => l.address.toLowerCase() === transmitter && l.topics[0] === toEventSelector(events[0]),
    )
    .filter((l) => {
      const message = decodeEventLog({
        abi: [events[0]],
        topics: l.topics as [Hex, ...Hex[]],
        data: l.data,
      }).args.message;
      return sameBurnMessage(original, message);
    });
  if (matchingBurns.length !== 1) throw Error("Ambiguous Circle burn in origin transaction");
  let start = origin.parentHash;
  let approval;
  if (i.approvalHash) {
    const a = await canonical(84532, i.approvalHash);
    if (
      !a ||
      a.r.status !== "0x1" ||
      a.r.from.toLowerCase() !== i.sender.toLowerCase() ||
      a.r.to.toLowerCase() !== acrossTestRoute.sourceToken.toLowerCase() ||
      BigInt(a.r.blockNumber) > BigInt(origin.r.blockNumber) ||
      (a.r.blockNumber === origin.r.blockNumber &&
        BigInt(a.r.transactionIndex) >= BigInt(origin.r.transactionIndex))
    )
      throw Error("Unexpected Circle approval receipt");
    const mined = z
      .object({ hash, blockHash: hash, value: quantity, input: data })
      .parse(await rpc(84532, "eth_getTransactionByHash", [i.approvalHash]));
    const expected = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [circleMessenger, spent],
    });
    if (
      mined.hash !== i.approvalHash ||
      mined.blockHash !== a.r.blockHash ||
      BigInt(mined.value) !== 0n ||
      mined.input !== expected.toLowerCase()
    )
      throw Error("Approval differs from Circle spend");
    start = a.parentHash;
    approval = { transactionHash: i.approvalHash, fees: receiptFees(a.r), finalized: a.finalized };
  }
  const progress = {
    ...base,
    ...(approval ? { approval } : {}),
    sourceBlockBalances: await balances(84532, i.sender, start, origin.r.blockHash).catch(
      () => null,
    ),
    spentMicroUsdc: String(spent),
    forwardFeeMicroUsdc: String(spent - paid),
  };
  const url = "https://iris-api-sandbox.circle.com/v2/messages/6?transactionHash=" + i.originHash;
  const response = await f(url, { signal: AbortSignal.timeout(10000) });
  if (response.status === 404) return { ...progress, status: "awaiting_attestation" };
  if (!response.ok) throw Error("Circle index unavailable");
  const index = z
    .object({
      messages: z
        .array(
          z.object({
            eventNonce: hash,
            status: z.string(),
            forwardTxHash: z.string().nullish(),
            forwardState: z.string().nullish(),
            delayReason: z.string().nullish(),
            message: z.string().nullish(),
          }),
        )
        .max(128),
    })
    .parse(await response.json());
  const matches = index.messages.filter((m) => {
    const v = data.safeParse(m.message);
    return v.success && sameBurnMessage(original, v.data);
  });
  if (matches.length > 1) throw Error("Ambiguous Circle attestation");
  const msg =
    matches[0] ??
    (index.messages.length === 1 && !index.messages[0]?.forwardTxHash
      ? index.messages[0]
      : undefined);
  if (
    !msg ||
    (!msg.forwardTxHash && !("solanaRpc" in i && matches[0] && msg.status === "complete"))
  )
    return {
      ...progress,
      status: msg?.status === "complete" ? "awaiting_forward" : "awaiting_attestation",
      providerStatus: msg?.status,
      providerForwardState: msg?.forwardState ?? undefined,
      providerDelayReason: msg?.delayReason ?? undefined,
    };
  const attested = data.parse(msg.message);
  if ("solanaRpc" in i) {
    const target = solanaForwardTarget(i.recipient);
    const body = slice(attested, 148);
    if (
      slice(attested, 12, 44) !== msg.eventNonce ||
      BigInt(slice(attested, 4, 8)) !== 6n ||
      BigInt(slice(attested, 8, 12)) !== 5n ||
      slice(body, 4, 36) !== pad(acrossTestRoute.sourceToken).toLowerCase() ||
      slice(body, 36, 68) !== target.mintRecipient ||
      BigInt(slice(body, 68, 100)) !== paid ||
      BigInt(slice(body, 164, 196)) !== 0n ||
      slice(body, 228) !== target.hookData
    )
      throw Error("Attested Solana burn differs from review");
    const dest = await solanaCircleMint(i.solanaRpc, msg.forwardTxHash ?? undefined, attested, i);
    return {
      ...progress,
      ...dest,
      status: dest.status === "settled" && !origin.finalized ? "awaiting_finality" : dest.status,
    };
  }
  const mintHash = hash.parse(msg.forwardTxHash);
  const dest = await canonical(11155420, mintHash);
  if (!dest) return { ...progress, status: "awaiting_mint_receipt", mintHash };
  const received = dest.r.logs.filter(
    (l) =>
      l.address.toLowerCase() === transmitter &&
      l.topics[0] === toEventSelector(events[1]) &&
      l.topics[2] === msg.eventNonce,
  );
  if (
    dest.r.status !== "0x1" ||
    received.length !== 1 ||
    slice(attested, 12, 44) !== msg.eventNonce
  )
    throw Error("Unexpected mint receipt");
  const event = decodeEventLog({
    abi: [events[1]],
    topics: received[0]!.topics as [Hex, ...Hex[]],
    data: received[0]!.data,
  }).args;
  // BurnMessageV2 encodes token, mint recipient, amount and fee executed at fixed byte offsets.
  const body = event.messageBody;
  if (
    event.sourceDomain !== 6 ||
    BigInt(slice(attested, 4, 8)) !== 6n ||
    BigInt(slice(attested, 8, 12)) !== 2n ||
    event.finalityThresholdExecuted !== Number(slice(attested, 144, 148)) ||
    event.sender !== slice(attested, 44, 76) ||
    body !== slice(attested, 148) ||
    slice(body, 4, 36) !== pad(acrossTestRoute.sourceToken).toLowerCase() ||
    slice(body, 36, 68) !== pad(i.recipient).toLowerCase() ||
    BigInt(slice(body, 68, 100)) !== paid ||
    BigInt(slice(body, 164, 196)) !== 0n ||
    transfers(dest.r, acrossTestRoute.destinationToken, i.recipient) !== paid
  )
    throw Error("Mint differs from payment");
  return {
    ...progress,
    status: origin.finalized && dest.finalized ? "settled" : "awaiting_finality",
    destinationFinalized: dest.finalized,
    mintHash,
    paidMicroUsdc: String(paid),
    destinationBlockBalances: await balances(
      11155420,
      i.recipient,
      dest.parentHash,
      dest.r.blockHash,
    ).catch(() => null),
  };
}
