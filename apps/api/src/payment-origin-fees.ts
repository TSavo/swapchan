import { type Address, encodeFunctionData, type Hex, parseAbi, serializeTransaction } from "viem";
import { z } from "zod";

const oracle = "0x420000000000000000000000000000000000000F";
const abi = parseAbi([
  "function getL1Fee(bytes transaction) view returns(uint256)",
  "function getOperatorFee(uint256 gasUsed) view returns(uint256)",
]);
const quantity = z
  .string()
  .regex(/^0x(?:0|[1-9a-f][0-9a-f]*)$/i)
  .transform(BigInt);
const uint256 = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/i)
  .transform(BigInt);

/** Estimate Base origin charges for the exact sequence that successfully simulated. */
export async function estimateOriginFees(
  rpc: (method: string, params: unknown[]) => Promise<unknown>,
  chainId: 8453 | 84532,
  block: string,
  sender: Address,
  calls: { to: Address; data: Hex; gas: bigint }[],
) {
  const [gasPrice, nonce, tip] = await Promise.all([
    rpc("eth_gasPrice", []).then((v) => quantity.parse(v)),
    rpc("eth_getTransactionCount", [sender, block]).then((v) => quantity.parse(v)),
    rpc("eth_maxPriorityFeePerGas", []).then((v) => quantity.parse(v)),
  ]);
  if (
    gasPrice === 0n ||
    tip > gasPrice ||
    nonce + BigInt(calls.length) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw Error("Invalid Base gas pricing");
  const read = async (data: Hex) =>
    uint256.parse(await rpc("eth_call", [{ to: oracle, data }, block]));
  const fees = await Promise.all(
    calls.map(async (call, i) => {
      const tx = serializeTransaction({
        type: "eip1559",
        chainId,
        to: call.to,
        data: call.data,
        gas: call.gas,
        nonce: Number(nonce) + i,
        maxFeePerGas: gasPrice,
        maxPriorityFeePerGas: tip,
      });
      const [data, operator] = await Promise.all([
        read(encodeFunctionData({ abi, functionName: "getL1Fee", args: [tx] })),
        read(encodeFunctionData({ abi, functionName: "getOperatorFee", args: [call.gas] })),
      ]);
      return { execution: gasPrice * call.gas, data, operator };
    }),
  );
  const execution = fees.reduce((a, v) => a + v.execution, 0n),
    data = fees.reduce((a, v) => a + v.data, 0n),
    operator = fees.reduce((a, v) => a + v.operator, 0n);
  return {
    executionWei: execution.toString(),
    perTransactionWei: fees.map((fee) => (fee.execution + fee.data + fee.operator).toString()),
    l1DataWei: data.toString(),
    operatorWei: operator.toString(),
    totalWei: (execution + data + operator).toString(),
  };
}
