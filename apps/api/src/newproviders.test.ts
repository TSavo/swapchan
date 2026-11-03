import type { QuoteRequest } from "@swapchan/shared";
import { Psbt } from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import { buildBtcPsbt } from "./btc.js";
import type { Pricer } from "./pricing.js";
import { debridge } from "./providers/debridge.js";
import { kyberswap } from "./providers/kyberswap.js";
import { oneinch } from "./providers/oneinch.js";
import { thorchain } from "./providers/thorchain.js";

const FEE = "0xeb0eC7a28E4B6B175806E21D9D3afE45792C5c7B";
const env = { SWAPCHAN_FEE_BPS: "10", SWAPCHAN_FEE_RECIPIENT: FEE } as NodeJS.ProcessEnv;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const pricer: Pricer = {
  token: async (c, a) => ({
    priceUsd: a === USDC ? 1 : c === 8253038 ? 100000 : 2000,
    decimals: a === USDC ? 6 : c === 8253038 ? 8 : 18,
  }),
  usd: async (c, a, amt) =>
    a === USDC
      ? Number(amt) / 1e6
      : c === 8253038
        ? (Number(amt) / 1e8) * 100000
        : (Number(amt) / 1e18) * 2000,
};
const mock = (route: (url: string) => unknown) => {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    return Response.json(route(url));
  }) as unknown as typeof fetch;
  return { f, urls };
};
const sig = () => AbortSignal.timeout(1000);
const same = {
  fromChainId: 8453,
  toChainId: 8453,
  fromToken: NATIVE,
  toToken: USDC,
  amount: "100000000000000000",
  slippageBps: 50,
} as QuoteRequest;

describe("new providers", () => {
  it("kyberswap: passes extraFee and measures our cut from the route", async () => {
    const { f, urls } = mock(() => ({
      code: 0,
      data: {
        routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
        routeSummary: {
          amountOut: "199800000",
          gasUsd: "0.01",
          extraFee: {
            feeAmount: "10",
            chargeFeeBy: "currency_out",
            feeReceiver: FEE.toLowerCase(),
          },
          route: [[{ amountOut: "200000000", exchange: "uniswap-v3" }]],
        },
      },
    }));
    const q = await kyberswap(pricer, env, f).quote(same, sig());
    expect(urls[0]).toContain("feeAmount=10");
    expect(urls[0]).toContain(`feeReceiver=${FEE}`);
    expect(q).toMatchObject({ toAmount: "199800000", ourFeeVerified: true, approvalAddress: null });
    expect(q.ourFeeUsd).toBeCloseTo(0.2);
  });

  it("debridge: affiliate fee from costsDetails, cross-chain only", async () => {
    const { f, urls } = mock(() => ({
      estimation: {
        dstChainTokenOut: { amount: "49900000" },
        costsDetails: [
          { chain: "8453", tokenIn: USDC, type: "AffiliateFee", payload: { feeAmount: "50000" } },
        ],
      },
      fixFee: "1000000000000000",
    }));
    const p = debridge(pricer, env, f);
    expect(p.supports(same)).toBe(false);
    const q = await p.quote(
      {
        ...same,
        fromToken: USDC,
        toChainId: 42161,
        toToken: USDC,
        amount: "50000000",
      } as QuoteRequest,
      sig(),
    );
    expect(urls[0]).toContain("affiliateFeePercent=0.1");
    expect(q).toMatchObject({ ourFeeVerified: true, toAmount: "49900000" });
    expect(q.ourFeeUsd).toBeCloseTo(0.05);
    expect(q.gasUsd).toBeCloseTo(2);
  });

  it("thorchain: unverified without a THORName, affiliate measured with one; EVM deposit tx", async () => {
    const quote = (aff: string) => ({
      inbound_address: "0x1234567890123456789012345678901234567890",
      router: "0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146",
      memo: "=:BTC.BTC:bc1qy65xajxwrtp62uk3styn9py7m2k06cdj2wla6n",
      expected_amount_out: "200000",
      expiry: 2_000_000_000,
      fees: { asset: "BTC.BTC", affiliate: aff, outbound: "0", liquidity: "0", total: "0" },
    });
    const req = {
      fromChainId: 1,
      toChainId: 8253038,
      fromToken: NATIVE,
      toToken: "bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8",
      amount: "100000000000000000",
      slippageBps: 100,
      taker: FEE,
      recipient: "bc1qy65xajxwrtp62uk3styn9py7m2k06cdj2wla6n",
    } as QuoteRequest;
    const a = mock((u) => (u.endsWith("/pools") ? [] : quote("0")));
    const q1 = await thorchain(pricer, env, a.f).quote(req, sig());
    expect(a.urls[0]).not.toContain("affiliate=");
    expect(q1).toMatchObject({ ourFeeVerified: false, toAmount: "200000" });
    expect(q1.tx?.value).toBe(req.amount);
    const b = mock((u) =>
      u.endsWith("/pools")
        ? []
        : u.includes("/thorname/")
          ? { name: "sc", aliases: [{ chain: "THOR", address: "thor1x" }] }
          : quote("200"),
    );
    const q2 = await thorchain(pricer, { ...env, THORCHAIN_AFFILIATE: "sc" }, b.f).quote(
      req,
      sig(),
    );
    expect(b.urls.find((u) => u.includes("/quote/"))).toContain("affiliate=sc&affiliate_bps=10");
    expect(q2.ourFeeVerified).toBe(true);
  });

  it("1inch: off without a key", () => {
    expect(oneinch(pricer, env).enabled()).toBe(false);
    expect(oneinch(pricer, { ...env, ONEINCH_API_KEY: "k" }).enabled()).toBe(true);
  });

  it("btc psbt: vault, change, OP_RETURN memo in THORChain order", async () => {
    const from = "bc1qy65xajxwrtp62uk3styn9py7m2k06cdj2wla6n";
    const b64 = await buildBtcPsbt(
      async () => [{ txid: "aa".repeat(32), vout: 0, value: 100_000 }],
      {
        from,
        to: "bc1qup236qj2mr87ml9388ydm33tuhtdckk33j68qx",
        amount: 50_000n,
        memo: "=:e:0xeb0eC7a28E4B6B175806E21D9D3afE45792C5c7B",
        feeRate: 5,
      },
    );
    const p = Psbt.fromBase64(b64);
    expect(p.txOutputs.map((o) => o.address ?? "op_return")).toEqual([
      "bc1qup236qj2mr87ml9388ydm33tuhtdckk33j68qx",
      from,
      "op_return",
    ]);
    expect(p.txOutputs[0]?.value).toBe(50_000n);
  });
});

describe("1inch fee", () => {
  const key = { ...env, ONEINCH_API_KEY: "k" } as NodeJS.ProcessEnv;
  const REF = FEE.slice(2).toLowerCase();
  const seqFetch = (route: (url: string) => { status?: number; body: unknown }) => {
    const urls: string[] = [];
    let inflight = 0;
    let maxInflight = 0;
    const f = (async (url: string) => {
      urls.push(url);
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      const { status = 200, body } = route(url);
      return Response.json(body, { status });
    }) as unknown as typeof fetch;
    return { f, urls, max: () => maxInflight };
  };

  it("runs the two quotes sequentially, fee first", async () => {
    const m = seqFetch(() => ({ body: { dstAmount: "300000000" } }));
    await oneinch(pricer, key, m.f, () => {}).quote(same, sig());
    expect(m.max()).toBe(1);
    expect(m.urls[0]).toContain("fee=0.1");
    expect(m.urls[1]).not.toContain("fee=");
  });

  it("quote ignores fee (as measured): deducts expected fee, unverified", async () => {
    const m = seqFetch(() => ({ body: { dstAmount: "300000000" } }));
    const q = await oneinch(pricer, key, m.f, () => {}).quote(same, sig());
    expect(q.toAmount).toBe("299700000");
    expect(q.ourFeeUsd).toBeCloseTo(0.3, 6);
    expect(q.ourFeeVerified).toBe(false);
  });

  it("quote deducts fee: measured and verified", async () => {
    const m = seqFetch((u) => ({
      body: { dstAmount: u.includes("fee=") ? "299700000" : "300000000" },
    }));
    const q = await oneinch(pricer, key, m.f, () => {}).quote(same, sig());
    expect(q.toAmount).toBe("299700000");
    expect(q.ourFeeUsd).toBeCloseTo(0.3, 6);
    expect(q.ourFeeVerified).toBe(true);
  });

  it("logs a failed no-fee quote and stays unverified", async () => {
    const logs: string[] = [];
    const m = seqFetch((u) =>
      u.includes("fee=") ? { body: { dstAmount: "300000000" } } : { status: 429, body: { e: 1 } },
    );
    const q = await oneinch(pricer, key, m.f, (s) => logs.push(s)).quote(same, sig());
    expect(logs.join()).toMatch(/no-fee quote failed.*429/);
    expect(q.ourFeeVerified).toBe(false);
    expect(q.toAmount).toBe("299700000");
  });

  it("swap with referrer in calldata and fee taken: verified", async () => {
    const m = seqFetch((u) =>
      u.includes("/swap?")
        ? {
            body: {
              dstAmount: "299700000",
              tx: {
                to: "0x111111125421cA6dc452d289314280a0f8842A65",
                data: `0xabcd${REF}`,
                value: "0",
              },
            },
          }
        : { body: { dstAmount: "300000000" } },
    );
    const q = await oneinch(pricer, key, m.f, () => {}).quote({ ...same, taker: FEE }, sig());
    expect(m.urls.at(-1)).toContain(`referrer=${FEE}`);
    expect(q.ourFeeVerified).toBe(true);
    expect(q.toAmount).toBe("299700000");
  });

  it("swap without our referrer in calldata: not verified", async () => {
    const logs: string[] = [];
    const m = seqFetch((u) =>
      u.includes("/swap?")
        ? {
            body: {
              dstAmount: "300000000",
              tx: { to: "0x111111125421cA6dc452d289314280a0f8842A65", data: "0xabcd", value: "0" },
            },
          }
        : { body: { dstAmount: "300000000" } },
    );
    const q = await oneinch(pricer, key, m.f, (s) => logs.push(s)).quote(
      { ...same, taker: FEE },
      sig(),
    );
    expect(q.ourFeeVerified).toBe(false);
    expect(logs.join()).toMatch(/fee not verified/);
  });

  it("no fee configured: one quote call, no fee", async () => {
    const m = seqFetch(() => ({ body: { dstAmount: "300000000" } }));
    const q = await oneinch(
      pricer,
      { ONEINCH_API_KEY: "k" } as NodeJS.ProcessEnv,
      m.f,
      () => {},
    ).quote(same, sig());
    expect(m.urls).toHaveLength(1);
    expect(q.ourFeeUsd).toBe(0);
    expect(q.ourFeeVerified).toBe(false);
  });
});
