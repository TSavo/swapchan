import { batchAbi, paymentContracts } from "@swapchan/shared";
import { encodeFunctionData, type Hex, keccak256 } from "viem";
import { z } from "zod";
import { simpleAccountRuntimeHash } from "./payment-delegation.js";
import { estimateOriginFees } from "./payment-origin-fees.js";

export async function simulateAtomicOrigin(
  rpc: (method: string, params: unknown[]) => Promise<unknown>,
  block: string,
  sender: Hex,
  calls: { to: Hex; data: Hex }[],
  after?: { call: { from: Hex; to: Hex; data: Hex }; expected: Hex },
) {
  const delegate = paymentContracts.delegate;
  const code = await rpc("eth_getCode", [sender, block]);
  if (
    typeof code !== "string" ||
    code.toLowerCase() !== "0xef0100" + delegate.slice(2).toLowerCase()
  )
    return null;
  const runtime = z
    .string()
    .regex(/^0x(?:[0-9a-f]{2})+$/i)
    .parse(await rpc("eth_getCode", [delegate, block])) as Hex;
  if (keccak256(runtime) !== simpleAccountRuntimeHash) return null;
  const data = encodeFunctionData({
    abi: batchAbi,
    functionName: "executeBatch",
    args: [calls.map((c) => ({ target: c.to, data: c.data, value: 0n }))],
  });
  const transaction = { from: sender, to: sender, data };
  const simulationCalls = after ? [transaction, after.call] : [transaction];
  const [result] = z
    .tuple([
      z.object({
        calls: z
          .array(
            z.object({
              status: z.literal("0x1"),
              returnData: z.string(),
              gasUsed: z.string().regex(/^0x[1-9a-f][0-9a-f]*$/i),
            }),
          )
          .length(simulationCalls.length),
      }),
    ])
    .parse(
      await rpc("eth_simulateV1", [
        { blockStateCalls: [{ calls: simulationCalls }], validation: false },
        block,
      ]),
    );
  const outer = result.calls[0]!;
  if (
    outer.returnData !== "0x" ||
    (after && result.calls[1]?.returnData.toLowerCase() !== after.expected.toLowerCase())
  )
    return null;
  const fee = await estimateOriginFees(rpc, 84532, block, sender, [
    { to: sender, data, gas: BigInt(outer.gasUsed) },
  ]);
  return { delegate, feeWei: fee.totalWei, transaction };
}
