import { EvmAddress } from "@swapchan/shared";
import { decodeFunctionData, encodeFunctionData, erc20Abi, type Hex, pad, parseAbi } from "viem";
import { z } from "zod";
import { getJson } from "./providers/types.js";

const sourceToken = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const destinationToken = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const pool = "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64";
const deposit = parseAbi([
  "function deposit(bytes32 depositor,bytes32 recipient,bytes32 inputToken,bytes32 outputToken,uint256 inputAmount,uint256 outputAmount,uint256 destinationChainId,bytes32 exclusiveRelayer,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,bytes message)",
]);
const units = z.string().regex(/^[1-9][0-9]{0,37}$/);
export const crossPaymentInput = z
  .object({
    sourceChainId: z.literal(8453),
    chainId: z.literal(10),
    sender: EvmAddress,
    recipient: EvmAddress,
    amountMicroUsdc: units,
  })
  .strict()
  .refine((x) => !/^0x0{40}$/i.test(x.recipient) && !/^0x0{40}$/i.test(x.sender));
const response = z.object({
  amountType: z.literal("exactOutput"),
  crossSwapType: z.literal("bridgeableToBridgeable"),
  expectedOutputAmount: units,
  minOutputAmount: units,
  inputAmount: units,
  maxInputAmount: units,
  quoteExpiryTimestamp: z.number().int(),
  expectedFillTime: z.number().nonnegative(),
  swapTx: z.object({
    chainId: z.literal(8453),
    to: EvmAddress,
    data: z.string().regex(/^0x(?:[0-9a-f]{2})+$/i),
    value: z.string().optional(),
  }),
});
export async function quoteCrossPayment(
  f: typeof fetch,
  intent: z.infer<typeof crossPaymentInput>,
  sourceRpc: (method: string, params: unknown[]) => Promise<unknown>,
) {
  const params = new URLSearchParams({
    tradeType: "exactOutput",
    amount: intent.amountMicroUsdc,
    inputToken: sourceToken,
    outputToken: destinationToken,
    originChainId: String(intent.sourceChainId),
    destinationChainId: String(intent.chainId),
    depositor: intent.sender,
    recipient: intent.recipient,
    integratorId: "0x0000",
  });
  const q = response.parse(
    await getJson(f, "https://app.across.to/api/swap/approval?" + params, {
      signal: AbortSignal.timeout(10000),
    }),
  );
  const { args } = decodeFunctionData({ abi: deposit, data: q.swapTx.data as Hex });
  const [sender, recipient, tokenIn, tokenOut, amountIn, amountOut, destination, , , , , message] =
    args;
  const canonical = encodeFunctionData({
    abi: deposit,
    functionName: "deposit",
    args,
  }).toLowerCase();
  const data = q.swapTx.data.toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  if (
    (data !== canonical && data !== canonical + "1dc0de000073c0de") ||
    q.swapTx.to.toLowerCase() !== pool.toLowerCase() ||
    BigInt(q.swapTx.value ?? 0) !== 0n ||
    sender.toLowerCase() !== pad(intent.sender).toLowerCase() ||
    recipient.toLowerCase() !== pad(intent.recipient).toLowerCase() ||
    tokenIn.toLowerCase() !== pad(sourceToken).toLowerCase() ||
    tokenOut.toLowerCase() !== pad(destinationToken).toLowerCase() ||
    destination !== BigInt(intent.chainId) ||
    message !== "0x" ||
    amountOut !== BigInt(intent.amountMicroUsdc) ||
    q.expectedOutputAmount !== intent.amountMicroUsdc ||
    q.minOutputAmount !== intent.amountMicroUsdc ||
    amountIn !== BigInt(q.inputAmount) ||
    amountIn > BigInt(q.maxInputAmount) ||
    args[9] <= now ||
    q.quoteExpiryTimestamp <= now
  )
    throw Error("Cross-chain deposit differs from payment intent or has expired");
  const quantity = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]*)$/i);
  const block = quantity.parse(await sourceRpc("eth_blockNumber", []));
  const readUsdc = async (data: Hex) =>
    BigInt(
      z
        .string()
        .regex(/^0x[0-9a-f]{64}$/i)
        .parse(await sourceRpc("eth_call", [{ to: sourceToken, data }, block])),
    );
  const [balance, allowance, native] = await Promise.all([
    readUsdc(
      encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [intent.sender] }),
    ),
    readUsdc(
      encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [intent.sender, pool] }),
    ),
    sourceRpc("eth_getBalance", [intent.sender, block]).then((v) => BigInt(quantity.parse(v))),
  ]);
  if (Math.min(q.quoteExpiryTimestamp, args[9]) <= Date.now() / 1000)
    throw Error("Expired cross-chain payment quote");
  return {
    ...intent,
    provider: "across",
    execution: "quote_only",
    atomic: false,
    inputToken: sourceToken,
    outputToken: destinationToken,
    inputMicroUsdc: q.inputAmount,
    maxInputMicroUsdc: q.maxInputAmount,
    sourceWallet: {
      blockNumber: block,
      balanceMicroUsdc: balance.toString(),
      nativeBalanceWei: native.toString(),
      depositShortfallMicroUsdc: (balance < amountIn ? amountIn - balance : 0n).toString(),
      spender: pool,
      allowanceMicroUsdc: allowance.toString(),
      requiredApprovalMicroUsdc: allowance < amountIn ? amountIn.toString() : "0",
    },
    originGas: { token: "ETH", includedInMaxInput: false },
    expectedFillSeconds: q.expectedFillTime,
    expiresAt: Math.min(q.quoteExpiryTimestamp, args[9]),
    settlement: "Requires a separate destination fill and confirmation.",
  };
}
