import {
  type BuildResponse,
  BuildResponse as BuildResponseSchema,
  type Chain,
  Chain as ChainSchema,
  type Quote,
  type QuoteRequest,
  type QuotesResponse,
  QuotesResponse as QuotesResponseSchema,
  type StatusRequest,
  type StatusResponse,
  StatusResponse as StatusResponseSchema,
  type Token,
  Token as TokenSchema,
  type TypedData,
  UtxoDeposit,
  UtxoTrack,
} from "@swapchan/shared";
import { z } from "zod";
import { activePartner } from "./embed";
import { mockBuild, mockChains, mockQuotes, mockStatus, mockTokens } from "./mock";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const FORCE_MOCK = process.env.NEXT_PUBLIC_MOCK_API === "1";

export interface ApiResult<T> {
  data: T;
  mocked: boolean;
}

class ApiError extends Error {}

const call = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${API_URL}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new ApiError(msg);
  }
  return schema.parse(body);
};

/** Real API always; mocks only when NEXT_PUBLIC_MOCK_API=1 (demos/tests). */
const withMock = async <T>(real: () => Promise<T>, mock: () => T): Promise<ApiResult<T>> =>
  FORCE_MOCK ? { data: mock(), mocked: true } : { data: await real(), mocked: false };

export const toQuery = (o: Record<string, string | number | undefined>): string =>
  new URLSearchParams(
    Object.entries(o).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
  ).toString();

export const api = {
  chains: (): Promise<ApiResult<Chain[]>> =>
    withMock(() => call("/chains", z.array(ChainSchema)), mockChains),
  tokens: (chainId?: number): Promise<ApiResult<Token[]>> =>
    withMock(
      () => call(`/tokens?${toQuery({ chainId })}`, z.array(TokenSchema)),
      () => mockTokens(chainId),
    ),
  /** Any ERC-20 by address, read on-chain by the API. null = not a token on that chain. */
  token: async (
    chainId: number,
    address: string,
  ): Promise<(Token & { verified: boolean }) | null> => {
    try {
      return await call(
        `/token?${toQuery({ chainId, address })}`,
        TokenSchema.extend({ verified: z.boolean() }),
      );
    } catch {
      return null;
    }
  },
  quotes: (req: QuoteRequest): Promise<ApiResult<QuotesResponse>> =>
    withMock(
      () => call(`/quotes?${toQuery({ ...req, partner: activePartner() })}`, QuotesResponseSchema),
      () => mockQuotes(req),
    ),
  build: (quote: Quote, taker: string, mocked: boolean): Promise<BuildResponse> =>
    mocked
      ? Promise.resolve(mockBuild(quote.id, quote.request.fromChainId))
      : call("/build", BuildResponseSchema, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            quoteId: quote.id,
            strictRoute: true,
            taker,
            ...(quote.request.recipient ? { recipient: quote.request.recipient } : {}),
          }),
        }),
  status: (req: StatusRequest, mocked: boolean): Promise<StatusResponse> =>
    mocked
      ? Promise.resolve(mockStatus(req.txHash))
      : call(`/status?${toQuery({ ...req })}`, StatusResponseSchema),
  /** LTC/DOGE/BCH deposit-address flow (THORChain only). */
  utxoDeposit: (req: QuoteRequest, refund?: string): Promise<UtxoDeposit> =>
    call("/utxo/deposit", UtxoDeposit, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(refund ? { ...req, refund } : req),
    }),
  /** Read-only THORChain progress of an inbound txid. */
  utxoStatus: (txid: string): Promise<UtxoTrack> =>
    call(`/utxo/status?${toQuery({ txid })}`, UtxoTrack),
};

const COW_NETWORK: Record<number, string> = {
  1: "mainnet",
  8453: "base",
  42161: "arbitrum_one",
  137: "polygon",
  56: "bnb",
  43114: "avalanche",
  59144: "linea",
};

/** Submit a signed CoW order (EIP-712). Returns the order UID. */
export async function submitCowOrder(
  chainId: number,
  order: TypedData,
  signature: `0x${string}`,
  from: `0x${string}`,
): Promise<string> {
  const net = COW_NETWORK[chainId];
  if (!net) throw new Error(`CoW not supported on chain ${chainId}`);
  const res = await fetch(`https://api.cow.fi/${net}/api/v1/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...order.message, signature, signingScheme: "eip712", from }),
    signal: AbortSignal.timeout(15_000),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok)
    throw new Error(`CoW: ${(body as { description?: string } | null)?.description ?? res.status}`);
  return body as string;
}

export const cowExplorer = (uid: string) => `https://explorer.cow.fi/orders/${uid}`;
