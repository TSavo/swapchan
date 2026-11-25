import {
  acrossTestRoute,
  circleBurnAbi as burn,
  circleMessenger as messenger,
} from "@swapchan/shared";
import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  keccak256,
  pad,
  zeroHash,
} from "viem";
import { z } from "zod";
import { estimateOriginFees } from "./payment-origin-fees.js";
import { getJson } from "./providers/types.js";

const usdc = acrossTestRoute.sourceToken;
const uint = z.string().regex(/^\d+$/);
const hex = z.string().regex(/^0x[0-9a-f]+$/i);
const quoteSchema = z.object({
  feeToken: z.string(),
  feeTotalAmount: uint,
  signedQuote: z.string().regex(/^0x(?:[a-f0-9]{2})+$/i),
  expiry: z.object({ mode: z.literal("TIMESTAMP"), expiresAt: z.number().int() }),
  items: z.tuple([z.object({ type: z.literal("FORWARD"), amount: uint })]),
});

export async function quoteCirclePayment(
  f: typeof fetch,
  rpc: (method: string, params: unknown[]) => Promise<unknown>,
  intent: {
    chainId: 11155420;
    sourceChainId: 84532;
    sender: Address;
    recipient: Address;
    amountMicroUsdc: string;
  },
  retained?: z.infer<typeof quoteSchema>,
) {
  const amount = BigInt(intent.amountMicroUsdc);
  const [raw, block] = await Promise.all([
    retained ??
      getJson(f, "https://iris-api-sandbox.circle.com/v2/quote/burn/usdc/6/2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          amount: intent.amountMicroUsdc,
          feeToken: usdc,
          requests: [{ type: "FORWARD" }],
        }),
      }),
    rpc("eth_blockNumber", []).then((v) => hex.parse(v)),
  ]);
  const quote = quoteSchema.parse(raw);
  if (
    quote.feeToken.toLowerCase() !== usdc.toLowerCase() ||
    quote.items[0].amount !== quote.feeTotalAmount ||
    quote.expiry.expiresAt <= Date.now() / 1000
  )
    throw Error("Invalid Circle forwarding quote");
  const cost = amount + BigInt(quote.feeTotalAmount);
  const read = async (data: Hex) =>
    BigInt(hex.parse(await rpc("eth_call", [{ to: usdc, data }, block])));
  const [balance, allowance, native] = await Promise.all([
    read(encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [intent.sender] })),
    read(
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "allowance",
        args: [intent.sender, messenger],
      }),
    ),
    rpc("eth_getBalance", [intent.sender, block]).then((v) => BigInt(hex.parse(v))),
  ]);
  const calls: { from: Address; to: Address; data: Hex }[] = [];
  if (allowance < cost)
    calls.push({
      from: intent.sender,
      to: usdc,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [messenger, cost] }),
    });
  calls.push({
    from: intent.sender,
    to: messenger,
    data: encodeFunctionData({
      abi: burn,
      functionName: "depositForBurnWithFees",
      args: [
        amount,
        2,
        pad(intent.recipient),
        usdc,
        zeroHash,
        { signedQuote: quote.signedQuote as Hex, refundAddress: intent.sender },
      ],
    }),
  });
  let status = "insufficient_usdc";
  let estimate = null;
  if (balance >= cost) {
    const [simulation] = z
      .tuple([
        z.object({
          calls: z.array(z.object({ status: hex, gasUsed: hex, returnData: z.string() })),
        }),
      ])
      .parse(
        await rpc("eth_simulateV1", [
          {
            blockStateCalls: [
              {
                calls: [
                  ...calls,
                  {
                    from: intent.sender,
                    to: usdc,
                    data: encodeFunctionData({
                      abi: erc20Abi,
                      functionName: "balanceOf",
                      args: [intent.sender],
                    }),
                  },
                ],
              },
            ],
            validation: false,
          },
          block,
        ]),
      );
    const ok =
      simulation.calls.length === calls.length + 1 &&
      simulation.calls.every((r) => r.status === "0x1" && BigInt(r.gasUsed) > 0n) &&
      BigInt(simulation.calls[calls.length]!.returnData) === balance - cost &&
      (allowance >= cost || /^0x0{63}1$/i.test(simulation.calls[0]!.returnData));
    status = ok ? "succeeded" : "reverted";
    if (ok)
      estimate = await estimateOriginFees(
        rpc,
        84532,
        block,
        intent.sender,
        calls.map((c, i) => ({ ...c, gas: BigInt(simulation.calls[i]!.gasUsed) })),
      );
  }
  if (quote.expiry.expiresAt <= Date.now() / 1000) throw Error("Circle quote expired");
  const review = {
    ...intent,
    provider: "circle_cctp",
    execution:
      status === "succeeded" && estimate && native >= BigInt(estimate.totalWei)
        ? "unsigned_origin_steps"
        : "quote_only",
    burnTarget: messenger,
    burnDataHash: keccak256(calls[calls.length - 1]!.data),
    atomic: false,
    expiresAt: quote.expiry.expiresAt,
    maxInputMicroUsdc: String(cost),
    inputMicroUsdc: String(cost),
    forwardFeeMicroUsdc: quote.feeTotalAmount,
    sourceWallet: {
      blockNumber: block,
      balanceMicroUsdc: String(balance),
      nativeBalanceWei: String(native),
      requiredApprovalMicroUsdc: allowance < cost ? String(cost) : "0",
    },
    originSimulation: { status },
    originGas: { token: "ETH", estimate },
    destinationGasPaidBy: "circle_forwarder",
  };
  return { review, signedTerms: quote, calls, intent };
}
