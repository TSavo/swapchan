import { isEvmChain, Quote, type QuoteRequest } from "@swapchan/shared";
import { type Pricer, ZERO_ADDRESS } from "../pricing.js";
import { type Fetch, getJson, type ProviderAdapter } from "./types.js";

const BASE = "https://api.1inch.com/swap/v6.1";
/** 1inch AggregationRouterV6: same address on every supported chain. */
const ROUTER = "0x111111125421cA6dc452d289314280a0f8842A65";
const CHAINS = new Set([1, 8453, 42161, 10, 137, 56, 43114, 59144]);
const ONEINCH_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const to1inch = (a: string) => (a.toLowerCase() === ZERO_ADDRESS ? ONEINCH_NATIVE : a);

type Log = (msg: string) => void;

/**
 * 1inch Swap API (classic). Needs ONEINCH_API_KEY (business.1inch.com). Our fee: `fee` (percent)
 * paid to `referrer`; per the docs `referrer` is a /swap parameter, required when `fee` is set.
 *
 * Measured 2026-11-03 on Base: /quote returns the same `dstAmount` with and without `fee` (also
 * with `referrer`, also at fee=3), so a /quote pair cannot show our cut. We still run the no-fee
 * quote (sequentially, after the fee quote) and use the difference if 1inch ever deducts there.
 * Otherwise the fee is only applied in /swap calldata: a quote without a built tx deducts the
 * expected fee from `toAmount` and reports it unverified; a built tx is verified only when the
 * calldata carries our referrer and its `dstAmount` is below the no-fee quote by the fee.
 */
export function oneinch(
  pricer: Pricer,
  env: NodeJS.ProcessEnv,
  f: Fetch = fetch,
  log: Log = (m) => console.warn(m),
): ProviderAdapter {
  const key = env.ONEINCH_API_KEY;
  const feeBps = Number(env.SWAPCHAN_FEE_BPS ?? 0);
  const referrer = env.SWAPCHAN_FEE_RECIPIENT;
  const charging = Boolean(referrer) && feeBps > 0;
  const headers = { Authorization: `Bearer ${key ?? ""}`, accept: "application/json" };
  const params = (req: QuoteRequest, withFee: boolean) => {
    const q = new URLSearchParams({
      src: to1inch(req.fromToken),
      dst: to1inch(req.toToken),
      amount: req.amount,
      includeGas: "true",
      includeProtocols: "true",
    });
    if (withFee && charging) q.set("fee", String(feeBps / 100));
    return q;
  };
  return {
    name: "1inch",
    enabled: () => Boolean(key),
    supports: (r) =>
      isEvmChain(r.fromChainId) && r.fromChainId === r.toChainId && CHAINS.has(r.fromChainId),
    async quote(req, signal) {
      const c = req.fromChainId;
      const withFee = await getJson<{ dstAmount: string; gas?: number }>(
        f,
        `${BASE}/${c}/quote?${params(req, true)}`,
        { headers, signal },
      );
      let noFee: bigint | null = null;
      if (charging) {
        try {
          const r = await getJson<{ dstAmount: string }>(
            f,
            `${BASE}/${c}/quote?${params(req, false)}`,
            { headers, signal },
          );
          noFee = BigInt(r.dstAmount);
        } catch (e) {
          log(`1inch: no-fee quote failed on chain ${c}: ${(e as Error).message}`);
        }
      }
      const quoted = BigInt(withFee.dstAmount);
      // Pre-fee output: the no-fee quote when we have it, else the fee quote (1inch ignores `fee` there).
      const gross = noFee !== null && noFee > quoted ? noFee : quoted;
      const expectedFee = charging ? (gross * BigInt(feeBps)) / 10_000n : 0n;
      let out = quoted;
      let feeRaw = 0n;
      let verified = false;
      if (charging && noFee !== null && noFee > quoted) {
        // 1inch deducted the fee in /quote: measured.
        feeRaw = noFee - quoted;
        verified = true;
      } else if (charging) {
        // Fee not visible in /quote: deduct what /swap will take so comparisons stay fair.
        out = gross - expectedFee;
        feeRaw = expectedFee;
      }
      let tx: Quote["tx"] = null;
      if (req.taker) {
        const q = params(req, true);
        q.set("from", req.taker);
        q.set("origin", req.taker);
        q.set("slippage", String(req.slippageBps / 100));
        q.set("disableEstimate", "true");
        if (charging && referrer) q.set("referrer", referrer);
        const s = await getJson<{
          dstAmount?: string;
          tx: { to: string; data: string; value: string; gas?: number };
        }>(f, `${BASE}/${c}/swap?${q}`, { headers, signal });
        tx = {
          chainId: c,
          to: s.tx.to as `0x${string}`,
          data: s.tx.data as `0x${string}`,
          value: s.tx.value,
          ...(s.tx.gas ? { gasLimit: String(s.tx.gas) } : {}),
        };
        if (charging && referrer && !verified) {
          const refInData = s.tx.data.toLowerCase().includes(referrer.slice(2).toLowerCase());
          const swapOut = s.dstAmount ? BigInt(s.dstAmount) : null;
          if (
            refInData &&
            noFee !== null &&
            swapOut !== null &&
            noFee - swapOut >= expectedFee / 2n
          ) {
            out = swapOut;
            feeRaw = noFee - swapOut;
            verified = true;
          } else {
            log(
              `1inch: fee not verified on chain ${c} swap (referrer in calldata: ${refInData}, swap dstAmount: ${s.dstAmount ?? "none"}, no-fee: ${noFee ?? "none"})`,
            );
          }
        }
      }
      const [outUsd, ourFeeUsd] = await Promise.all([
        pricer.usd(req.toChainId, req.toToken, out),
        feeRaw > 0n ? pricer.usd(req.toChainId, req.toToken, feeRaw) : Promise.resolve(0),
      ]);
      const native = to1inch(req.fromToken) === ONEINCH_NATIVE;
      return Quote.parse({
        id: `1inch:${crypto.randomUUID()}`,
        provider: "1inch",
        request: req,
        toAmount: out.toString(),
        toAmountMin: ((out * BigInt(10_000 - req.slippageBps)) / 10_000n).toString(),
        gasUsd: 0,
        feeUsd: ourFeeUsd ?? 0,
        netUsd: outUsd,
        etaSeconds: 15,
        steps: [
          {
            type: "swap",
            tool: "1inch",
            fromChainId: c,
            toChainId: c,
            fromToken: req.fromToken,
            toToken: req.toToken,
            fromAmount: req.amount,
            toAmount: out.toString(),
          },
        ],
        approvalAddress: native ? null : ROUTER,
        tx,
        expiresAt: Date.now() + 30_000,
        ourFeeUsd: ourFeeUsd ?? 0,
        ourFeeVerified: verified,
        ...(referrer && feeRaw > 0n ? { feeRecipient: { address: referrer, chainId: c } } : {}),
      });
    },
  };
}
