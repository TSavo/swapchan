import { acrossTestRoute, checkCircleBurn, circleMessenger, EvmAddress } from "@swapchan/shared";
import {
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  parseAbi,
  slice,
  toEventSelector,
} from "viem";
import { z } from "zod";
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
export async function circleStatus(
  i: z.infer<typeof circleStatusInput>,
  rpc: Rpc,
  f: typeof fetch,
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
  const tx = z
    .object({ input: data, hash, blockHash: hash, value: quantity })
    .parse(await rpc(84532, "eth_getTransactionByHash", [i.originHash]));
  if (
    tx.hash !== i.originHash ||
    tx.blockHash !== origin.r.blockHash ||
    origin.r.from.toLowerCase() !== i.sender.toLowerCase() ||
    origin.r.to.toLowerCase() !== circleMessenger.toLowerCase() ||
    BigInt(tx.value) !== 0n
  )
    throw Error("Unexpected Circle burn");
  const paid = checkCircleBurn(tx.input, i);
  const base = {
    originHash: i.originHash,
    originFinalized: origin.finalized,
    originFees: receiptFees(origin.r),
  };
  if (origin.r.status === "0x0") return { ...base, status: "burn_reverted" };
  const spent = -transfers(origin.r, acrossTestRoute.sourceToken, i.sender);
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
            forwardTxHash: hash.nullish(),
            message: z.string().nullish(),
          }),
        )
        .max(1),
    })
    .parse(await response.json());
  const msg = index.messages[0];
  if (!msg?.forwardTxHash)
    return {
      ...progress,
      status: msg?.status === "complete" ? "awaiting_forward" : "awaiting_attestation",
      providerStatus: msg?.status,
    };
  const mintHash = msg.forwardTxHash;
  const dest = await canonical(11155420, mintHash);
  if (!dest) return { ...progress, status: "awaiting_mint_receipt", mintHash };
  const attested = data.parse(msg.message);
  // CCTP v2 fills in nonce, executed finality, fee and expiration. All other bytes must match the origin event.
  for (const [start, end] of [
    [0, 12],
    [44, 144],
    [148, 312],
    [376, undefined],
  ] as const)
    if (slice(original, start, end) !== slice(attested, start, end))
      throw Error("Attestation differs from origin");
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
  if (
    event.sourceDomain !== 6 ||
    event.sender !== slice(attested, 44, 76) ||
    event.messageBody !== slice(attested, 148) ||
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
