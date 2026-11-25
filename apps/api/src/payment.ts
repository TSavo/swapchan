import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  acrossRoute,
  batchAbi,
  checkCircleBurn,
  circleMessenger,
  EvmAddress,
  type PaymentQuote,
  paymentBatch,
  paymentContracts,
  paymentGasLimits,
  paymentSignatureRequest,
} from "@swapchan/shared";
import { Hono } from "hono";
import {
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  hashTypedData,
  parseAbi,
  recoverAddress,
} from "viem";
import { getUserOperationTypedData } from "viem/account-abstraction";
import { recoverAuthorizationAddress } from "viem/utils";
import { z } from "zod";
import { quoteCirclePayment } from "./payment-circle.js";
import { circleStatus, circleStatusInput } from "./payment-circle-status.js";
import { comparePaymentCosts, recommendedPaymentStage } from "./payment-costs.js";
import { crossPaymentInput, quoteCrossPayment } from "./payment-cross-chain.js";
import { crossSettlement, settlementInput } from "./payment-cross-settlement.js";
import { inspectDelegation } from "./payment-delegation.js";
import {
  destinationIntent,
  directReceipt,
  directReceiptInput,
  quoteDirect,
} from "./payment-direct.js";
import {
  chainReceipt,
  operationReceipt,
  paymentBlockBalances,
  reconcilePayment,
} from "./payment-receipt.js";
import { openPaymentStore } from "./payment-store.js";

const { weth, usdc, paymaster, entry, delegate } = paymentContracts;
const quoter = "0xC5290058841028F1614F3A6F0F5816cAd0df5E27";
const abi = parseAbi([
  "function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const input = z
  .object({
    chainId: z.literal(84532),
    sourceChainId: z.literal(84532).optional(),
    sender: EvmAddress,
    recipient: EvmAddress,
    amountMicroUsdc: z.string().regex(/^[1-9][0-9]{0,37}$/),
  })
  .strict()
  .refine(
    (v) => v.sender.toLowerCase() !== v.recipient.toLowerCase() && !/^0x0{40}$/i.test(v.recipient),
    "invalid recipient",
  );
const hex = z.string().regex(/^0x[0-9a-f]+$/i);
function jsonSigningRequest(typed: ReturnType<typeof paymentSignatureRequest>) {
  const message = Object.fromEntries(
    typed.types.PackedUserOperation.map(({ name }) => [name, String(typed.message[name])]),
  );
  return { ...typed, message };
}
export function paymentRoutes(
  f: typeof fetch,
  receipts = openPaymentStore(),
  testnetEnabled = false,
) {
  const issued = receipts.cache<PaymentQuote & { execution?: "quote_only" | "sponsored_payment" }>(
    "same-chain",
    (q) => q.expiresAt,
  );
  type CrossQuote = Awaited<ReturnType<typeof quoteCrossPayment>>["quote"];
  const crossQuotes = receipts.cache<{
    intent: z.infer<typeof crossPaymentInput>;
    review: CrossQuote;
    providerQuote?: Awaited<ReturnType<typeof quoteCrossPayment>>["providerQuote"];
  }>("across", (v) => v.review.expiresAt);
  type RpcOp = Record<string, string | Record<string, string>>;
  const builds = receipts.cache<{ op: RpcOp; digest: Hex; quote: PaymentQuote }>(
    "bundle",
    (v) => v.quote.expiresAt,
  );
  async function rpc(url: string, method: string, params: unknown[]) {
    const response = await f(url, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!response.ok) throw new Error("unavailable payment RPC");
    const message = z
      .object({ result: z.unknown(), error: z.unknown().optional() })
      .parse(await response.json());
    if (message.error || !("result" in message)) throw new Error("failed payment RPC");
    return message.result as unknown;
  }
  const chain = (m: string, p: unknown[]) => rpc("https://sepolia.base.org", m, p);
  const pm = (m: string, p: unknown[]) => rpc("https://public.pimlico.io/v2/84532/rpc", m, p);
  async function quoteGasInUsdc() {
    const [pricing, tokenPricing] = await Promise.all([
      pm("pimlico_getUserOperationGasPrice", []),
      pm("pimlico_getTokenQuotes", [{ tokens: [usdc] }, entry, "0x14a34"]),
    ]);
    const fees = z
      .object({ standard: z.object({ maxFeePerGas: hex, maxPriorityFeePerGas: hex }) })
      .parse(pricing).standard;
    const quotes = z
      .object({
        quotes: z.array(z.object({ token: EvmAddress, paymaster: EvmAddress, exchangeRate: hex })),
      })
      .parse(tokenPricing).quotes;
    const quote = quotes.find(
      (t) =>
        t.token.toLowerCase() === usdc.toLowerCase() &&
        t.paymaster.toLowerCase() === paymaster.toLowerCase(),
    );
    if (!quote || !BigInt(quote.exchangeRate) || !BigInt(fees.maxFeePerGas))
      throw new Error("missing gas quote");
    const gasCap = (gas: bigint) =>
      (gas * BigInt(fees.maxFeePerGas) * BigInt(quote.exchangeRate) * 12n + 10n ** 19n - 1n) /
        10n ** 19n +
      100n;
    return {
      chainId: 84532,
      token: usdc,
      symbol: "USDC",
      decimals: 6,
      paymaster,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      maxGasMicroUsdc: {
        delegatedUsdc: gasCap(425000n).toString(),
        swapOrSetup: gasCap(955000n).toString(),
      },
      ...fees,
    };
  }
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (
      !testnetEnabled &&
      c.req.method === "POST" &&
      ["/build", "/verify", "/submit", "/cross-chain/build"].some((path) =>
        c.req.path.endsWith(path),
      )
    )
      return c.json({ error: "testnet_payments_disabled" }, 403);
    await next();
  });
  const bridgeRpc = {
    8453: "https://mainnet.base.org",
    10: "https://mainnet.optimism.io",
    84532: "https://sepolia.base.org",
    11155420: "https://sepolia.optimism.io",
  } as const;
  const inspectCrossPayment = (
    intent: z.infer<typeof crossPaymentInput>,
    reviewed?: Parameters<typeof quoteCrossPayment>[3],
  ) => quoteCrossPayment(f, intent, (m, p) => rpc(bridgeRpc[intent.sourceChainId], m, p), reviewed);
  const inspectDirect = (i: z.infer<typeof destinationIntent>) =>
    quoteDirect(i, (m, p) => rpc(bridgeRpc[i.chainId], m, p));
  const directQuotes = receipts.cache<{
    intent: z.infer<typeof destinationIntent>;
    review: Awaited<ReturnType<typeof quoteDirect>>["quote"];
  }>("direct", (v) => v.review.expiresAt);
  const circleQuotes = receipts.cache<Awaited<ReturnType<typeof quoteCirclePayment>>>(
    "circle-cctp-build",
    (quote) => quote.review.expiresAt,
  );
  function retain<T>(cache: { set(id: string, entry: T): void }, entry: T) {
    const id = randomUUID();
    cache.set(id, entry);
    return id;
  }
  async function issueCross(i: z.infer<typeof crossPaymentInput>) {
    const { quote, providerQuote } = await inspectCrossPayment(i);
    if (i.chainId === 10 || !testnetEnabled) quote.execution = "quote_only";
    quote.expiresAt = Math.min(quote.expiresAt, Math.floor(Date.now() / 1000) + 120);
    return { ...quote, quoteId: retain(crossQuotes, { intent: i, review: quote, providerQuote }) };
  }
  async function issueDirect(i: z.infer<typeof destinationIntent>) {
    const { quote } = await inspectDirect(i);
    if (i.chainId === 10 || !testnetEnabled) quote.execution = "quote_only";
    return { ...quote, quoteId: retain(directQuotes, { intent: i, review: quote }) };
  }
  async function testnetGasConversion() {
    const data = encodeFunctionData({
      abi,
      functionName: "quoteExactOutputSingle",
      args: [{ tokenIn: weth, tokenOut: usdc, amount: 1000000n, fee: 3000, sqrtPriceLimitX96: 0n }],
    });
    const [wei] = decodeFunctionResult({
      abi,
      functionName: "quoteExactOutputSingle",
      data: hex.parse(await chain("eth_call", [{ to: quoter, data }, "latest"])) as Hex,
    });
    return wei > 0n ? 10n ** 24n / wei : null;
  }
  app.post("/direct/status", async (c) => {
    const p = directReceiptInput.safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: "invalid_direct_payment" }, 400);
    try {
      return c.json(
        await directReceipt(p.data, (m, params) => rpc(bridgeRpc[p.data.chainId], m, params)),
      );
    } catch {
      return c.json({ error: "receipt_unverified" }, 502);
    }
  });
  app.post("/cross-chain/build", async (c) => {
    const body = z
      .object({
        quoteId: z.uuid(),
        stage: z.enum(["initial", "after_approval", "atomic_origin"]).optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_build_request" }, 400);
    const circle = circleQuotes.get(body.data.quoteId);
    if (circle) {
      const previous = circle.review;
      const stage = body.data.stage ?? recommendedPaymentStage(previous);
      const atomic = stage === "atomic_origin";
      if (
        previous.execution === "quote_only" ||
        !previous.originGas.estimate ||
        (!atomic && previous.execution === "unsigned_atomic_origin")
      )
        return c.json({ error: "funded_quote_required" }, 422);
      try {
        const { review, calls, atomicTx } = await quoteCirclePayment(
          f,
          chain,
          circle.intent,
          circle.signedTerms,
        );
        const approval = calls.length === 2;
        const caps = previous.originGas.estimate.perTransactionWei.slice(-calls.length);
        if (
          review.execution === "quote_only" ||
          !review.originGas.estimate ||
          caps.length !== calls.length ||
          (!atomic &&
            (review.execution === "unsigned_atomic_origin" ||
              review.originGas.estimate.perTransactionWei.some(
                (v, i) => BigInt(v) > BigInt(caps[i]!),
              ))) ||
          review.burnDataHash !== previous.burnDataHash ||
          review.maxInputMicroUsdc !== previous.maxInputMicroUsdc ||
          (approval &&
            (previous.sourceWallet.requiredApprovalMicroUsdc === "0" ||
              body.data.stage === "after_approval"))
        )
          return c.json({ error: "payment_terms_changed" }, 409);
        if (atomic) {
          if (
            !approval ||
            !previous.atomicOrigin ||
            !review.atomicOrigin ||
            !atomicTx ||
            BigInt(review.atomicOrigin.estimatedFeeWei) >
              BigInt(previous.atomicOrigin.estimatedFeeWei)
          )
            return c.json({ error: "atomic_origin_unavailable" }, 422);
          return c.json({
            quoteId: body.data.quoteId,
            action: "atomic_origin",
            unsignedTransaction: { ...atomicTx, chainId: 84532, value: "0x0" },
            expiresAt: review.expiresAt,
            originSimulation: { status: "succeeded" },
            estimatedOriginFeeWei: review.atomicOrigin.estimatedFeeWei,
          });
        }
        return c.json({
          quoteId: body.data.quoteId,
          action: approval ? "approve" : "burn",
          unsignedTransaction: { ...calls[0], chainId: 84532, value: "0x0" },
          expiresAt: review.expiresAt,
          originSimulation: review.originSimulation,
          estimatedOriginFeeWei: review.originGas.estimate.totalWei,
        });
      } catch {
        return c.json({ error: "circle_build_unavailable" }, 503);
      }
    }
    const local = directQuotes.get(body.data.quoteId);
    if (local) {
      if (local.intent.chainId === 10)
        return c.json({ error: "mainnet_payment_build_disabled" }, 403);
      if (local.review.expiresAt <= Date.now() / 1000)
        return c.json({ error: "quote_expired" }, 410);
      if (
        (body.data.stage ?? "initial") !== "initial" ||
        local.review.execution !== "unsigned_origin_steps" ||
        !local.review.originGas.estimate
      )
        return c.json({ error: "funded_quote_required" }, 422);
      try {
        const { quote, tx } = await inspectDirect(local.intent);
        if (
          quote.execution !== "unsigned_origin_steps" ||
          !quote.originGas.estimate ||
          BigInt(quote.originGas.estimate.totalWei) >
            BigInt(local.review.originGas.estimate.totalWei) ||
          local.review.expiresAt <= Date.now() / 1000
        )
          return c.json({ error: "payment_terms_changed" }, 409);
        return c.json({
          quoteId: body.data.quoteId,
          action: "transfer",
          unsignedTransaction: tx,
          originSimulation: quote.originSimulation,
          estimatedOriginFeeWei: quote.originGas.estimate.totalWei,
          expiresAt: local.review.expiresAt,
        });
      } catch {
        return c.json({ error: "direct_build_unavailable" }, 503);
      }
    }
    const saved = crossQuotes.get(body.data.quoteId);
    if (!saved || saved.review.expiresAt <= Date.now() / 1000)
      return c.json({ error: "quote_expired" }, 410);
    if (saved.intent.chainId === 10)
      return c.json({ error: "mainnet_payment_build_disabled" }, 403);
    const stage = body.data.stage ?? recommendedPaymentStage(saved.review);
    const atomic = stage === "atomic_origin";
    const reviewedGas = saved.review.originGas.estimate;
    if (saved.review.depositLimitIssue)
      return c.json(
        { error: saved.review.depositLimitIssue, depositLimits: saved.review.depositLimits },
        422,
      );
    if (
      !reviewedGas ||
      (!atomic && saved.review.originGas.estimatedShortfallWei !== "0") ||
      saved.review.execution === "quote_only"
    )
      return c.json({ error: "funded_quote_required" }, 422);
    try {
      if (!saved.providerQuote) return c.json({ error: "fresh_review_required" }, 409);
      const { quote, calls, atomicTx } = await inspectCrossPayment(
        saved.intent,
        saved.providerQuote,
      );
      if (saved.review.expiresAt <= Date.now() / 1000)
        return c.json({ error: "quote_expired" }, 410);
      if (quote.depositLimitIssue)
        return c.json({ error: quote.depositLimitIssue, depositLimits: quote.depositLimits }, 422);
      if (
        quote.originSimulation.status !== "succeeded" ||
        !quote.originGas.estimate ||
        (!atomic && quote.originGas.estimatedShortfallWei !== "0") ||
        !calls.length
      )
        return c.json({ error: "origin_preflight_failed" }, 422);
      if (
        BigInt(quote.maxInputMicroUsdc) > BigInt(saved.review.maxInputMicroUsdc) ||
        (!atomic && BigInt(quote.originGas.estimate.totalWei) > BigInt(reviewedGas.totalWei))
      )
        return c.json({ error: "payment_terms_changed" }, 409);
      const approval = calls.length === 2;
      const reviewedSteps = reviewedGas.perTransactionWei.slice(-calls.length);
      if (
        !atomic &&
        (reviewedSteps.length !== calls.length ||
          quote.originGas.estimate.perTransactionWei.some(
            (cost, i) => BigInt(cost) > BigInt(reviewedSteps[i]!),
          ))
      )
        return c.json({ error: "origin_fee_estimate_changed" }, 409);
      if (
        approval &&
        (body.data.stage === "after_approval" ||
          saved.review.sourceWallet.requiredApprovalMicroUsdc === "0" ||
          BigInt(quote.sourceWallet.requiredApprovalMicroUsdc) >
            BigInt(saved.review.sourceWallet.requiredApprovalMicroUsdc))
      )
        return c.json({ error: "approval_changed" }, 409);
      if (atomic) {
        const previous = saved.review.atomicOrigin;
        if (
          !previous ||
          !approval ||
          !atomicTx ||
          !quote.atomicOrigin ||
          BigInt(quote.atomicOrigin.estimatedFeeWei) > BigInt(previous.estimatedFeeWei) ||
          saved.review.expiresAt <= Date.now() / 1000
        )
          return c.json({ error: "atomic_origin_unavailable" }, 422);
        return c.json({
          quoteId: body.data.quoteId,
          action: "atomic_origin",
          unsignedTransaction: { ...atomicTx, chainId: 84532, value: "0x0" },
          originSimulation: { status: "succeeded" },
          estimatedOriginFeeWei: quote.atomicOrigin.estimatedFeeWei,
          expiresAt: Math.min(quote.expiresAt, saved.review.expiresAt),
        });
      }
      return c.json({
        quoteId: body.data.quoteId,
        action: approval ? "approve" : "deposit",
        unsignedTransaction: { ...calls[0], chainId: saved.intent.sourceChainId, value: "0x0" },
        expiresAt: Math.min(quote.expiresAt, saved.review.expiresAt),
        originSimulation: quote.originSimulation,
        estimatedOriginFeeWei: quote.originGas.estimate.totalWei,
      });
    } catch {
      return c.json({ error: "cross_chain_build_unavailable" }, 503);
    }
  });
  app.post("/cross-chain/status", async (c) => {
    const parsed = settlementInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_settlement_request" }, 400);
    try {
      return c.json(await crossSettlement((id, m, p) => rpc(bridgeRpc[id], m, p), parsed.data, f));
    } catch {
      return c.json({ error: "settlement_unverified" }, 502);
    }
  });
  app.post("/circle/status", async (c) => {
    const i = circleStatusInput.safeParse(await c.req.json().catch(() => null));
    if (!i.success) return c.json({ error: "invalid_circle_status" }, 400);
    try {
      return c.json(await circleStatus(i.data, (id, m, p) => rpc(bridgeRpc[id], m, p), f));
    } catch {
      return c.json({ error: "circle_settlement_unverified" }, 502);
    }
  });
  app.post("/gas-quote", async (c) => {
    const body = z
      .object({ chainId: z.literal(84532) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_gas_quote_request" }, 400);
    try {
      return c.json(await quoteGasInUsdc());
    } catch {
      return c.json({ error: "gas_quote_unavailable" }, 503);
    }
  });
  app.post("/delegation", async (c) => {
    const body = z
      .object({
        chainId: z.literal(84532),
        sender: EvmAddress,
        proposedDelegate: EvmAddress.optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_delegation_request" }, 400);
    try {
      return c.json(await inspectDelegation(chain, body.data.sender, body.data.proposedDelegate));
    } catch {
      return c.json({ error: "delegation_check_unavailable" }, 503);
    }
  });
  const comparisons = receipts.cache<{ expiresAt: number; data: Record<string, unknown> }>(
    "comparison",
    (value) => value.expiresAt,
  );
  app.get("/review/:id", (c) => {
    const id = c.req.param("id");
    if (!testnetEnabled || !z.uuid().safeParse(id).success)
      return c.json({ error: "review_unavailable" }, 404);
    c.header("Cache-Control", "no-store");
    const q = issued.get(id);
    if (q) return c.json({ ...q, quoteId: id });
    const route = directQuotes.get(id) ?? crossQuotes.get(id);
    if (route) return c.json({ ...route.review, quoteId: id });
    const circle = circleQuotes.get(id);
    if (circle) return c.json({ ...circle.review, quoteId: id });
    const saved = comparisons.get(id);
    return saved
      ? c.json({ ...saved.data, reviewId: id })
      : c.json({ error: "quote_expired" }, 410);
  });
  async function sponsoredCircleEstimate(quote: Awaited<ReturnType<typeof quoteCirclePayment>>) {
    const { review, intent } = quote;
    const block = review.sourceWallet.blockNumber;
    const code = await chain("eth_getCode", [intent.sender, block]);
    if (
      typeof code !== "string" ||
      code.toLowerCase() !== "0xef0100" + delegate.slice(2).toLowerCase()
    )
      return { status: "known_delegation_required" };
    const delegation = await inspectDelegation(chain, intent.sender, delegate);
    if (!delegation.existing?.known) return { status: "unverified_delegate" };
    const gas = await quoteGasInUsdc();
    const maxGasMicroUsdc = gas.maxGasMicroUsdc.swapOrSetup;
    const required = BigInt(review.maxInputMicroUsdc) + BigInt(maxGasMicroUsdc);
    const balance = BigInt(review.sourceWallet.balanceMicroUsdc);
    const budget = {
      maxGasMicroUsdc,
      requiredMicroUsdc: String(required),
      expiresAt: Math.min(review.expiresAt, gas.expiresAt),
    };
    if (required > balance)
      return {
        ...budget,
        status: "insufficient_usdc",
        shortfallMicroUsdc: String(required - balance),
      };
    const burn = quote.calls[quote.calls.length - 1]!;
    checkCircleBurn(burn.data, review);
    const approve = (spender: Hex, amount: bigint) => ({
      target: usdc,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
    });
    const callData = encodeFunctionData({
      abi: batchAbi,
      functionName: "executeBatch",
      args: [
        [
          approve(circleMessenger, BigInt(review.maxInputMicroUsdc)),
          { target: circleMessenger, value: 0n, data: burn.data },
          approve(paymaster, BigInt(maxGasMicroUsdc)),
        ],
      ],
    });
    const op: RpcOp = {
      sender: intent.sender,
      nonce: await paymentNonce(intent.sender),
      callData,
      maxFeePerGas: gas.maxFeePerGas,
      maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
      ...Object.fromEntries(
        Object.entries(paymentGasLimits(false)).map(([key, value]) => [
          key,
          "0x" + value.toString(16),
        ]),
      ),
      signature: simulationSignature,
    };
    await addPaymaster(op);
    const estimate = await simulateOperation(op);
    if (budget.expiresAt <= Date.now() / 1000) throw Error("Sponsored estimate expired");
    return { ...budget, status: "simulated", gas: estimate, paymaster, entryPoint: entry };
  }
  async function issueCircle(intent: Parameters<typeof quoteCirclePayment>[2]) {
    const quote = await quoteCirclePayment(f, chain, intent);
    if (!testnetEnabled) quote.review.execution = "quote_only";
    const sponsoredOrigin = testnetEnabled
      ? await sponsoredCircleEstimate(quote).catch(() => ({ status: "estimate_unavailable" }))
      : undefined;
    const saved = { ...quote, review: { ...quote.review, sponsoredOrigin } };
    return { ...saved.review, quoteId: retain(circleQuotes, saved) };
  }
  app.post("/quote", async (c) => {
    const raw = await c.req.json().catch(() => null);
    if (raw?.provider === "circle_cctp") {
      const parsed = crossPaymentInput
        .safeExtend({
          provider: z.literal("circle_cctp"),
          chainId: z.literal(11155420),
          sourceChainId: z.literal(84532),
        })
        .safeParse(raw);
      if (!parsed.success) return c.json({ error: "unsupported_circle_payment" }, 400);
      try {
        const { provider, ...intent } = parsed.data;
        return c.json(await issueCircle(intent));
      } catch {
        return c.json({ error: "circle_quote_unavailable" }, 503);
      }
    }
    if (raw?.chainId === 10 || raw?.chainId === 11155420) {
      const { sourceChainId, compareProviders, ...rest } = raw;
      if (
        compareProviders !== undefined &&
        !(compareProviders === true && raw.chainId === 11155420 && sourceChainId === 84532)
      )
        return c.json({ error: "invalid_provider_comparison" }, 400);
      const parsed = destinationIntent.safeParse(rest);
      if (!parsed.success) return c.json({ error: "invalid_payment" }, 400);
      const i = parsed.data;
      const cross = { ...i, sourceChainId: acrossRoute(i.chainId).origin };
      if (sourceChainId !== undefined && !compareProviders) {
        try {
          if (sourceChainId === i.chainId) return c.json(await issueDirect(i));
          if (sourceChainId === cross.sourceChainId) return c.json(await issueCross(cross));
          return c.json({ error: "unsupported_cross_chain_payment" }, 400);
        } catch {
          return c.json({ error: "verified_cross_chain_quote_unavailable" }, 503);
        }
      }
      if (i.chainId === 10) {
        try {
          const direct = await issueDirect(i);
          return c.json({
            ...comparePaymentCosts([direct], null),
            unavailableSourceChainIds: [],
            gasConversionSource: null,
          });
        } catch {
          return c.json({ error: "direct_quote_unavailable" }, 503);
        }
      }
      const [direct, bridge, circle] = await Promise.allSettled([
        compareProviders ? null : issueDirect(i),
        issueCross(cross),
        issueCircle({ ...i, chainId: i.chainId, sourceChainId: 84532 }),
      ]);
      type Candidate =
        | Awaited<ReturnType<typeof issueDirect>>
        | Awaited<ReturnType<typeof issueCross>>
        | Awaited<ReturnType<typeof issueCircle>>;
      const candidates: Candidate[] = [];
      const unavailableProviders: string[] = [];
      for (const [result, provider] of [
        [direct, "direct_transfer"],
        [bridge, "across"],
        [circle, "circle_cctp"],
      ] as const) {
        if (result.status === "fulfilled") {
          if (result.value) candidates.push(result.value);
        } else unavailableProviders.push(provider);
      }
      const sources = compareProviders ? [cross.sourceChainId] : [i.chainId, cross.sourceChainId];
      const unavailableSourceChainIds = sources.filter(
        (id) => !candidates.some((q) => q.sourceChainId === id),
      );
      if (!candidates.length) return c.json({ error: "no_verified_quotes" }, 503);
      const rate = candidates.some((c) => c.originGas.estimate)
        ? await testnetGasConversion().catch(() => null)
        : null;
      const comparison = {
        ...comparePaymentCosts(
          candidates.filter((c) => c.expiresAt > Date.now() / 1000),
          rate,
        ),
        unavailableSourceChainIds,
        unavailableProviders,
        gasConversionSource: rate ? "Base Sepolia WETH/USDC pool reference" : null,
      };
      if (!comparison.routes.length) return c.json({ error: "quote_expired" }, 410);
      const reviewId = retain(comparisons, {
        expiresAt: Math.min(...comparison.routes.map((q) => q.expiresAt)),
        data: comparison,
      });
      return c.json({ ...comparison, reviewId });
    }
    if (raw?.sourceChainId !== undefined && (raw.chainId !== 84532 || raw.sourceChainId !== 84532))
      return c.json({ error: "unsupported_cross_chain_payment" }, 400);
    const parsed = input.safeParse(raw);
    if (!parsed.success) return c.json({ error: "invalid_payment" }, 400);
    const { sender, amountMicroUsdc } = parsed.data;
    try {
      const [block, gasQuote] = await Promise.all([chain("eth_blockNumber", []), quoteGasInUsdc()]);
      const blockNumber = hex.parse(block);
      const call = async (to: string, data: Hex) =>
        hex.parse(await chain("eth_call", [{ to, data }, blockNumber])) as Hex;
      const balanceData = encodeFunctionData({
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [sender],
      });
      const [usd, wrapped, code, native] = await Promise.all([
        call(usdc, balanceData),
        call(weth, balanceData),
        chain("eth_getCode", [sender, blockNumber]),
        chain("eth_getBalance", [sender, blockNumber]).then((value) => BigInt(hex.parse(value))),
      ]);
      if (
        code !== "0x" &&
        String(code).toLowerCase() !== "0xef0100" + delegate.slice(2).toLowerCase()
      )
        return c.json({ error: "unsupported_account_code" }, 422);
      const payout = BigInt(amountMicroUsdc);
      const directCap = BigInt(gasQuote.maxGasMicroUsdc.delegatedUsdc);
      const gas =
        code !== "0x" && BigInt(usd) >= payout + directCap
          ? directCap
          : BigInt(gasQuote.maxGasMicroUsdc.swapOrSetup);
      const missing = payout + gas - BigInt(usd);
      let maxWeth = 0n;
      let wethGap = 0n;
      let wrapNative = 0n;
      if (missing > 0n) {
        const data = encodeFunctionData({
          abi,
          functionName: "quoteExactOutputSingle",
          args: [
            { tokenIn: weth, tokenOut: usdc, amount: missing, fee: 3000, sqrtPriceLimitX96: 0n },
          ],
        });
        const [needed] = decodeFunctionResult({
          abi,
          functionName: "quoteExactOutputSingle",
          data: await call(quoter, data),
        });
        if (!needed) throw new Error("no route");
        maxWeth = (needed * 101n + 99n) / 100n;
        const available = BigInt(wrapped);
        if (available + native < needed) wethGap = needed - available - native;
        else if (available < needed) {
          maxWeth = maxWeth < available + native ? maxWeth : available + native;
          wrapNative = maxWeth - available;
        } else if (available < maxWeth) maxWeth = available;
      }
      const result = {
        ...parsed.data,
        execution: wethGap > 0n ? ("quote_only" as const) : ("sponsored_payment" as const),
        sourceWallet: {
          balanceMicroUsdc: BigInt(usd).toString(),
          balanceWethWei: BigInt(wrapped).toString(),
          balanceNativeWei: native.toString(),
        },
        fundingShortfall:
          wethGap > 0n
            ? {
                additionalWethWei: wethGap.toString(),
                additionalMicroUsdcForDirectPayment: (
                  payout +
                  (code === "0x" ? gas : directCap) -
                  BigInt(usd)
                ).toString(),
              }
            : null,
        blockNumber,
        expiresAt: gasQuote.expiresAt,
        delegate,
        paymaster,
        requiresDelegation: code === "0x",
        ...(code === "0x"
          ? {
              authorizationNonce: BigInt(
                hex.parse(await chain("eth_getTransactionCount", [sender, "pending"])),
              ).toString(),
            }
          : {}),
        maxGasMicroUsdc: gas.toString(),
        maxWethWei: maxWeth.toString(),
        wrapNativeWei: wrapNative.toString(),
        swapOutputMicroUsdc: (missing > 0n ? missing : 0n).toString(),
        maxFeePerGas: gasQuote.maxFeePerGas,
        maxPriorityFeePerGas: gasQuote.maxPriorityFeePerGas,
      };
      const quoteId = randomUUID();
      issued.set(quoteId, result);
      return c.json({ ...result, quoteId });
    } catch {
      return c.json({ error: "payment_quote_unavailable" }, 503);
    }
  });
  const sigWord = z
    .string()
    .regex(/^0x[0-9a-f]{64}$/i)
    .transform((x) => x as Hex);
  const authorization = z
    .object({
      chainId: z.literal(84532),
      address: EvmAddress,
      nonce: z.number().int().nonnegative().safe(),
      yParity: z.union([z.literal(0), z.literal(1)]),
      r: sigWord,
      s: sigWord,
    })
    .strict();
  class GasLimitExceeded extends Error {
    constructor(readonly field: string) {
      super("Gas estimate exceeds the reviewed limit");
    }
  }
  async function paymentNonce(sender: Hex) {
    const nonceData = encodeFunctionData({
      abi: parseAbi(["function getNonce(address,uint192) view returns(uint256)"]),
      functionName: "getNonce",
      args: [sender, 0n],
    });
    return (
      "0x" +
      BigInt(
        hex.parse(await chain("eth_call", [{ to: entry, data: nonceData }, "latest"])),
      ).toString(16)
    );
  }
  async function addPaymaster(op: RpcOp) {
    const context = [entry, "0x14a34", { token: usdc }];
    for (const method of ["pm_getPaymasterStubData", "pm_getPaymasterData"]) {
      const offer = z
        .object({ paymaster: EvmAddress, paymasterData: hex })
        .parse(await pm(method, [op, ...context]));
      if (offer.paymaster.toLowerCase() !== paymaster.toLowerCase())
        throw new Error("unexpected_paymaster");
      Object.assign(op, offer);
    }
  }
  async function simulateOperation(op: RpcOp) {
    const estimate = z
      .object({
        callGasLimit: hex,
        verificationGasLimit: hex,
        preVerificationGas: hex,
        paymasterVerificationGasLimit: hex,
        paymasterPostOpGasLimit: hex,
      })
      .parse(await pm("eth_estimateUserOperationGas", [op, entry]));
    for (const [key, value] of Object.entries(estimate)) {
      if (BigInt(value) > BigInt(String(op[key]))) throw new GasLimitExceeded(key);
    }
    return estimate;
  }
  const simulationSignature =
    "0x302f9159d5987680933b56019340d483d5ad02ac7f20d74021d3b587a0077b0b2388e782c5690c9c391c5877f4edadabdf7751dfee5c2dd90e4cded0f6e091181c";
  app.post("/build", async (c) => {
    const parsed = z
      .object({ quoteId: z.uuid(), authorization: authorization.optional() })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_build_request" }, 400);
    const q = issued.get(parsed.data.quoteId);
    if (!q || q.expiresAt <= Date.now() / 1000) return c.json({ error: "quote_expired" }, 410);
    if (q.execution === "quote_only") return c.json({ error: "funded_quote_required" }, 422);
    try {
      const auth = parsed.data.authorization;
      const checked = await inspectDelegation(chain, q.sender, delegate);
      if (!checked.proposed || !("known" in checked.proposed) || !checked.proposed.known)
        return c.json({ error: "unverified_delegate_runtime" }, 422);
      const nonce = await paymentNonce(q.sender);
      const direct = !q.requiresDelegation && q.maxWethWei === "0";
      const op: Record<string, string | Record<string, string>> = {
        sender: q.sender,
        nonce,
        callData: paymentBatch(q),
        maxFeePerGas: q.maxFeePerGas,
        maxPriorityFeePerGas: q.maxPriorityFeePerGas,
        ...Object.fromEntries(
          Object.entries(paymentGasLimits(direct)).map(([key, value]) => [
            key,
            "0x" + value.toString(16),
          ]),
        ),
        signature: simulationSignature,
      };
      if (q.requiresDelegation) {
        if (checked.accountType !== "undelegated")
          return c.json({ error: "delegation_changed" }, 409);
        const pending = BigInt(
          hex.parse(await chain("eth_getTransactionCount", [q.sender, "pending"])),
        );
        if (!auth)
          return c.json(
            {
              error: "delegation_required",
              delegation: checked,
              authorization: { chainId: 84532, address: delegate, nonce: pending.toString() },
            },
            409,
          );
        if (
          auth.address.toLowerCase() !== delegate.toLowerCase() ||
          BigInt(auth.nonce) !== pending ||
          (await recoverAuthorizationAddress({ authorization: auth })).toLowerCase() !==
            q.sender.toLowerCase()
        )
          return c.json({ error: "invalid_delegation" }, 422);
        Object.assign(op, {
          factory: "0x7702",
          factoryData: "0x",
          eip7702Auth: {
            ...auth,
            chainId: "0x14a34",
            nonce: "0x" + pending.toString(16),
            yParity: "0x" + auth.yParity.toString(16),
          },
        });
      } else if (auth || !checked.existing?.known)
        return c.json({ error: "delegation_changed" }, 409);
      await addPaymaster(op);
      const estimate = await simulateOperation(op);
      if (q.expiresAt <= Date.now() / 1000) return c.json({ error: "quote_expired" }, 410);
      delete op.signature;
      const typed = getUserOperationTypedData({
        chainId: 84532,
        entryPointAddress: entry,
        userOperation: {
          sender: q.sender,
          nonce: BigInt(nonce),
          callData: paymentBatch(q),
          signature: "0x",
          ...(auth
            ? { factory: "0x7702" as const, factoryData: "0x" as const, authorization: auth }
            : {}),
          callGasLimit: BigInt(String(op.callGasLimit)),
          verificationGasLimit: BigInt(String(op.verificationGasLimit)),
          preVerificationGas: BigInt(String(op.preVerificationGas)),
          maxFeePerGas: BigInt(q.maxFeePerGas),
          maxPriorityFeePerGas: BigInt(q.maxPriorityFeePerGas),
          paymaster,
          paymasterData: op.paymasterData as Hex,
          paymasterVerificationGasLimit: BigInt(String(op.paymasterVerificationGasLimit)),
          paymasterPostOpGasLimit: BigInt(String(op.paymasterPostOpGasLimit)),
        },
      });
      const digest = hashTypedData(typed);
      builds.set(parsed.data.quoteId, { op, digest, quote: q });
      return c.json({
        quoteId: parsed.data.quoteId,
        quote: q,
        entryPoint: entry,
        userOperation: op,
        userOpHash: digest,
        typedData: jsonSigningRequest(typed),
        delegation: checked,
        simulation: { gas: estimate },
      });
    } catch (e) {
      if (e instanceof GasLimitExceeded)
        return c.json({ error: "gas_limit_exceeded", field: e.field }, 422);
      return c.json({ error: "payment_build_or_simulation_failed" }, 422);
    }
  });
  app.post("/verify", async (c) => {
    const parsed = z
      .object({
        quoteId: z.uuid(),
        userOpHash: sigWord,
        userOperation: z.record(z.string(), z.unknown()),
        authorization: authorization.optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_verification_request" }, 400);
    const { quoteId, userOperation, userOpHash, authorization: auth } = parsed.data;
    const built = builds.get(quoteId);
    if (!built || built.quote.expiresAt <= Date.now() / 1000)
      return c.json({ error: "build_missing_or_expired" }, 410);
    const q = built.quote;
    if (userOpHash !== built.digest || !isDeepStrictEqual(userOperation, built.op))
      return c.json({ error: "operation_differs_from_build" }, 422);
    try {
      const typed = paymentSignatureRequest(q, userOperation, userOpHash, auth);
      const delegation = await inspectDelegation(chain, q.sender, delegate);
      if (
        !delegation.proposed ||
        !("known" in delegation.proposed) ||
        !delegation.proposed.known ||
        (q.requiresDelegation
          ? delegation.accountType !== "undelegated"
          : !delegation.existing?.known)
      )
        throw Error("Delegation changed");
      if (
        auth &&
        (BigInt(auth.nonce) !==
          BigInt(hex.parse(await chain("eth_getTransactionCount", [q.sender, "pending"]))) ||
          (await recoverAuthorizationAddress({ authorization: auth })).toLowerCase() !==
            q.sender.toLowerCase())
      )
        throw Error("Invalid authorization");
      const gas = await simulateOperation({ ...built.op, signature: simulationSignature });
      if (q.expiresAt <= Date.now() / 1000) return c.json({ error: "quote_expired" }, 410);
      return c.json({
        status: "verified",
        delegation,
        quoteId,
        typedData: jsonSigningRequest(typed),
        userOpHash,
        entryPoint: entry,
        delegate,
        paymaster,
        sender: q.sender,
        recipient: q.recipient,
        amountMicroUsdc: q.amountMicroUsdc,
        maxWethWei: q.maxWethWei,
        wrapNativeWei: q.wrapNativeWei ?? "0",
        maxGasMicroUsdc: q.maxGasMicroUsdc,
        expiresAt: q.expiresAt,
        simulation: { gas },
      });
    } catch {
      return c.json({ error: "bundle_verification_failed" }, 422);
    }
  });
  app.post("/submit", async (c) => {
    const parsed = z
      .object({
        quoteId: z.uuid(),
        userOpHash: sigWord,
        signature: z
          .string()
          .regex(/^0x[0-9a-f]{130}$/i)
          .transform((s) => s as Hex),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_signed_payment" }, 400);
    const { quoteId, userOpHash, signature } = parsed.data;
    if (receipts.get(userOpHash)?.relayed) return c.json({ userOpHash, status: "submitted" });
    const built = builds.get(quoteId);
    if (!built || built.quote.expiresAt <= Date.now() / 1000)
      return c.json({ error: "quote_expired" }, 410);
    if (built.digest !== userOpHash) return c.json({ error: "operation_changed" }, 409);
    try {
      if (
        (await recoverAddress({ hash: built.digest, signature })).toLowerCase() !==
        built.quote.sender.toLowerCase()
      )
        return c.json({ error: "wrong_payment_signer" }, 422);
      // Save intent before relay so a lost response can be recovered using the signed hash.
      receipts.remember(built.digest, built.quote);
      try {
        const result = await pm("eth_sendUserOperation", [{ ...built.op, signature }, entry]);
        if (result !== built.digest) throw new Error("unexpected operation hash");
      } catch {
        // The bundler may have accepted the operation before its response was lost.
        return c.json({ userOpHash: built.digest, status: "submission_unconfirmed" }, 202);
      }
      receipts.markRelayed(built.digest);
      return c.json({ userOpHash: built.digest, status: "submitted" });
    } catch {
      return c.json({ error: "payment_submission_failed", userOpHash: built.digest }, 422);
    }
  });
  app.get("/status/:hash", async (c) => {
    const digest = c.req.param("hash"),
      saved = receipts.get(digest);
    if (!saved) return c.json({ error: "unknown_payment" }, 404);
    try {
      const data = await pm("eth_getUserOperationReceipt", [digest]);
      if (data === null)
        return c.json({
          status: saved.relayed ? "pending" : "submission_unconfirmed",
          userOpHash: digest,
        });
      const r = operationReceipt.parse(data);
      const canonical = chainReceipt.parse(
        await chain("eth_getTransactionReceipt", [r.receipt.transactionHash]),
      );
      const result = reconcilePayment(saved.quote, digest, r, canonical);
      const finalizedBlock = await chain("eth_getBlockByNumber", ["finalized", false]);
      const inclusionBlock = await chain("eth_getBlockByNumber", [canonical.blockNumber, false]);
      const inclusion = z
        .object({ hash: sigWord, parentHash: sigWord.optional() })
        .parse(inclusionBlock);
      if (inclusion.hash.toLowerCase() !== canonical.blockHash.toLowerCase())
        throw Error("Payment receipt is no longer on the canonical chain");
      const finalized =
        BigInt(z.object({ number: hex }).parse(finalizedBlock).number) >=
        BigInt(canonical.blockNumber);
      if (!finalized) return c.json({ ...result, status: "awaiting_finality", finalized });
      const dataAllowance = encodeFunctionData({
        abi: erc20Abi,
        functionName: "allowance",
        args: [saved.quote.sender, paymaster],
      });
      const remaining = chain("eth_call", [
        { to: usdc, data: dataAllowance },
        { blockHash: canonical.blockHash, requireCanonical: true },
      ])
        .then((x) => BigInt(hex.parse(x)).toString())
        .catch(() => null);
      const balances =
        inclusion.parentHash && result.status === "settled"
          ? Promise.all([
              paymentBlockBalances(chain, saved.quote, inclusion.parentHash),
              paymentBlockBalances(chain, saved.quote, inclusion.hash),
            ])
              .then(([before, after]) => ({ before, after }))
              .catch(() => null)
          : null;
      const [paymasterAllowanceAfterBlockMicroUsdc, blockBalances] = await Promise.all([
        remaining,
        balances,
      ]);
      return c.json({
        ...result,
        finalized,
        paymasterAllowanceAfterBlockMicroUsdc,
        ...(paymasterAllowanceAfterBlockMicroUsdc && paymasterAllowanceAfterBlockMicroUsdc !== "0"
          ? {
              allowanceCleanup: {
                tool: "build_revoke_tx",
                arguments: { chainId: 84532, token: usdc, spender: paymaster },
                sender: saved.quote.sender,
                requiresNativeGas: true,
              },
            }
          : {}),
        blockBalances,
        paymaster,
      });
    } catch {
      return c.json({ error: "settlement_unverified", userOpHash: digest }, 502);
    }
  });
  return app;
}
