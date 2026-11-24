import {
  BuildResponse,
  type Chain,
  Chain as ChainSchema,
  type Quote,
  type QuoteRequest,
  QuotesResponse,
  type StatusRequest,
  StatusResponse,
  type Token,
  Token as TokenSchema,
  TypedData,
  UtxoDeposit,
  UtxoTrack,
} from "@swapchan/shared";
import { z } from "zod";
import { currentClientIp } from "./clientctx.js";

/** Error from the SwapChan HTTP API, carrying its status and message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Thin typed client over the frozen HTTP contract in packages/shared/README.md. */
type Rec = Record<string, unknown>;

export class SwapChanApi {
  constructor(
    private readonly baseUrl: string,
    private readonly opts: {
      apiKey?: string | undefined;
      /** SWAPCHAN_INTERNAL_KEY: when set, the caller IP is forwarded to the API with this proof. */
      internalKey?: string | undefined;
      fetch?: FetchFn;
      timeoutMs?: number;
    } = {},
  ) {}

  private async req<T>(
    schema: z.ZodType<T>,
    path: string,
    init?: RequestInit,
    timeoutMs?: number,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (init?.body) headers["content-type"] = "application/json";
    if (this.opts.apiKey) headers["x-api-key"] = this.opts.apiKey;
    const ip = currentClientIp();
    if (ip && this.opts.internalKey) {
      headers["x-swapchan-client-ip"] = ip;
      headers["x-swapchan-internal-key"] = this.opts.internalKey;
    }
    const f = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs ?? this.opts.timeoutMs ?? 20_000),
      });
    } catch (e) {
      throw new ApiError(502, `SwapChan API unreachable: ${(e as Error).message}`);
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      throw new ApiError(502, `SwapChan API returned non-JSON (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const err = body as { error?: string; issues?: unknown } | undefined;
      throw new ApiError(res.status, err?.error ?? `HTTP ${res.status}`, err?.issues);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw new ApiError(
        502,
        `SwapChan API response failed contract validation: ${parsed.error.message}`,
      );
    return parsed.data;
  }

  chains(): Promise<Chain[]> {
    return this.req(z.array(ChainSchema), "/chains");
  }
  tokens(chainId?: number): Promise<Token[]> {
    return this.req(z.array(TokenSchema), chainId ? `/tokens?chainId=${chainId}` : "/tokens");
  }
  /** Any ERC-20 by address (on-chain metadata); null when it isn't a token on that chain. */
  async token(chainId: number, address: string): Promise<(Token & { verified: boolean }) | null> {
    try {
      return await this.req(
        TokenSchema.extend({ verified: z.boolean() }),
        `/token?chainId=${chainId}&address=${address}`,
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }
  quotes(r: QuoteRequest & { partner?: string | undefined }): Promise<QuotesResponse> {
    return this.req(QuotesResponse, `/quotes?${qs(r)}`);
  }
  build(
    quoteId: string,
    taker: string,
    recipient?: string,
    allowForeignRecipient?: boolean,
  ): Promise<BuildResponse> {
    return this.req(BuildResponse, "/build", {
      method: "POST",
      body: JSON.stringify({
        quoteId,
        taker,
        ...(recipient ? { recipient } : {}),
        ...(allowForeignRecipient ? { allowForeignRecipient: true } : {}),
      }),
    });
  }
  /** CoW limit order: typed data to sign (our partnerFee in appData), market reference. */
  limitBuild(body: Record<string, unknown>): Promise<LimitBuildResult> {
    return this.req(LimitBuildResult, "/limit/build", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  paymentQuote(body: Record<string, unknown>) {
    return this.req(z.record(z.string(), z.unknown()), "/payments/quote", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  checkDelegation(body: Record<string, unknown>) {
    return this.req(z.record(z.string(), z.unknown()), "/payments/delegation", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  paymentBuild(body: Record<string, unknown>) {
    return this.req(z.record(z.string(), z.unknown()), "/payments/build", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  paymentSubmit(body: Record<string, unknown>) {
    return this.req(z.record(z.string(), z.unknown()), "/payments/submit", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  paymentStatus(hash: string) {
    return this.req(
      z.record(z.string(), z.unknown()),
      "/payments/status/" + encodeURIComponent(hash),
    );
  }
  limitOrders(chainId: number, owner: string): Promise<Record<string, unknown>[]> {
    return this.req(
      z.array(z.record(z.string(), z.unknown())),
      `/limit/orders?${qs({ chainId, owner })}`,
    );
  }
  limitCancelData(chainId: number, uid: string): Promise<TypedData> {
    return this.req(TypedData, `/limit/cancel?${qs({ chainId, uid })}`);
  }
  /** Memecoin scanner list: new | trending | movers. */
  scan(kind: "new" | "trending" | "movers", q: Record<string, unknown>): Promise<ScanResponse> {
    return this.req(ScanResponse, `/scanner/${kind}?${qs(q)}`);
  }
  /** Pure developer tool (blocktools wasm) on public input: POST /tools/:fn. */
  devTool(fn: string, input: Record<string, unknown>): Promise<Rec> {
    return this.rec(`/tools/${encodeURIComponent(fn)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  /** Read/Write Contract: ABI + functions (GET unless an ABI is pasted). */
  contractAbi(b: Record<string, unknown>): Promise<Rec> {
    return b.abi
      ? this.rec(
          "/contract-tool/abi",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(b),
          },
          30_000,
        )
      : this.rec(
          `/contract-tool/abi?${qs({ chainId: String(b.chainId), address: String(b.address) })}`,
          undefined,
          30_000,
        );
  }
  contractRead(b: Record<string, unknown>): Promise<Rec> {
    return this.rec(
      "/contract-tool/read",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) },
      30_000,
    );
  }
  contractEncode(b: Record<string, unknown>): Promise<Rec> {
    return this.rec(
      "/contract-tool/encode",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) },
      30_000,
    );
  }
  contractApprove(b: Record<string, unknown>): Promise<Rec> {
    return this.rec(
      "/contract-tool/approve",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) },
      30_000,
    );
  }
  contractCreate(b: Record<string, unknown>): Promise<Rec> {
    return this.rec(
      "/contract-tool/create",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) },
      30_000,
    );
  }
  private rec(path: string, init?: RequestInit, timeoutMs?: number): Promise<Rec> {
    return this.req(z.record(z.string(), z.unknown()), path, init, timeoutMs);
  }
  walletBalances(address: string, chains?: string): Promise<Rec> {
    return this.rec(`/onchain/balances?${qs({ address, ...(chains ? { chains } : {}) })}`);
  }
  approvals(owner: string, chainId: string): Promise<Rec> {
    return this.rec(`/onchain/approvals?${qs({ owner, chainId })}`);
  }
  revokeTx(chainId: string, token: string, spender: string): Promise<Rec> {
    return this.rec(`/onchain/revoke?${qs({ chainId, token, spender })}`);
  }
  explainTx(chainId: string, hash: string): Promise<Rec> {
    return this.rec(`/onchain/tx?${qs({ chainId, hash })}`);
  }
  gas(chains?: string): Promise<Rec> {
    return this.rec(`/onchain/gas${chains ? `?${qs({ chains })}` : ""}`);
  }
  tokenInfo(chainId: string, address: string): Promise<Rec> {
    return this.rec(`/onchain/token?${qs({ chainId, address })}`);
  }
  resolveName(q: string): Promise<Rec> {
    return this.rec(`/onchain/name?${qs({ q })}`);
  }
  priceHistory(coin: string, at: number, span?: number): Promise<Rec> {
    return this.rec(
      `/onchain/price-history?${qs({ coin, at: String(at), ...(span ? { span: String(span) } : {}) })}`,
    );
  }
  yields(p: Record<string, string>): Promise<Rec> {
    return this.rec(`/onchain/yields?${qs(p)}`);
  }
  watch(watchId: string, items: unknown[]): Promise<Rec> {
    return this.rec("/onchain/watches", {
      method: "POST",
      body: JSON.stringify({ watchId, items }),
    });
  }
  listWatches(watchId: string): Promise<Rec> {
    return this.rec(`/onchain/watches/${encodeURIComponent(watchId)}`);
  }
  checkWatches(watchId: string): Promise<Rec> {
    return this.rec(`/onchain/watches/${encodeURIComponent(watchId)}/check`);
  }
  unwatch(watchId: string, itemId?: string): Promise<Rec> {
    return this.rec(
      `/onchain/watches/${encodeURIComponent(watchId)}${itemId ? `/${encodeURIComponent(itemId)}` : ""}`,
      { method: "DELETE" },
    );
  }
  // v0.3 DeFi toolbox (free sources; logic in apps/api/src/intel.ts)
  simulate(body: Rec): Promise<Rec> {
    return this.rec("/onchain/simulate", { method: "POST", body: JSON.stringify(body) });
  }
  walletHistory(address: string, chainId?: string): Promise<Rec> {
    return this.rec(`/onchain/history?${qs({ address, chainId })}`, undefined, 90_000);
  }
  walletPnl(address: string, chainId?: string): Promise<Rec> {
    return this.rec(`/onchain/pnl?${qs({ address, chainId })}`, undefined, 90_000);
  }
  tokenPools(chainId: string, address: string): Promise<Rec> {
    return this.rec(`/onchain/pools?${qs({ chainId, address })}`);
  }
  whales(chainId: string, address: string, minUsd?: number): Promise<Rec> {
    return this.rec(`/onchain/whales?${qs({ chainId, address, minUsd })}`, undefined, 90_000);
  }
  contract(chainId: string, address: string): Promise<Rec> {
    return this.rec(`/onchain/contract?${qs({ chainId, address })}`);
  }
  airdrops(address: string): Promise<Rec> {
    return this.rec(`/onchain/airdrops?${qs({ address })}`, undefined, 90_000);
  }
  market(): Promise<Rec> {
    return this.rec("/onchain/market", undefined, 90_000);
  }
  rebalance(body: Rec): Promise<Rec> {
    return this.rec("/onchain/rebalance", { method: "POST", body: JSON.stringify(body) }, 90_000);
  }
  bridge(hash: string, fromChainId?: string): Promise<Rec> {
    return this.rec(`/onchain/bridge?${qs({ hash, fromChainId })}`, undefined, 90_000);
  }
  gasHistory(chainId: string): Promise<Rec> {
    return this.rec(`/onchain/gas/history?${qs({ chainId })}`);
  }
  findMoney(address: string, fresh?: boolean): Promise<Rec> {
    return this.rec(
      `/onchain/money?${qs({ address, fresh: fresh ? "1" : undefined })}`,
      undefined,
      90_000,
    );
  }
  readChain(body: Rec): Promise<Rec> {
    return this.rec("/onchain/read-chain", { method: "POST", body: JSON.stringify(body) }, 60_000);
  }
  findMoneyBatch(
    addresses: string | (string | { address: string; label?: string })[],
  ): Promise<Rec> {
    return this.rec(
      "/onchain/money/batch",
      { method: "POST", body: JSON.stringify({ addresses }) },
      30_000,
    );
  }
  findMoneyStatus(jobId: string): Promise<Rec> {
    return this.rec(`/onchain/money/batch/${encodeURIComponent(jobId)}`);
  }
  verifyTx(body: Rec): Promise<Rec> {
    return this.rec("/onchain/verify-tx", { method: "POST", body: JSON.stringify(body) }, 60_000);
  }
  buildSend(body: Rec): Promise<Rec> {
    return this.rec("/send", { method: "POST", body: JSON.stringify(body) }, 60_000);
  }
  broadcastTx(body: Rec): Promise<Rec> {
    return this.rec("/onchain/broadcast", { method: "POST", body: JSON.stringify(body) }, 60_000);
  }
  txStatus(chainId: string, hash: string): Promise<Rec> {
    return this.rec(`/onchain/tx-status?${qs({ chainId, hash })}`);
  }
  signingGuide(chain?: string, situation?: string): Promise<Rec> {
    return this.rec(`/onchain/signing-guide?${qs({ chain, situation })}`);
  }
  recoveryGuide(situation?: string): Promise<Rec> {
    return this.rec(`/onchain/recovery-guide?${qs({ situation })}`);
  }
  swapLink(p: Rec): Promise<Rec> {
    return this.rec(`/links/swap?${qs(p)}`);
  }
  batchLink(items: Rec[], ref?: string): Promise<Rec> {
    return this.rec("/links", {
      method: "POST",
      body: JSON.stringify({ items, ...(ref ? { ref } : {}) }),
    });
  }
  tokenRisk(chain: string, address: string): Promise<Record<string, unknown>> {
    return this.req(z.record(z.string(), z.unknown()), `/scanner/risk?${qs({ chain, address })}`);
  }
  status(r: StatusRequest): Promise<StatusResponse> {
    return this.req(StatusResponse, `/status?${qs(r)}`);
  }
  /** LTC/DOGE/BCH -> anything via THORChain: vault, exact amount, required memo, minimum, expiry. */
  utxoDeposit(r: QuoteRequest, refund?: string): Promise<UtxoDeposit> {
    return this.req(UtxoDeposit, "/utxo/deposit", {
      method: "POST",
      body: JSON.stringify(refund ? { ...r, refund } : r),
    });
  }
  /** Read-only THORChain progress of an inbound txid. */
  utxoStatus(txid: string): Promise<UtxoTrack> {
    return this.req(UtxoTrack, `/utxo/status?${qs({ txid })}`);
  }
}

const qs = (o: Record<string, unknown>): string =>
  new URLSearchParams(
    Object.entries(o)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)]),
  ).toString();

export type { Quote };

export const LimitBuildResult = z.object({
  order: TypedData,
  appData: z.string(),
  appDataHash: z.string(),
  approvalAddress: z.string(),
  partnerFee: z.object({ volumeBps: z.number(), recipient: z.string() }).nullable(),
  market: z.object({ buyAmount: z.string() }).nullable(),
});
export type LimitBuildResult = z.infer<typeof LimitBuildResult>;
export const ScanToken = z.looseObject({
  chain: z.string(),
  chainId: z.number(),
  address: z.string(),
  symbol: z.string(),
  name: z.string(),
  swapUrl: z.string(),
  risk: z.object({ level: z.string(), flags: z.array(z.string()) }),
});
export const ScanResponse = z.looseObject({
  tokens: z.array(ScanToken),
  updatedAt: z.string(),
  disclaimer: z.string(),
});
export type ScanResponse = z.infer<typeof ScanResponse>;
