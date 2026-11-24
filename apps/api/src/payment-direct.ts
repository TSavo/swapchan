import { acrossRoute, EvmAddress } from "@swapchan/shared";
import { decodeEventLog, encodeFunctionData, erc20Abi, type Hex, toEventSelector } from "viem";
import { z } from "zod";
import { estimateOriginFees } from "./payment-origin-fees.js";

export const destinationIntent = z
  .object({
    chainId: z.union([z.literal(10), z.literal(11155420)]),
    sender: EvmAddress,
    recipient: EvmAddress,
    amountMicroUsdc: z.string().regex(/^[1-9][0-9]{0,37}$/),
  })
  .strict()
  .refine(
    (i) =>
      i.sender.toLowerCase() !== i.recipient.toLowerCase() &&
      !/^0x0{40}$/i.test(i.sender) &&
      !/^0x0{40}$/i.test(i.recipient),
  );
type Intent = z.infer<typeof destinationIntent>;
type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
const quantity = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]*)$/i);
const word = z.string().regex(/^0x[0-9a-f]{64}$/i);
const address = z.string().regex(/^0x[0-9a-f]{40}$/i);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function transfer(i: Intent) {
  return {
    chainId: i.chainId,
    from: i.sender,
    to: acrossRoute(i.chainId).destinationToken,
    value: "0x0",
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [i.recipient, BigInt(i.amountMicroUsdc)],
    }),
  };
}
export async function quoteDirect(i: Intent, rpc: Rpc) {
  const tx = transfer(i);
  const block = quantity.parse(await rpc("eth_blockNumber", []));
  const [balance, native, code] = await Promise.all([
    rpc("eth_call", [
      {
        to: tx.to,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [i.sender] }),
      },
      block,
    ]).then((x) => BigInt(word.parse(x))),
    rpc("eth_getBalance", [i.sender, block]).then((x) => BigInt(quantity.parse(x))),
    rpc("eth_getCode", [i.sender, block]),
  ]);
  const out = BigInt(i.amountMicroUsdc);
  let estimate: Awaited<ReturnType<typeof estimateOriginFees>> | null = null;
  let status = "insufficient_usdc";
  if (code !== "0x") status = "unsupported_account_code";
  else if (balance >= out) {
    status = "unavailable";
    try {
      const { from, to, data, value } = tx;
      const [batch] = z
        .array(
          z.object({
            calls: z
              .array(z.object({ status: quantity, returnData: word, gasUsed: quantity }))
              .length(1),
          }),
        )
        .length(1)
        .parse(
          await rpc("eth_simulateV1", [
            { blockStateCalls: [{ calls: [{ from, to, data, value }] }], validation: false },
            block,
          ]),
        );
      const r = batch!.calls[0]!;
      if (r.status === "0x1" && BigInt(r.returnData) === 1n && BigInt(r.gasUsed) > 0n) {
        estimate = await estimateOriginFees(rpc, i.chainId, block, i.sender, [
          { to, data, gas: BigInt(r.gasUsed) },
        ]);
        status = "succeeded";
      } else status = "reverted";
    } catch {}
  }
  return {
    quote: {
      ...i,
      sourceChainId: i.chainId,
      provider: "direct_transfer" as const,
      atomic: true,
      execution:
        estimate && BigInt(estimate.totalWei) <= native ? "unsigned_origin_steps" : "quote_only",
      inputToken: tx.to,
      outputToken: tx.to,
      inputMicroUsdc: i.amountMicroUsdc,
      maxInputMicroUsdc: i.amountMicroUsdc,
      sourceWallet: {
        blockNumber: block,
        balanceMicroUsdc: balance.toString(),
        nativeBalanceWei: native.toString(),
        requiredApprovalMicroUsdc: "0",
      },
      originSimulation: { status },
      originGas: { token: "ETH", includedInMaxInput: false, estimate },
      expiresAt: Math.floor(Date.now() / 1000) + 90,
    },
    tx,
  };
}
export const directReceiptInput = destinationIntent.safeExtend({ transactionHash: word });
export async function directReceipt(i: z.infer<typeof directReceiptInput>, rpc: Rpc) {
  const raw = await rpc("eth_getTransactionReceipt", [i.transactionHash]);
  if (!raw) return { status: "awaiting_receipt" };
  const r = z
    .object({
      transactionHash: word,
      blockHash: word,
      blockNumber: quantity,
      status: quantity,
      from: address,
      to: address,
      logs: z.array(z.object({ address, data: z.string(), topics: z.array(word) })),
    })
    .parse(raw);
  const block = z
    .object({ hash: word })
    .parse(await rpc("eth_getBlockByNumber", [r.blockNumber, false]));
  const tx = transfer(i);
  if (
    !same(r.transactionHash, i.transactionHash) ||
    !same(block.hash, r.blockHash) ||
    !same(r.from, i.sender) ||
    !same(r.to, tx.to)
  )
    throw Error("Unexpected receipt");
  const mined = z
    .object({ blockHash: word, input: z.string(), value: quantity })
    .parse(await rpc("eth_getTransactionByHash", [i.transactionHash]));
  if (
    !same(mined.blockHash, r.blockHash) ||
    !same(mined.input, tx.data) ||
    BigInt(mined.value) !== 0n
  )
    throw Error("Transaction differs from intent");
  if (r.status === "0x0") return { status: "reverted", transactionHash: i.transactionHash };
  const logs = r.logs.filter(
    (l) =>
      same(l.address, tx.to) &&
      l.topics[0] === toEventSelector("Transfer(address,address,uint256)"),
  );
  if (r.status !== "0x1" || logs.length !== 1) throw Error("Unexpected transfer events");
  const l = logs[0]!;
  const { args } = decodeEventLog({
    abi: erc20Abi,
    eventName: "Transfer",
    topics: l.topics as [Hex, ...Hex[]],
    data: l.data as Hex,
  });
  if (
    !same(args.from, i.sender) ||
    !same(args.to, i.recipient) ||
    args.value !== BigInt(i.amountMicroUsdc)
  )
    throw Error("Payout differs from intent");
  const finalized = z
    .object({ number: quantity })
    .parse(await rpc("eth_getBlockByNumber", ["finalized", false]));
  return {
    status: BigInt(finalized.number) >= BigInt(r.blockNumber) ? "settled" : "awaiting_finality",
    transactionHash: i.transactionHash,
    paidMicroUsdc: i.amountMicroUsdc,
  };
}
