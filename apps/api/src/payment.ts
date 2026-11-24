import { randomUUID } from "node:crypto";
import {
  EvmAddress,
  type PaymentQuote,
  paymentBatch,
  paymentContracts,
  paymentGasLimits,
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
import { crossPaymentInput, quoteCrossPayment } from "./payment-cross-chain.js";
import { crossSettlement, settlementInput } from "./payment-cross-settlement.js";
import { inspectDelegation } from "./payment-delegation.js";
import { chainReceipt, operationReceipt, reconcilePayment } from "./payment-receipt.js";
import { openPaymentStore } from "./payment-store.js";

const { weth, usdc, paymaster, entry, delegate } = paymentContracts;
const quoter = "0xC5290058841028F1614F3A6F0F5816cAd0df5E27";
const abi = parseAbi([
  "function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const input = z
  .object({
    chainId: z.literal(84532),
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
export function paymentRoutes(f: typeof fetch, receipts = openPaymentStore()) {
  const issued = new Map<string, PaymentQuote>();
  type RpcOp = Record<string, string | Record<string, string>>;
  const builds = new Map<string, { op: RpcOp; digest: Hex; quote: PaymentQuote }>();
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
  app.post("/cross-chain/status", async (c) => {
    const parsed = settlementInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_settlement_request" }, 400);
    try {
      return c.json(
        await crossSettlement(
          (id, m, p) =>
            rpc(id === 8453 ? "https://mainnet.base.org" : "https://mainnet.optimism.io", m, p),
          parsed.data,
          f,
        ),
      );
    } catch {
      return c.json({ error: "settlement_unverified" }, 502);
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
  app.post("/quote", async (c) => {
    const raw = await c.req.json().catch(() => null);
    if (raw?.sourceChainId !== undefined) {
      const cross = crossPaymentInput.safeParse(raw);
      if (!cross.success) return c.json({ error: "unsupported_cross_chain_payment" }, 400);
      try {
        return c.json(
          await quoteCrossPayment(f, cross.data, (method, params) =>
            rpc("https://mainnet.base.org", method, params),
          ),
        );
      } catch {
        return c.json({ error: "verified_cross_chain_quote_unavailable" }, 503);
      }
    }
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
      const [usd, wrapped, code] = await Promise.all([
        call(usdc, balanceData),
        call(weth, balanceData),
        chain("eth_getCode", [sender, blockNumber]),
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
        if (available < needed)
          return c.json({ error: "insufficient_WETH", requiredWei: maxWeth.toString() }, 422);
        if (available < maxWeth) maxWeth = available;
      }
      const result = {
        ...parsed.data,
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
        swapOutputMicroUsdc: (missing > 0n ? missing : 0n).toString(),
        maxFeePerGas: gasQuote.maxFeePerGas,
        maxPriorityFeePerGas: gasQuote.maxPriorityFeePerGas,
      };
      const quoteId = randomUUID();
      for (const [id, old] of issued) {
        if (old.expiresAt > Date.now() / 1000 && issued.size < 2048) break;
        issued.delete(id);
        builds.delete(id);
      }
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
  app.post("/build", async (c) => {
    const parsed = z
      .object({ quoteId: z.uuid(), authorization: authorization.optional() })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_build_request" }, 400);
    const q = issued.get(parsed.data.quoteId);
    if (!q || q.expiresAt <= Date.now() / 1000) return c.json({ error: "quote_expired" }, 410);
    try {
      const auth = parsed.data.authorization;
      const checked = await inspectDelegation(chain, q.sender, delegate);
      if (!checked.proposed || !("known" in checked.proposed) || !checked.proposed.known)
        return c.json({ error: "unverified_delegate_runtime" }, 422);
      const nonceData = encodeFunctionData({
        abi: parseAbi(["function getNonce(address,uint192) view returns(uint256)"]),
        functionName: "getNonce",
        args: [q.sender, 0n],
      });
      const nonce =
        "0x" +
        BigInt(
          hex.parse(await chain("eth_call", [{ to: entry, data: nonceData }, "latest"])),
        ).toString(16);
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
        signature:
          "0x302f9159d5987680933b56019340d483d5ad02ac7f20d74021d3b587a0077b0b2388e782c5690c9c391c5877f4edadabdf7751dfee5c2dd90e4cded0f6e091181c",
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
      const context = [entry, "0x14a34", { token: usdc }];
      for (const method of ["pm_getPaymasterStubData", "pm_getPaymasterData"]) {
        const offer = z
          .object({ paymaster: EvmAddress, paymasterData: hex })
          .parse(await pm(method, [op, ...context]));
        if (offer.paymaster.toLowerCase() !== paymaster.toLowerCase())
          return c.json({ error: "unexpected_paymaster" }, 422);
        Object.assign(op, offer);
      }
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
        if (BigInt(value) > BigInt(String(op[key])))
          return c.json({ error: "gas_limit_exceeded", field: key }, 422);
      }
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
      const packed = Object.fromEntries(
        typed.types.PackedUserOperation.map(({ name }) => [name, String(typed.message[name])]),
      );
      return c.json({
        quoteId: parsed.data.quoteId,
        quote: q,
        entryPoint: entry,
        userOperation: op,
        userOpHash: digest,
        typedData: { ...typed, message: packed },
        simulation: { gas: estimate },
      });
    } catch {
      return c.json({ error: "payment_build_or_simulation_failed" }, 422);
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
      return c.json(reconcilePayment(saved.quote, digest, r, canonical));
    } catch {
      return c.json({ error: "settlement_unverified", userOpHash: digest }, 502);
    }
  });
  return app;
}
