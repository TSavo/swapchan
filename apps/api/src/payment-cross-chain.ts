import {
  acrossRoute,
  batchAbi,
  checkAcrossDeposit,
  EvmAddress,
  paymentContracts,
} from "@swapchan/shared";
import { encodeFunctionData, erc20Abi, type Hex, keccak256 } from "viem";
import { z } from "zod";
import { simulateAtomicOrigin } from "./payment-atomic-origin.js";
import { estimateOriginFees } from "./payment-origin-fees.js";
import { getJson } from "./providers/types.js";

export { acrossBaseRoute } from "@swapchan/shared";

const units = z.string().regex(/^[1-9][0-9]{0,37}$/);
export const crossPaymentInput = z
  .object({
    sourceChainId: z.union([z.literal(8453), z.literal(84532)]),
    chainId: z.union([z.literal(10), z.literal(11155420)]),
    sender: EvmAddress,
    recipient: EvmAddress,
    amountMicroUsdc: units,
  })
  .strict()
  .refine(
    (x) =>
      acrossRoute(x.chainId).origin === x.sourceChainId &&
      !/^0x0{40}$/i.test(x.recipient) &&
      !/^0x0{40}$/i.test(x.sender),
  );
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
    chainId: z.number().int(),
    to: EvmAddress,
    data: z.string().regex(/^0x(?:[0-9a-f]{2})+$/i),
    value: z.string().optional(),
  }),
});
export async function quoteCrossPayment(
  f: typeof fetch,
  intent: z.infer<typeof crossPaymentInput>,
  sourceRpc: (method: string, params: unknown[]) => Promise<unknown>,
  reviewed?: z.infer<typeof response>,
) {
  const route = acrossRoute(intent.chainId);
  const { sourceToken, destinationToken, pool } = route;
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
    reviewed ??
      (await getJson(f, route.api + "/swap/approval?" + params, {
        signal: AbortSignal.timeout(10000),
      })),
  );
  if (q.swapTx.chainId !== route.origin) throw Error("Wrong origin chain");
  const { amountIn, fillDeadline } = checkAcrossDeposit(
    { ...q.swapTx, data: q.swapTx.data as Hex },
    { ...intent, maxInputMicroUsdc: q.maxInputAmount, expiresAt: q.quoteExpiryTimestamp },
  );
  if (
    q.expectedOutputAmount !== intent.amountMicroUsdc ||
    q.minOutputAmount !== intent.amountMicroUsdc ||
    amountIn !== BigInt(q.inputAmount)
  )
    throw Error("Across amounts differ from the deposit");
  const quantity = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]*)$/i);
  const block = quantity.parse(await sourceRpc("eth_blockNumber", []));
  const readUsdc = async (data: Hex) =>
    BigInt(
      z
        .string()
        .regex(/^0x[0-9a-f]{64}$/i)
        .parse(await sourceRpc("eth_call", [{ to: sourceToken, data }, block])),
    );
  const limitParams = new URLSearchParams({
    inputToken: sourceToken,
    outputToken: destinationToken,
    originChainId: String(route.origin),
    destinationChainId: String(route.destination),
    amount: String(amountIn),
  });
  const limitUnits = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
  const [balance, allowance, native, depositLimits] = await Promise.all([
    readUsdc(
      encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [intent.sender] }),
    ),
    readUsdc(
      encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [intent.sender, pool] }),
    ),
    sourceRpc("eth_getBalance", [intent.sender, block]).then((v) => BigInt(quantity.parse(v))),
    getJson(f, route.api + "/limits?" + limitParams, { signal: AbortSignal.timeout(10000) })
      .then((value) => z.object({ minDeposit: limitUnits, maxDeposit: limitUnits }).parse(value))
      .catch(() => null),
  ]);
  const depositLimitIssue = !depositLimits
    ? "limits_unavailable"
    : amountIn < BigInt(depositLimits.minDeposit)
      ? "below_minimum"
      : amountIn > BigInt(depositLimits.maxDeposit)
        ? "above_maximum"
        : null;
  let originSimulation: { status: string; gasUsed?: string[] };
  let feeEstimate: Awaited<ReturnType<typeof estimateOriginFees>> | null = null;
  const calls: { from: Hex; to: Hex; data: Hex }[] = [];
  if (depositLimitIssue) originSimulation = { status: "not_run" };
  else if (balance < amountIn) originSimulation = { status: "insufficient_usdc" };
  else {
    if (allowance < amountIn)
      calls.push({
        from: intent.sender,
        to: sourceToken,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [pool, amountIn],
        }),
      });
    calls.push({ from: intent.sender, to: pool, data: q.swapTx.data as Hex });
    try {
      const simulation = z
        .array(
          z.object({
            calls: z.array(
              z.object({
                status: quantity,
                gasUsed: quantity,
                returnData: z.string(),
              }),
            ),
          }),
        )
        .length(1)
        .parse(
          await sourceRpc("eth_simulateV1", [
            {
              blockStateCalls: [{ calls }],
              validation: false,
            },
            block,
          ]),
        );
      const results = simulation[0]!.calls;
      if (results.length !== calls.length) throw Error("Incomplete origin simulation");
      const success =
        results.every((r) => r.status === "0x1" && BigInt(r.gasUsed) > 0n) &&
        (allowance >= amountIn || /^0x0{63}1$/i.test(results[0]!.returnData));
      originSimulation = {
        status: success ? "succeeded" : "reverted",
        gasUsed: results.map((r) => BigInt(r.gasUsed).toString()),
      };
      if (success)
        feeEstimate = await estimateOriginFees(
          sourceRpc,
          route.origin,
          block,
          intent.sender,
          calls.map((call, index) => ({ ...call, gas: BigInt(results[index]!.gasUsed) })),
        ).catch(() => null);
    } catch {
      originSimulation = { status: "unavailable" };
    }
  }
  const atomic =
    route.origin === 84532 && calls.length === 2 && originSimulation.status === "succeeded"
      ? await simulateAtomicOrigin(sourceRpc, block, intent.sender, calls).catch(() => null)
      : null;
  const atomicEstimateWei = atomic?.feeWei ?? null;
  const funded = atomic && BigInt(atomic.feeWei) <= native ? atomic : null;
  const atomicTx = funded?.transaction ?? null;
  const atomicOrigin = funded
    ? { delegate: funded.delegate, estimatedFeeWei: funded.feeWei }
    : null;
  if (Math.min(q.quoteExpiryTimestamp, fillDeadline) <= Date.now() / 1000)
    throw Error("Expired cross-chain payment quote");
  const quote = {
    ...intent,
    provider: "across",
    depositLimits,
    depositLimitIssue,
    execution:
      feeEstimate && native >= BigInt(feeEstimate.totalWei)
        ? "unsigned_origin_steps"
        : atomicOrigin && feeEstimate
          ? "unsigned_atomic_origin"
          : "quote_only",
    atomic: false,
    atomicOrigin,
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
    originGas: {
      token: "ETH",
      includedInMaxInput: false,
      estimate: feeEstimate,
      atomicEstimateWei,
      estimatedShortfallWei: feeEstimate
        ? (BigInt(feeEstimate.totalWei) > native
            ? BigInt(feeEstimate.totalWei) - native
            : 0n
          ).toString()
        : null,
    },
    originSimulation,
    expectedFillSeconds: q.expectedFillTime,
    fillDeadline,
    recovery:
      route.origin === 84532
        ? "Across does not automatically refund unfilled testnet deposits."
        : "If the fill expires, track the origin-chain refund separately.",
    expiresAt: Math.min(q.quoteExpiryTimestamp, fillDeadline),
    settlement: "Requires a separate destination fill and confirmation.",
  };
  return { quote, calls, atomicTx, providerQuote: q };
}
