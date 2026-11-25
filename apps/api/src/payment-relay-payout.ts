import { acrossRoute } from "@swapchan/shared";
import { decodeEventLog, erc20Abi, type Hex, toEventSelector } from "viem";
import { z } from "zod";

const hash = z.string().regex(/^0x[0-9a-f]{64}$/i);
const quantity = z.string().regex(/^0x[0-9a-f]+$/i);
export async function relayPayout(
  rpc: (url: string, method: string, params: unknown[]) => Promise<unknown>,
  r: { recipient: string; payoutMicroUsdc: string },
  destHash: string,
) {
  const op = (method: string, params: unknown[]) =>
    rpc("https://mainnet.optimism.io", method, params);
  const raw = await op("eth_getTransactionReceipt", [destHash]);
  if (!raw) return { status: "awaiting_destination_receipt" };
  const receipt = z
    .object({
      transactionHash: hash,
      blockNumber: quantity,
      blockHash: hash,
      status: z.literal("0x1"),
      logs: z.array(z.object({ address: z.string(), topics: z.array(hash), data: z.string() })),
    })
    .parse(raw);
  if (receipt.transactionHash !== destHash) throw Error("Unexpected destination receipt");
  const [canonical, final] = await Promise.all([
    op("eth_getBlockByNumber", [receipt.blockNumber, false]),
    op("eth_getBlockByNumber", ["finalized", false]),
  ]);
  if (z.object({ hash }).parse(canonical).hash !== receipt.blockHash)
    throw Error("Destination receipt changed");
  let gain = 0n;
  for (const l of receipt.logs) {
    if (
      l.address.toLowerCase() !== acrossRoute(10).destinationToken.toLowerCase() ||
      l.topics[0] !== toEventSelector("Transfer(address,address,uint256)")
    )
      continue;
    const { args: t } = decodeEventLog({
      abi: erc20Abi,
      eventName: "Transfer",
      topics: l.topics as [Hex, ...Hex[]],
      data: l.data as Hex,
    });
    if (t.to.toLowerCase() === r.recipient.toLowerCase()) gain += t.value;
    if (t.from.toLowerCase() === r.recipient.toLowerCase()) gain -= t.value;
  }
  if (gain !== BigInt(r.payoutMicroUsdc))
    throw Error("Recipient delta differs from reviewed payout");
  const finalized =
    BigInt(z.object({ number: quantity }).parse(final).number) >= BigInt(receipt.blockNumber);
  return {
    status: finalized ? "settled" : "awaiting_destination_finality",
    destination: {
      transactionHash: destHash,
      blockHash: receipt.blockHash,
      recipient: r.recipient,
      paidMicroUsdc: String(gain),
      finalized,
    },
    transactionLinkSource: "relay_request_index",
  };
}
