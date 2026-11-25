import type { Quote, QuoteRequest } from "@swapchan/shared";
import { describe, expect, it } from "vitest";
import { createApp, rank } from "./index.js";
import { lifi } from "./providers/lifi.js";
import type { ProviderAdapter } from "./providers/types.js";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const LINK = "0x514910771af9ca656af840dff83e8264ecf986ca";
const req = {
  fromChainId: 1,
  toChainId: 1,
  fromToken: USDC,
  toToken: LINK,
  amount: "1000000",
  slippageBps: 50,
} as QuoteRequest;
const mk = (provider: string, toAmount: string, netUsd: number | null): Quote => ({
  id: `${provider}:1`,
  provider,
  request: req,
  toAmount,
  toAmountMin: toAmount,
  gasUsd: 0,
  feeUsd: 0,
  netUsd,
  etaSeconds: 1,
  steps: [],
  approvalAddress: null,
  tx: null,
  expiresAt: 0,
});
const fake = (q: Quote | Error): ProviderAdapter => ({
  name: q instanceof Error ? "bad" : q.provider,
  enabled: () => true,
  supports: () => true,
  quote: async () => {
    if (q instanceof Error) throw q;
    return q;
  },
});

describe("api", () => {
  it("ranks by netUsd then bigint toAmount", () => {
    const r = rank([
      mk("a", "5", null),
      mk("b", "1", 2),
      mk("c", "99999999999999999999", null),
      mk("d", "1", 3),
    ]);
    expect(r.map((q) => q.provider)).toEqual(["d", "b", "c", "a"]);
  });
  it("health", async () => {
    const res = await createApp([]).request("/health");
    expect(Object.keys(await res.json()).sort()).toEqual(["ok", "providers", "version"]);
  });
  it("fans out, isolates provider errors", async () => {
    const app = createApp([fake(mk("x", "10", 1)), fake(new Error("boom"))], { pricer: null });
    const res = await app.request(
      `/quotes?${new URLSearchParams({ fromChainId: "1", toChainId: "1", fromToken: USDC, toToken: LINK, amount: "1000000" })}`,
    );
    const body = await res.json();
    expect(body.best).toBe("x:1");
    expect(body.errors).toEqual([{ provider: "bad", message: "boom" }]);
  });
  it("rejects float amounts", async () => {
    const res = await createApp([]).request(
      `/quotes?fromChainId=1&toChainId=1&fromToken=${USDC}&toToken=${LINK}&amount=1.5`,
    );
    expect(res.status).toBe(400);
  });
  it("only reopens the selected unexpired quote for its reviewed request", async () => {
    const chosen = { ...mk("chosen", "10", 1), expiresAt: Date.now() + 60_000 };
    const app = createApp([fake(chosen), fake(mk("expired", "20", 2))], { pricer: null });
    const query = new URLSearchParams({
      fromChainId: "1",
      toChainId: "1",
      fromToken: USDC,
      toToken: LINK,
      amount: req.amount,
    });
    await app.request(`/quotes?${query}`);
    query.set("quoteId", chosen.id);
    expect(await (await app.request(`/quotes?${query}`)).json()).toMatchObject({
      best: chosen.id,
      quotes: [{ id: chosen.id }],
    });
    query.set("amount", "1");
    expect((await app.request(`/quotes?${query}`)).status).toBe(409);
    query.set("quoteId", "expired:1");
    expect((await app.request(`/quotes?${query}`)).status).toBe(410);
    const build = await app.request("/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quoteId: "expired:1", taker: LINK, strictRoute: true }),
    });
    expect(build.status).toBe(410);
  });
  it("normalizes a LI.FI response", async () => {
    const f = (async () =>
      Response.json({
        id: "abc",
        type: "lifi",
        tool: "uniswap",
        action: {
          fromChainId: 1,
          toChainId: 1,
          fromToken: { address: USDC },
          toToken: { address: LINK },
          fromAmount: "1000000",
        },
        estimate: {
          toAmount: "70000000000000000",
          toAmountMin: "69000000000000000",
          toAmountUSD: "0.99",
          executionDuration: 30,
          approvalAddress: LINK,
          gasCosts: [{ amountUSD: "0.10" }],
          feeCosts: [{ amountUSD: "0.01" }],
        },
        transactionRequest: {
          to: LINK,
          data: "0x12",
          value: "0x0",
          gasLimit: "0x5208",
          chainId: 1,
        },
      })) as unknown as typeof fetch;
    const q = await lifi({}, f).quote({ ...req, taker: LINK }, AbortSignal.timeout(1000));
    expect(q.netUsd).toBeCloseTo(0.88);
    expect(q.tx).toMatchObject({ value: "0", gasLimit: "21000" });
  });
});

describe("GET /token (any address)", () => {
  const reader = async (chainId: number, address: `0x${string}`) =>
    address.toLowerCase() === "0x1111111111111111111111111111111111111111"
      ? { chainId, address, symbol: "MEME", name: "Meme", decimals: 9 }
      : null;
  const app = createApp([], { simulator: null, tokenReader: reader });
  it("returns listed BTCB on BNB Chain as verified", async () => {
    const res = await app.request(
      "/token?chainId=56&address=0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c",
    );
    expect(await res.json()).toMatchObject({ symbol: "BTCB", decimals: 18, verified: true });
  });
  it("reads an unlisted token on-chain and flags it unverified", async () => {
    const res = await app.request(
      "/token?chainId=56&address=0x1111111111111111111111111111111111111111",
    );
    expect(await res.json()).toMatchObject({ symbol: "MEME", decimals: 9, verified: false });
  });
  it("404s for a non-token and 400s for a bad address", async () => {
    expect(
      (await app.request("/token?chainId=56&address=0x2222222222222222222222222222222222222222"))
        .status,
    ).toBe(404);
    expect((await app.request("/token?chainId=56&address=nope")).status).toBe(400);
  });
});
