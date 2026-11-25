import { createHash } from "node:crypto";
import {
  decodeEventLog,
  decodeFunctionData,
  erc20Abi,
  type Hex,
  parseAbi,
  toEventSelector,
} from "viem";
import { z } from "zod";
import { type Fetch, getJson } from "./types.js";

const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const router = parseAbi([
  "function transferOut(address to,address asset,uint256 amount,string memo)",
]);
const bytes = z
  .string()
  .regex(/^0x(?:[a-f0-9]{2})*$/i)
  .transform((v) => v.toLowerCase() as Hex);
const uint = z.number().int().nonnegative().safe();
const quantity = z.string().regex(/^0x[0-9a-f]+$/i);
const post = (f: Fetch, signal: AbortSignal, url: string, body: unknown) =>
  getJson<unknown>(f, url, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function solidTransfer(f: Fetch, signal: AbortSignal, origin: string) {
  const raw = await post(f, signal, "https://api.trongrid.io/walletsolidity/gettransactionbyid", {
    value: origin,
    visible: true,
  });
  const src = z
    .object({
      txID: z.string(),
      raw_data_hex: z.string().regex(/^(?:[0-9a-f]{2})+$/i),
      signature: z.array(z.string().regex(/^[0-9a-f]{130}$/i)).min(1),
      ret: z.tuple([z.object({ contractRet: z.literal("SUCCESS") })]),
      raw_data: z.object({
        data: z.string().regex(/^(?:[a-f0-9]{2})+$/i),
        contract: z.tuple([
          z.object({
            type: z.literal("TransferContract"),
            parameter: z.object({
              value: z.object({
                owner_address: z.string(),
                to_address: z.string(),
                amount: uint.positive(),
              }),
            }),
          }),
        ]),
      }),
    })
    .parse(raw);
  if (
    src.txID.toLowerCase() !== origin ||
    createHash("sha256").update(Buffer.from(src.raw_data_hex, "hex")).digest("hex") !== origin
  )
    throw Error("Tron transaction mismatch");
  const memo = Buffer.from(src.raw_data.data, "hex").toString("utf8");
  return { src, memo };
}

/** Verify a THORChain-reported native TRX swap that paid Ethereum USDC. */
export async function tronUsdcSettlement(
  f: Fetch,
  signal: AbortSignal,
  inbound: string,
  outbound: string,
  ethereumRpc: string,
) {
  const origin = inbound.replace(/^0x/i, "").toLowerCase();
  const hash = "0x" + outbound.replace(/^0x/i, "").toLowerCase();
  const eth = async (method: string, params: unknown[]) =>
    z
      .object({ result: z.unknown() })
      .parse(await post(f, signal, ethereumRpc, { jsonrpc: "2.0", id: 1, method, params })).result;
  const [{ src, memo }, info, txRaw, receiptRaw, finalRaw] = await Promise.all([
    solidTransfer(f, signal, origin),
    post(f, signal, "https://api.trongrid.io/walletsolidity/gettransactioninfobyid", {
      value: origin,
      visible: true,
    }),
    eth("eth_getTransactionByHash", [hash]),
    eth("eth_getTransactionReceipt", [hash]),
    eth("eth_getBlockByNumber", ["finalized", false]),
  ]);
  const sourceReceipt = z
    .object({ id: z.string(), blockNumber: uint, fee: uint.optional() })
    .parse(info);
  if (sourceReceipt.id.toLowerCase() !== origin) throw Error("Tron receipt mismatch");
  const [kind, asset, addresses] = memo.split(":");
  const recipient = addresses?.split("/")[0]?.toLowerCase();
  if (
    !["=", "SWAP", "S"].includes(kind?.toUpperCase() ?? "") ||
    !["ETH.USDC", "ETH.USDC-" + usdc.toUpperCase()].includes(asset?.toUpperCase() ?? "") ||
    !recipient ||
    !/^0x[a-f0-9]{40}$/.test(recipient)
  )
    throw Error("Unsupported Tron swap memo");
  const tx = z
    .object({ hash: bytes, blockHash: bytes, to: bytes, input: bytes, value: quantity })
    .parse(txRaw);
  const r = z
    .object({
      transactionHash: bytes,
      blockHash: bytes,
      blockNumber: quantity,
      to: bytes,
      status: z.literal("0x1"),
      gasUsed: quantity,
      effectiveGasPrice: quantity,
      logs: z.array(z.object({ address: bytes, topics: z.array(bytes), data: bytes })),
    })
    .parse(receiptRaw);
  const block = z
    .object({ hash: bytes })
    .parse(await eth("eth_getBlockByNumber", [r.blockNumber, false]));
  if (
    tx.hash !== hash ||
    r.transactionHash !== hash ||
    tx.blockHash !== r.blockHash ||
    r.blockHash !== block.hash ||
    r.to !== tx.to ||
    BigInt(tx.value) !== 0n
  )
    throw Error("Unexpected Ethereum receipt");
  const {
    args: [to, token, amount, reference],
  } = decodeFunctionData({ abi: router, data: tx.input });
  if (
    to.toLowerCase() !== recipient ||
    token.toLowerCase() !== usdc ||
    reference.toUpperCase() !== "OUT:" + origin.toUpperCase() ||
    amount <= 0n
  )
    throw Error("THORChain outbound differs from inbound");
  const logs = r.logs
    .filter(
      (l) =>
        l.address === usdc && l.topics[0] === toEventSelector("Transfer(address,address,uint256)"),
    )
    .map((l) => ({ ...l, topics: l.topics as [Hex, ...Hex[]] }));
  let delta = 0n,
    matches = 0;
  for (const l of logs) {
    const { args: t } = decodeEventLog({
      abi: erc20Abi,
      eventName: "Transfer",
      data: l.data,
      topics: l.topics,
    });
    if (t.to.toLowerCase() === recipient) {
      delta += t.value;
      if (t.from.toLowerCase() === tx.to && t.value === amount) matches++;
    }
    if (t.from.toLowerCase() === recipient) delta -= t.value;
  }
  if (matches !== 1 || delta !== amount) throw Error("USDC transfer mismatch");
  const final = z.object({ number: quantity }).parse(finalRaw);
  return {
    status:
      BigInt(final.number) >= BigInt(r.blockNumber)
        ? ("settled" as const)
        : ("awaiting_finality" as const),
    sourceSignatureCount: src.signature.length,
    sourceAmountSun: String(src.raw_data.contract[0].parameter.value.amount),
    sourceFeeSun: sourceReceipt.fee === undefined ? null : String(sourceReceipt.fee),
    sourceBlock: sourceReceipt.blockNumber,
    destinationBlock: String(BigInt(r.blockNumber)),
    recipient,
    paidMicroUsdc: String(delta),
    outboundExecutionFeeWei: String(BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice)),
  };
}

export async function tronRefund(f: Fetch, signal: AbortSignal, inbound: string, refund: string) {
  const origin = inbound.replace(/^0x/i, "").toLowerCase();
  const [deposit, returned] = await Promise.all([
    solidTransfer(f, signal, origin),
    solidTransfer(f, signal, refund.replace(/^0x/i, "").toLowerCase()),
  ]);
  const input = deposit.src.raw_data.contract[0].parameter.value;
  const output = returned.src.raw_data.contract[0].parameter.value;
  if (
    returned.memo.toUpperCase() !== "REFUND:" + origin.toUpperCase() ||
    output.to_address !== input.owner_address ||
    output.amount > input.amount
  )
    throw Error("Tron refund differs from deposit");
  return {
    status: "refunded" as const,
    recipient: output.to_address,
    depositedSun: String(input.amount),
    returnedSun: String(output.amount),
  };
}
