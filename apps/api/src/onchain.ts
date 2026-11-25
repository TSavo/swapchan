import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  BITCOIN,
  isVmAddress,
  NATIVE_TOKEN,
  NON_EVM,
  SOLANA,
  SUPPORTED_CHAINS,
  TRON,
  tokenList,
  vmOf,
} from "@swapchan/shared";
import { Hono } from "hono";
import {
  createPublicClient,
  decodeEventLog,
  erc20Abi,
  fallback,
  formatUnits,
  getAddress,
  http,
  isAddress,
  maxUint256,
  type PublicClient,
  parseAbiItem,
} from "viem";
import { normalize } from "viem/ens";
import { z } from "zod";
import {
  blocktools,
  btB58Decode,
  btB58Encode,
  btSolOnCurve,
  btSolPda,
  encodeFunctionData,
} from "./blocktools.js";
import { verifyRevoke } from "./guard/index.js";
import { cached, SCAN_CHAINS, type ScanChain, tokenRisk } from "./scanner.js";
import { CHAINS } from "./simulate.js";

/**
 * Free on-chain readers for agents (no paid keys): wallet balances, approvals, tx explainer, gas,
 * token info, name resolution, yields and pull-based watchlists. Every upstream call is cached.
 * Sources: public RPCs (publicnode + viem defaults, RPC_URL_<id> overrides), DefiLlama coins/yields,
 * GoPlus, Ethplorer freekey, Routescan, mempool.space, TronGrid, Solana public RPC, DexScreener.
 */
type F = typeof fetch;
export const SITE = "https://swapchan.com";
export const EVM_IDS = [1, 8453, 42161, 10, 137, 56, 43114, 59144, 534352];
export const ALL_IDS = [...EVM_IDS, SOLANA, BITCOIN, TRON];
export const PUBLIC_RPC: Record<number, string> = {
  1: "https://ethereum-rpc.publicnode.com",
  8453: "https://base-rpc.publicnode.com",
  42161: "https://arbitrum-one-rpc.publicnode.com",
  10: "https://optimism-rpc.publicnode.com",
  137: "https://polygon-bor-rpc.publicnode.com",
  56: "https://bsc-rpc.publicnode.com",
  43114: "https://avalanche-c-chain-rpc.publicnode.com",
  59144: "https://linea-rpc.publicnode.com",
  534352: "https://scroll-rpc.publicnode.com",
};
export const LLAMA: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  42161: "arbitrum",
  10: "optimism",
  137: "polygon",
  56: "bsc",
  43114: "avax",
  59144: "linea",
  534352: "scroll",
  [SOLANA]: "solana",
  [TRON]: "tron",
  [BITCOIN]: "bitcoin",
};
const NATIVE_GECKO: Record<number, string> = {
  1: "ethereum",
  8453: "ethereum",
  42161: "ethereum",
  10: "ethereum",
  137: "polygon-ecosystem-token",
  56: "binancecoin",
  43114: "avalanche-2",
  59144: "ethereum",
  534352: "ethereum",
  [SOLANA]: "solana",
  [BITCOIN]: "bitcoin",
  [TRON]: "tron",
};
export const NATIVE_SYMBOL: Record<number, string> = {
  1: "ETH",
  8453: "ETH",
  42161: "ETH",
  10: "ETH",
  137: "POL",
  56: "BNB",
  43114: "AVAX",
  59144: "ETH",
  534352: "ETH",
  [SOLANA]: "SOL",
  [BITCOIN]: "BTC",
  [TRON]: "TRX",
};
export const EXPLORER: Record<number, string> = {
  1: "https://etherscan.io",
  8453: "https://basescan.org",
  42161: "https://arbiscan.io",
  10: "https://optimistic.etherscan.io",
  137: "https://polygonscan.com",
  56: "https://bscscan.com",
  43114: "https://snowtrace.io",
  59144: "https://lineascan.build",
  534352: "https://scrollscan.com",
  [SOLANA]: "https://solscan.io",
  [BITCOIN]: "https://mempool.space",
  [TRON]: "https://tronscan.org/#",
};
export const chainName = (id: number) =>
  (SUPPORTED_CHAINS as Record<number, { name: string }>)[id]?.name ?? String(id);
export const CHAIN_ALIASES: Record<string, number> = {
  ethereum: 1,
  eth: 1,
  mainnet: 1,
  base: 8453,
  arbitrum: 42161,
  arb: 42161,
  optimism: 10,
  op: 10,
  polygon: 137,
  matic: 137,
  bnb: 56,
  bsc: 56,
  avalanche: 43114,
  avax: 43114,
  linea: 59144,
  scroll: 534352,
  solana: SOLANA,
  sol: SOLANA,
  bitcoin: BITCOIN,
  btc: BITCOIN,
  tron: TRON,
  trx: TRON,
};
export class BadRequest extends Error {}
export const chainOf = (v: string | number): number => {
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isInteger(n) && ALL_IDS.includes(n)) return n;
  const a = CHAIN_ALIASES[String(v).toLowerCase()];
  if (a) return a;
  throw new BadRequest(`unsupported chain ${v}; use one of ${ALL_IDS.join(", ")} or a name`);
};

export function swapUrl(
  fromChainId: number,
  fromToken: string,
  toChainId: number,
  toToken: string,
  amount?: string,
) {
  const q = new URLSearchParams({
    fromChain: String(fromChainId),
    toChain: String(toChainId),
    fromToken,
    toToken,
    ...(amount ? { amount } : {}),
  });
  return `${SITE}/?${q}`;
}
export const listed = (chainId: number) => tokenList.filter((t) => t.chainId === chainId);
export const usdcOf = (chainId: number) =>
  listed(chainId).find((t) => t.symbol === "USDC")?.address ??
  listed(chainId).find((t) => t.symbol === "USDT")?.address;
export const STABLES = new Set([
  "USDC",
  "USDT",
  "DAI",
  "USDC.E",
  "USDBC",
  "USDE",
  "FDUSD",
  "PYUSD",
  "USD1",
  "USDS",
  "USDT0",
  "FRAX",
  "LUSD",
  "GHO",
  "USDD",
]);

export async function json<T>(
  f: F,
  url: string,
  init?: RequestInit,
  timeoutMs = 10_000,
): Promise<T> {
  const r = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return (await r.json()) as T;
}

const clients = new Map<number, PublicClient>();
export function evmClient(chainId: number, env: NodeJS.ProcessEnv = process.env): PublicClient {
  const hit = clients.get(chainId);
  if (hit) return hit;
  const chain = CHAINS[chainId];
  if (!chain) throw new BadRequest(`not an EVM chain: ${chainId}`);
  const urls = [
    env[`RPC_URL_${chainId}`],
    PUBLIC_RPC[chainId],
    chain.rpcUrls.default.http[0],
  ].filter((u): u is string => !!u);
  const c = createPublicClient({
    chain,
    // viem's default multicall chunk is 1024 calldata bytes (~28 calls), so one find_money scan sent ~310 aggregate3
    // requests to the Ethereum RPC (129 in flight at peak). 8192 bytes: 4 parallel local scans went from 247-396
    // Ethereum RPC requests (peak 43-149) to 134-167 (peak ~37), with no new call failures.
    batch: { multicall: { batchSize: Number(env.EVM_MULTICALL_BATCH_BYTES ?? 8192) } },
    transport: fallback(urls.map((u) => http(u, { timeout: 10_000, retryCount: 1 }))),
  }) as PublicClient;
  clients.set(chainId, c);
  return c;
}

export async function solRpc<T>(
  f: F,
  env: NodeJS.ProcessEnv,
  method: string,
  params: unknown[],
): Promise<T> {
  const urls = [
    env.SOLANA_RPC_URL,
    "https://api.mainnet-beta.solana.com",
    "https://solana-rpc.publicnode.com",
  ].filter((u): u is string => !!u);
  const errs: string[] = [];
  for (const u of urls) {
    try {
      const r = await json<{ result?: T; error?: { message: string } }>(f, u, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (r.error) throw new Error(r.error.message);
      return r.result as T;
    } catch (e) {
      errs.push(`${new URL(u).host}: ${(e as Error).message}`);
    }
  }
  throw new Error(`solana rpc failed (${errs.join("; ")})`);
}

// ---------- prices (DefiLlama coins, batched, 60s cache) ----------
export interface Px {
  price: number;
  symbol?: string;
  decimals?: number;
}
export const isNativeAddr = (chainId: number, a: string) =>
  NON_EVM[chainId]?.native === a ||
  a.toLowerCase() === NATIVE_TOKEN.toLowerCase() ||
  a === "0x0000000000000000000000000000000000000000";
export const llamaId = (chainId: number, a: string) =>
  isNativeAddr(chainId, a)
    ? `coingecko:${NATIVE_GECKO[chainId]}`
    : `${LLAMA[chainId]}:${vmOf(chainId) === "evm" ? a.toLowerCase() : a}`;
/** Only BTC wrappers legitimately trade above $15k per token. Anything else that high (e.g. HAY at $50k), anything
 *  over $1M, or a low-confidence quote is dropped: amount still shown, USD left unpriced and flagged unverified. */
const HIGH_OK = /BTC|^SATS?$/i;
export function sanePx<T extends { price?: number; symbol?: string; confidence?: number }>(
  v: T,
): T & { unverified?: true } {
  const p = v.price;
  if (p === undefined) return v;
  const absurd =
    !Number.isFinite(p) ||
    p < 0 ||
    p > 1_000_000 ||
    (p > 15_000 && !HIGH_OK.test(v.symbol ?? "")) ||
    (v.confidence !== undefined && v.confidence < 0.5);
  if (!absurd) return v;
  const { price: _drop, ...rest } = v;
  return { ...(rest as T), unverified: true };
}
export async function prices(
  f: F,
  items: { chainId: number; address: string }[],
): Promise<Map<string, Px>> {
  const ids = [...new Set(items.map((i) => llamaId(i.chainId, i.address)))];
  const out = new Map<string, Px>();
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80).sort();
    const key = chunk.join(",");
    const r = await cached(`llama:${key}`, 60_000, () =>
      json<{ coins: Record<string, Px> }>(
        f,
        `https://coins.llama.fi/prices/current/${encodeURIComponent(key)}`,
      ),
    ).catch(() => ({ coins: {} as Record<string, Px> }));
    for (const [k, v] of Object.entries(r.coins)) out.set(k, sanePx(v));
  }
  return out;
}
export const pxOf = (m: Map<string, Px>, chainId: number, a: string) => m.get(llamaId(chainId, a));
const fmt = (n: string | number) => {
  const x = Number(n);
  return x === 0
    ? "0"
    : Math.abs(x) >= 1
      ? x.toLocaleString("en-US", { maximumFractionDigits: 4 })
      : x.toPrecision(4);
};

// ---------- 1. balances ----------
export interface Holding {
  chainId: number;
  chain: string;
  address: string;
  symbol: string;
  name?: string | undefined;
  balance: string;
  priceUsd: number | null;
  valueUsd: number | null;
  listed: boolean;
}
type RawHolding = Omit<Holding, "priceUsd" | "valueUsd">;
// Alchemy network slugs for alchemy_getTokenBalances — how we discover UNLISTED ERC-20s the wallet
// holds (the listed set alone misses them). This is what Alchemy was wired for.
const ALCHEMY_BAL_NET: Record<number, string> = {
  1: "eth-mainnet",
  10: "opt-mainnet",
  56: "bnb-mainnet",
  137: "polygon-mainnet",
  42161: "arb-mainnet",
  8453: "base-mainnet",
  43114: "avax-mainnet",
  59144: "linea-mainnet",
  534352: "scroll-mainnet",
};
/** Contract addresses of every ERC-20 the owner holds a non-zero balance of, via Alchemy
 *  alchemy_getTokenBalances. Empty when there is no Alchemy key or the chain is unsupported. */
async function alchemyTokenContracts(
  f: F,
  env: NodeJS.ProcessEnv,
  chainId: number,
  owner: string,
): Promise<string[]> {
  const net = ALCHEMY_BAL_NET[chainId];
  const key = env.ALCHEMY_API_KEY;
  if (!net || !key) return [];
  try {
    const r = await f(`https://${net}.g.alchemy.com/v2/${key}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "alchemy_getTokenBalances",
        params: [owner, "erc20"],
      }),
      signal: AbortSignal.timeout(8000),
    });
    const j = (await r.json()) as {
      result?: { tokenBalances?: { contractAddress: string; tokenBalance: string | null }[] };
    };
    return (j.result?.tokenBalances ?? [])
      .filter((b) => {
        try {
          return b.tokenBalance != null && BigInt(b.tokenBalance) > 0n;
        } catch {
          return false;
        }
      })
      .map((b) => b.contractAddress.toLowerCase());
  } catch {
    return [];
  }
}

async function evmHoldings(
  f: F,
  env: NodeJS.ProcessEnv,
  chainId: number,
  owner: `0x${string}`,
): Promise<RawHolding[]> {
  const c = evmClient(chainId, env);
  const toks = listed(chainId).filter((t) => !isNativeAddr(chainId, t.address));
  const [native, res, discovered] = await Promise.all([
    c.getBalance({ address: owner }),
    c.multicall({
      allowFailure: true,
      contracts: toks.map((t) => ({
        address: t.address as `0x${string}`,
        abi: erc20Abi,
        functionName: "balanceOf" as const,
        args: [owner] as const,
      })),
    }),
    alchemyTokenContracts(f, env, chainId, owner),
  ]);
  const out: RawHolding[] = [];
  if (native > 0n)
    out.push({
      chainId,
      chain: chainName(chainId),
      address: NATIVE_TOKEN,
      symbol: NATIVE_SYMBOL[chainId] ?? "ETH",
      balance: formatUnits(native, 18),
      listed: true,
    });
  res.forEach((r, i) => {
    const t = toks[i];
    if (t && r.status === "success" && (r.result as bigint) > 0n)
      out.push({
        chainId,
        chain: chainName(chainId),
        address: t.address,
        symbol: t.symbol,
        name: t.name,
        balance: formatUnits(r.result as bigint, t.decimals),
        listed: true,
      });
  });
  // UNLISTED ERC-20s the wallet holds (Base/BNB/etc.): read balance + decimals + symbol for each
  // contract Alchemy reported but the listed set does not cover, and add it (listed: false). Pricing
  // (defillama by contract) and the spam/dust filter in walletBalances handle them from here.
  const known = new Set(toks.map((t) => t.address.toLowerCase()));
  const extra = discovered.filter((a) => !known.has(a) && !isNativeAddr(chainId, a));
  if (extra.length) {
    const meta = await c.multicall({
      allowFailure: true,
      contracts: extra.flatMap((addr) => [
        {
          address: addr as `0x${string}`,
          abi: erc20Abi,
          functionName: "balanceOf" as const,
          args: [owner] as const,
        },
        { address: addr as `0x${string}`, abi: erc20Abi, functionName: "decimals" as const },
        { address: addr as `0x${string}`, abi: erc20Abi, functionName: "symbol" as const },
      ]),
    });
    extra.forEach((addr, i) => {
      const bal = meta[i * 3];
      const dec = meta[i * 3 + 1];
      const sym = meta[i * 3 + 2];
      if (bal?.status === "success" && (bal.result as bigint) > 0n) {
        const decimals = dec?.status === "success" ? Number(dec.result) : 18;
        out.push({
          chainId,
          chain: chainName(chainId),
          address: addr,
          symbol: sym?.status === "success" ? String(sym.result) : "?",
          balance: formatUnits(bal.result as bigint, decimals),
          listed: false,
        });
      }
    });
  }
  return out;
}
const SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SPL22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
type SplAcct = {
  account: {
    data: {
      parsed: { info: { mint: string; tokenAmount: { uiAmountString: string; amount: string } } };
    };
  };
};
async function solHoldings(f: F, env: NodeJS.ProcessEnv, owner: string): Promise<RawHolding[]> {
  // sequential: public Solana RPCs rate-limit bursts
  const lamports = await solRpc<{ value: number }>(f, env, "getBalance", [owner]);
  const a1 = await solRpc<{ value: SplAcct[] }>(f, env, "getTokenAccountsByOwner", [
    owner,
    { programId: SPL },
    { encoding: "jsonParsed" },
  ]);
  const a2 = await solRpc<{ value: SplAcct[] }>(f, env, "getTokenAccountsByOwner", [
    owner,
    { programId: SPL22 },
    { encoding: "jsonParsed" },
  ]);
  const out: RawHolding[] = [];
  const SOLN = NON_EVM[SOLANA]!.native;
  if (lamports.value > 0)
    out.push({
      chainId: SOLANA,
      chain: "Solana",
      address: SOLN,
      symbol: "SOL",
      balance: String(lamports.value / 1e9),
      listed: true,
    });
  const byMint = new Map<string, number>();
  for (const a of [...(a1 as { value: SplAcct[] }).value, ...(a2 as { value: SplAcct[] }).value]) {
    const i = a.account.data.parsed.info;
    if (i.tokenAmount.amount === "0") continue;
    byMint.set(i.mint, (byMint.get(i.mint) ?? 0) + Number(i.tokenAmount.uiAmountString));
  }
  for (const [mint, amt] of byMint) {
    const t = listed(SOLANA).find((x) => x.address === mint);
    out.push({
      chainId: SOLANA,
      chain: "Solana",
      address: mint,
      symbol: t?.symbol ?? "?",
      name: t?.name,
      balance: String(amt),
      listed: !!t,
    });
  }
  return out;
}
async function btcHoldings(f: F, owner: string): Promise<RawHolding[]> {
  type S = { funded_txo_sum: number; spent_txo_sum: number };
  const r = await json<{ chain_stats: S; mempool_stats: S }>(
    f,
    `https://mempool.space/api/address/${owner}`,
  );
  const sats =
    r.chain_stats.funded_txo_sum -
    r.chain_stats.spent_txo_sum +
    r.mempool_stats.funded_txo_sum -
    r.mempool_stats.spent_txo_sum;
  return sats > 0
    ? [
        {
          chainId: BITCOIN,
          chain: "Bitcoin",
          address: NON_EVM[BITCOIN]!.native,
          symbol: "BTC",
          balance: String(sats / 1e8),
          listed: true,
        },
      ]
    : [];
}
async function tronHoldings(f: F, owner: string): Promise<RawHolding[]> {
  const r = await json<{ data: { balance?: number; trc20?: Record<string, string>[] }[] }>(
    f,
    `https://api.trongrid.io/v1/accounts/${owner}`,
  );
  const a = r.data[0];
  if (!a) return [];
  const out: RawHolding[] = [];
  if (a.balance)
    out.push({
      chainId: TRON,
      chain: "Tron",
      address: NON_EVM[TRON]!.native,
      symbol: "TRX",
      balance: String(a.balance / 1e6),
      listed: true,
    });
  for (const kv of a.trc20 ?? [])
    for (const [contract, raw] of Object.entries(kv)) {
      if (raw === "0") continue;
      const t = listed(TRON).find((x) => x.address === contract);
      out.push({
        chainId: TRON,
        chain: "Tron",
        address: contract,
        symbol: t?.symbol ?? "?",
        name: t?.name,
        balance: t ? formatUnits(BigInt(raw), t.decimals) : raw,
        listed: !!t,
      });
    }
  return out;
}

export async function walletBalances(
  f: F,
  env: NodeJS.ProcessEnv,
  address: string,
  chains?: number[],
) {
  const vm = (["evm", "tvm", "bvm", "svm"] as const).find((v) => isVmAddress(address, v));
  if (!vm) throw new BadRequest("not an EVM, Solana, Bitcoin or Tron address");
  const want = (chains?.length ? chains : ALL_IDS).filter((id) => vmOf(id) === vm);
  if (!want.length)
    throw new BadRequest(`address is a ${vm} address; none of the requested chains match`);
  const errors: { chainId: number; error: string }[] = [];
  const parts = await Promise.all(
    want.map(async (id) => {
      try {
        return await cached(`bal:${id}:${address}`, 30_000, () =>
          vm === "evm"
            ? evmHoldings(f, env, id, getAddress(address))
            : vm === "svm"
              ? solHoldings(f, env, address)
              : vm === "bvm"
                ? btcHoldings(f, address)
                : tronHoldings(f, address),
        );
      } catch (e) {
        errors.push({ chainId: id, error: (e as Error).message.slice(0, 160) });
        return [];
      }
    }),
  );
  const raw = parts.flat();
  const px = await prices(f, raw);
  let holdings: Holding[] = raw.map((h) => {
    const p = pxOf(px, h.chainId, h.address);
    const symbol = h.symbol === "?" && p?.symbol ? p.symbol : h.symbol;
    let balance = h.balance;
    if (h.chainId === TRON && !h.listed)
      balance = p?.decimals !== undefined ? formatUnits(BigInt(h.balance), p.decimals) : h.balance;
    const priceUsd = p?.price ?? null;
    const valueUsd =
      priceUsd === null || (h.chainId === TRON && !h.listed && p?.decimals === undefined)
        ? null
        : Number(balance) * priceUsd;
    return { ...h, symbol, balance, priceUsd, valueUsd };
  });
  // Unpriced unlisted tokens are usually airdropped spam; hide them and sub-cent dust.
  const hiddenSpamOrDust = holdings.filter(
    (h) => !h.listed && (h.valueUsd === null || h.valueUsd < 0.01),
  ).length;
  holdings = holdings.filter((h) => h.listed || (h.valueUsd !== null && h.valueUsd >= 0.01));
  holdings.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
  const totalUsd = holdings.reduce((s, h) => s + (h.valueUsd ?? 0), 0);
  const byChain: Record<string, number> = {};
  for (const h of holdings) byChain[h.chain] = (byChain[h.chain] ?? 0) + (h.valueUsd ?? 0);
  const suggestions: { action: string; swapUrl: string }[] = [];
  const volatile = holdings.find(
    (h) =>
      (h.valueUsd ?? 0) > 5 &&
      !STABLES.has(h.symbol.toUpperCase()) &&
      !isNativeAddr(h.chainId, h.address),
  );
  const vUsdc = volatile && usdcOf(volatile.chainId);
  if (volatile && vUsdc)
    suggestions.push({
      action: `De-risk: swap ${volatile.symbol} on ${volatile.chain} to USDC`,
      swapUrl: swapUrl(
        volatile.chainId,
        volatile.address,
        volatile.chainId,
        vUsdc,
        volatile.balance,
      ),
    });
  for (const id of new Set(holdings.map((h) => h.chainId))) {
    const native = holdings.find((h) => h.chainId === id && isNativeAddr(id, h.address));
    const other = holdings.find(
      (h) => h.chainId === id && !isNativeAddr(id, h.address) && (h.valueUsd ?? 0) > 5,
    );
    if (other && (!native || (native.valueUsd ?? 0) < 1))
      suggestions.push({
        action: `Low gas on ${chainName(id)}: swap a little ${other.symbol} to ${NATIVE_SYMBOL[id]} so the wallet can transact`,
        swapUrl: swapUrl(id, other.address, id, NON_EVM[id]?.native ?? NATIVE_TOKEN),
      });
  }
  const stable = holdings.find(
    (h) => STABLES.has(h.symbol.toUpperCase()) && (h.valueUsd ?? 0) > 10,
  );
  if (stable) {
    const dest = stable.chainId === 8453 ? 42161 : 8453;
    suggestions.push({
      action: `Idle ${stable.symbol} on ${stable.chain}: look at get_yields for stablecoin yield, or bridge to ${chainName(dest)}`,
      swapUrl: swapUrl(
        stable.chainId,
        stable.address,
        dest,
        usdcOf(dest) ?? NATIVE_TOKEN,
        stable.balance,
      ),
    });
  }
  if (!holdings.length)
    suggestions.push({
      action: "Empty wallet: fund it by bridging from another chain on SwapChan",
      swapUrl: SITE,
    });
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    address,
    vm,
    chainsChecked: want.map(chainName),
    totalUsd: r2(totalUsd),
    byChainUsd: Object.fromEntries(Object.entries(byChain).map(([k, v]) => [k, r2(v)])),
    holdings: holdings
      .slice(0, 100)
      .map((h) => ({ ...h, valueUsd: h.valueUsd === null ? null : r2(h.valueUsd) })),
    hiddenSpamOrDust,
    suggestions: suggestions.slice(0, 4),
    errors,
    coverage:
      vm === "evm"
        ? `EVM: native + SwapChan's listed tokens on each chain (multicall on public RPCs)${env.ALCHEMY_API_KEY ? ", plus every unlisted ERC-20 the wallet holds (Alchemy getTokenBalances; unpriced ones hidden as spam/dust)" : ". Unlisted ERC-20s are not discovered (no Alchemy key)"}.`
        : vm === "svm"
          ? "Solana: SOL + every SPL / Token-2022 account (unpriced unknown tokens hidden)."
          : vm === "bvm"
            ? "Bitcoin: confirmed + mempool balance of this single address (not an xpub)."
            : "Tron: TRX + all TRC-20 balances from TronGrid.",
    sources: [
      vm === "evm"
        ? "public RPC multicall"
        : vm === "svm"
          ? "Solana RPC"
          : vm === "bvm"
            ? "mempool.space"
            : "TronGrid",
      "DefiLlama prices",
    ],
  };
}

import { KNOWN_ONLY_NOTE, knownSpenderAllowances, spendersFor } from "./knownspenders.js";

// ---------- 2. approvals ----------
const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ROUTESCAN = new Set([1, 43114]);
/** Free Etherscan-compatible explorers that serve getLogs without a key. */
const APPROVAL_EXPLORER: Record<number, string[]> = {
  10: ["https://optimism.blockscout.com/api", "https://explorer.optimism.io/api"],
  59144: ["https://api-explorer.linea.build/api"],
};
/** Chains the free Etherscan v2 tier serves (OP, Base, BSC, Avalanche are paid-only; Scroll unsupported). */
export const ETHERSCAN_FREE = new Set([1, 137, 42161, 59144]);
/** Public RPCs that answer a full-range topic-filtered eth_getLogs. */
const FULL_RANGE_LOG_RPC: Record<number, string> = {
  534352: "https://rpc.scroll.io",
  10: "https://mainnet.optimism.io",
};
type SpenderInfo = {
  contract_name?: string | null;
  tag?: string | null;
  is_contract?: number;
  doubt_list?: number;
  malicious_behavior?: string[];
  is_open_source?: number;
};
interface GpApproval {
  token_address: string;
  token_symbol: string;
  decimals: number;
  malicious_address: number;
  approved_list: {
    approved_contract: string;
    approved_time: number;
    hash: string;
    address_info?: SpenderInfo;
  }[];
}
export function revokeTx(chain: number | string, token: string, spender: string) {
  const chainId = String(chain) === "84532" ? 84532 : chainOf(chain);
  if (chainId !== 84532 && !CHAINS[chainId]) throw new BadRequest("revoke is EVM-only");
  if (!isAddress(token) || !isAddress(spender))
    throw new BadRequest("token and spender must be EVM addresses");
  const tx = {
    chainId,
    to: getAddress(token),
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [getAddress(spender), 0n],
    }),
    value: "0",
  };
  verifyRevoke(tx, token, spender);
  return {
    ...tx,
    verified: true,
    description: `approve(${getAddress(spender)}, 0) on token ${getAddress(token)}: removes the allowance`,
  };
}
export async function approvals(f: F, env: NodeJS.ProcessEnv, owner: string, chainId: number) {
  if (!CHAINS[chainId]) throw new BadRequest("approvals are EVM-only (ERC-20 allowances)");
  if (!isAddress(owner)) throw new BadRequest("owner must be an EVM address");
  const o = getAddress(owner);
  type Pair = {
    token: string;
    spender: string;
    time?: number;
    hash?: string;
    info?: SpenderInfo;
    symbol?: string;
    decimals?: number;
    tokenMalicious?: boolean;
  };
  const pairs = new Map<string, Pair>();
  const sources: string[] = [];
  const gp = await cached(`gpa:${chainId}:${o}`, 120_000, () =>
    json<{ code: number; result: GpApproval[] }>(
      f,
      `https://api.gopluslabs.io/api/v2/token_approval_security/${chainId}?addresses=${o}`,
      undefined,
      // no log history on this chain: leave time for the known-spender scan inside find_money's per-chain deadline
      ROUTESCAN.has(chainId) ||
        APPROVAL_EXPLORER[chainId] ||
        FULL_RANGE_LOG_RPC[chainId] ||
        ETHERSCAN_FREE.has(chainId)
        ? 20_000
        : 6_000,
    ),
  ).catch(() => null);
  if (gp?.code === 1) {
    sources.push("GoPlus approval security");
    for (const t of gp.result ?? [])
      for (const a of t.approved_list ?? [])
        pairs.set(`${t.token_address.toLowerCase()}:${a.approved_contract.toLowerCase()}`, {
          token: t.token_address,
          spender: a.approved_contract,
          time: a.approved_time,
          hash: a.hash,
          ...(a.address_info ? { info: a.address_info } : {}),
          symbol: t.token_symbol,
          decimals: t.decimals,
          tokenMalicious: t.malicious_address === 1,
        });
  }
  // Approval(owner, spender) log sources: Etherscan-compatible explorers, then a direct RPC scan.
  const topic1 = `0x${o.slice(2).toLowerCase().padStart(64, "0")}`;
  type Log = { address: string; topics: string[]; timeStamp?: string; transactionHash: string };
  const q = `module=logs&action=getLogs&fromBlock=0&toBlock=latest&topic0=${APPROVAL_TOPIC}&topic1=${topic1}&topic0_1_opr=and`;
  const logSources: { name: string; get: () => Promise<Log[] | null> }[] = [];
  const ex = (name: string, url: string) =>
    logSources.push({
      name,
      get: async () => {
        // public Blockscout instances rate-limit bursts (the history scan hits the same host); back off and retry
        let r: { message?: string; result: Log[] | null | string } = { result: null };
        for (let i = 0; i < 3; i++) {
          r = await json<{ message?: string; result: Log[] | null | string }>(
            f,
            url,
            undefined,
            10_000,
          ).catch((e) => ({ message: String((e as Error).message), result: null }));
          if (
            !/too many|429|rate limit/i.test(
              `${r.message ?? ""} ${typeof r.result === "string" ? r.result : ""}`,
            )
          )
            break;
          await new Promise((res) => setTimeout(res, 800 * (i + 1)));
        }
        if (Array.isArray(r.result)) return r.result;
        return /no (logs|records) found/i.test(r.message ?? "") ? [] : null;
      },
    });
  if (ROUTESCAN.has(chainId))
    ex(
      "Routescan Approval logs",
      `https://api.routescan.io/v2/network/mainnet/evm/${chainId}/etherscan/api?${q}`,
    );
  for (const [i, u] of (APPROVAL_EXPLORER[chainId] ?? []).entries())
    ex(`Explorer${i ? i + 1 : ""} Approval logs`, `${u}?${q}`);
  if (env.ETHERSCAN_API_KEY && ETHERSCAN_FREE.has(chainId))
    ex(
      "Etherscan v2 Approval logs",
      `https://api.etherscan.io/v2/api?chainid=${chainId}&${q}&apikey=${env.ETHERSCAN_API_KEY}`,
    );
  if (FULL_RANGE_LOG_RPC[chainId])
    logSources.push({
      name: "RPC Approval log scan",
      get: async () => {
        const r = await json<{ result?: Log[] }>(
          f,
          FULL_RANGE_LOG_RPC[chainId]!,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "eth_getLogs",
              params: [{ fromBlock: "0x0", toBlock: "latest", topics: [APPROVAL_TOPIC, topic1] }],
            }),
          },
          45_000,
        );
        return Array.isArray(r.result) ? r.result : null;
      },
    });
  // fastest, most reliable first: full-range RPC, then keyed Etherscan, then public explorers
  const srcRank = (n: string) => (n.startsWith("RPC") ? 0 : n.startsWith("Etherscan") ? 1 : 2);
  logSources.sort((a, b) => srcRank(a.name) - srcRank(b.name));
  for (const src of logSources) {
    const logs = await cached(`apl:${src.name}:${chainId}:${o}`, 120_000, src.get).catch(
      () => null,
    );
    if (!logs) continue;
    sources.push(src.name);
    for (const l of logs) {
      if (l.topics.length !== 3 || !l.topics[2]) continue; // NFT approvals index the id too
      const spender = getAddress(`0x${l.topics[2].slice(26)}`);
      const k = `${l.address.toLowerCase()}:${spender.toLowerCase()}`;
      const prev = pairs.get(k);
      pairs.set(k, {
        ...prev,
        token: l.address,
        spender,
        ...(l.timeStamp ? { time: Number(l.timeStamp) } : {}),
        hash: l.transactionHash,
      });
    }
    break;
  }
  // No full Approval-log history here: read allowance() for held tokens against known spenders.
  let knownOnly = false;
  if (!sources.some((x) => x.includes("logs") || x.includes("log scan"))) {
    const bal = (await walletBalances(f, env, o, [chainId]).catch(() => null)) as {
      holdings?: { chainId: number; address: string }[];
    } | null;
    const toks = (bal?.holdings ?? [])
      .filter(
        (h) => h.chainId === chainId && isAddress(h.address) && !isNativeAddr(chainId, h.address),
      )
      .map((h) => h.address);
    if (bal) {
      const found = await knownSpenderAllowances(evmClient(chainId, env), chainId, o, toks).catch(
        () => null,
      );
      if (found) {
        knownOnly = true;
        sources.push(
          `known-spender allowance scan (${toks.length} held tokens × ${Object.keys(spendersFor(chainId)).length} spenders)`,
        );
        for (const x of found) {
          const k = `${x.token.toLowerCase()}:${x.spender.toLowerCase()}`;
          if (!pairs.has(k))
            pairs.set(k, {
              token: x.token,
              spender: x.spender,
              info: { contract_name: x.name, is_contract: 1 },
            });
        }
      }
    }
  }
  if (!sources.length)
    throw new Error(
      `approvals not checked on ${chainName(chainId)}: no free approval source for this chain answered`,
    );
  // curated well-known spenders override index metadata (GoPlus has tagged Permit2 as an unverified EOA)
  const known = Object.fromEntries(
    Object.entries(spendersFor(chainId)).map(([a, n]) => [a.toLowerCase(), n]),
  );
  for (const p of pairs.values()) {
    const n = known[p.spender.toLowerCase()];
    if (n) p.info = { contract_name: n, is_contract: 1, is_open_source: 1 };
  }
  const list = [...pairs.values()].slice(0, 300);
  const c = evmClient(chainId, env);
  const res = await c.multicall({
    allowFailure: true,
    contracts: list.flatMap((p) => [
      {
        address: getAddress(p.token),
        abi: erc20Abi,
        functionName: "allowance",
        args: [o, getAddress(p.spender)],
      },
      { address: getAddress(p.token), abi: erc20Abi, functionName: "decimals" },
      { address: getAddress(p.token), abi: erc20Abi, functionName: "symbol" },
    ]) as never[],
  });
  const px = await prices(
    f,
    list.map((p) => ({ chainId, address: p.token })),
  );
  const rank: Record<string, number> = { high: 0, medium: 1, "low-medium": 2, low: 3 };
  const out = list
    .map((p, i) => {
      const al = res[i * 3];
      if (!al || al.status !== "success") return null;
      const allowance = al.result as unknown as bigint;
      if (allowance === 0n) return null;
      const d = res[i * 3 + 1];
      const s = res[i * 3 + 2];
      const dec = d?.status === "success" ? Number(d.result) : (p.decimals ?? 18);
      const symbol = s?.status === "success" ? String(s.result) : (p.symbol ?? "?");
      const unlimited =
        allowance >= maxUint256 / 2n || allowance >= 10n ** 15n * 10n ** BigInt(dec);
      const info = p.info;
      const flags: string[] = [];
      if (unlimited) flags.push("unlimited");
      if (info?.malicious_behavior?.length || info?.doubt_list)
        flags.push(
          `malicious or doubtful spender (${info.malicious_behavior?.join(", ") || "doubt list"})`,
        );
      if (info && info.is_contract === 0)
        flags.push("spender is a plain wallet (EOA), not a contract");
      if (info && info.is_open_source === 0) flags.push("spender source not verified");
      if (!info?.contract_name && !info?.tag) flags.push("unknown spender");
      if (p.tokenMalicious) flags.push("token flagged malicious");
      const risk = flags.some(
        (x) => x.startsWith("malicious") || x.includes("EOA") || x === "token flagged malicious",
      )
        ? "high"
        : unlimited && flags.includes("unknown spender")
          ? "medium"
          : unlimited
            ? "low-medium"
            : "low";
      const priceUsd = pxOf(px, chainId, p.token)?.price ?? null;
      return {
        token: getAddress(p.token),
        symbol,
        spender: getAddress(p.spender),
        spenderName: info?.contract_name || info?.tag || null,
        allowance: unlimited ? "unlimited" : formatUnits(allowance, dec),
        priceUsd,
        approvedAt: p.time ? new Date(p.time * 1000).toISOString() : null,
        approvalTx: p.hash ? `${EXPLORER[chainId]}/tx/${p.hash}` : null,
        flags,
        risk,
        revokeTx: revokeTx(chainId, p.token, p.spender),
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort(
      (a, b) => (rank[a.risk] ?? 9) - (rank[b.risk] ?? 9) || (b.priceUsd ?? 0) - (a.priceUsd ?? 0),
    );
  return {
    owner: o,
    chainId,
    chain: chainName(chainId),
    count: out.length,
    highRisk: out.filter((x) => x.risk === "high").length,
    unlimited: out.filter((x) => x.allowance === "unlimited").length,
    approvals: out.slice(0, 100),
    sources: [...sources, "live allowance() via public RPC multicall"],
    coverage: knownOnly
      ? `${sources.some((x) => x.startsWith("GoPlus")) ? "GoPlus index plus " : ""}${KNOWN_ONLY_NOTE}. No result here does NOT mean no approvals.`
      : ROUTESCAN.has(chainId)
        ? "Full Approval-log history (Routescan) plus GoPlus, each re-checked on-chain."
        : "GoPlus approval index (can miss very old or obscure approvals), each re-checked on-chain.",
    note: "Revoking = approve(spender, 0). revokeTx is unsigned: the owner's wallet signs and sends it (costs a little gas).",
  };
}

// ---------- 3. explain transaction ----------
const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
const APPROVAL = parseAbiItem(
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
);
async function selectorName(f: F, sel: string): Promise<string | null> {
  return cached(`sel:${sel}`, 86_400_000, async () => {
    const r = await json<{ result: { function: Record<string, { name: string }[] | null> } }>(
      f,
      `https://api.4byte.sourcify.dev/signature-database/v1/lookup?function=${sel}&filter=true`,
    ).catch(() => null);
    return r?.result?.function?.[sel]?.[0]?.name ?? null;
  });
}
async function tokenMeta(env: NodeJS.ProcessEnv, chainId: number, addrs: string[]) {
  const uniq = [...new Set(addrs.map((a) => getAddress(a)))].slice(0, 60);
  const res = await evmClient(chainId, env).multicall({
    allowFailure: true,
    contracts: uniq.flatMap((a) => [
      { address: a, abi: erc20Abi, functionName: "symbol" },
      { address: a, abi: erc20Abi, functionName: "decimals" },
    ]) as never[],
  });
  const m = new Map<string, { symbol: string; decimals: number | null }>();
  uniq.forEach((a, i) => {
    const s = res[i * 2];
    const d = res[i * 2 + 1];
    m.set(a.toLowerCase(), {
      symbol: s?.status === "success" ? String(s.result) : "?",
      decimals: d?.status === "success" ? Number(d.result) : null,
    });
  });
  return m;
}
const cap = (s: string) => `${s[0]?.toUpperCase() ?? ""}${s.slice(1)}`;
type Xfer = { token: string; symbol: string; from: string; to: string; amount: string };
export async function explainTx(f: F, env: NodeJS.ProcessEnv, chainId: number, hash: string) {
  if (vmOf(chainId) === "evm") return explainEvm(f, env, chainId, hash);
  if (chainId === SOLANA) return explainSol(f, env, hash);
  if (chainId === BITCOIN) return explainBtc(f, hash);
  return explainTron(f, hash);
}
async function explainEvm(f: F, env: NodeJS.ProcessEnv, chainId: number, hash: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new BadRequest("EVM tx hash must be 0x + 64 hex");
  const c = evmClient(chainId, env);
  const h = hash as `0x${string}`;
  const tx = await c.getTransaction({ hash: h }).catch(() => null);
  if (!tx) throw new BadRequest(`transaction not found on ${chainName(chainId)}`);
  const rc = await c.getTransactionReceipt({ hash: h }).catch(() => null);
  const block = rc ? await c.getBlock({ blockNumber: rc.blockNumber }).catch(() => null) : null;
  const from = tx.from;
  const logs = rc?.logs ?? [];
  const tokenAddrs = logs
    .filter(
      (l) =>
        l.topics.length === 3 && (l.topics[0] === APPROVAL_TOPIC || l.topics[0] === TRANSFER_TOPIC),
    )
    .map((l) => l.address);
  const meta = tokenAddrs.length
    ? await tokenMeta(env, chainId, tokenAddrs)
    : new Map<string, { symbol: string; decimals: number | null }>();
  const transfers: Xfer[] = [];
  const approvalsSet: { token: string; symbol: string; spender: string; amount: string }[] = [];
  for (const l of logs) {
    if (l.topics.length !== 3) continue;
    try {
      const ev = decodeEventLog({
        abi: [TRANSFER, APPROVAL],
        data: l.data,
        topics: l.topics as never,
      });
      const m = meta.get(l.address.toLowerCase()) ?? { symbol: "?", decimals: null };
      const amt = (v: bigint) =>
        v >= maxUint256 / 2n
          ? "unlimited"
          : m.decimals === null
            ? v.toString()
            : formatUnits(v, m.decimals);
      if (ev.eventName === "Transfer")
        transfers.push({
          token: getAddress(l.address),
          symbol: m.symbol,
          from: ev.args.from,
          to: ev.args.to,
          amount: amt(ev.args.value),
        });
      else
        approvalsSet.push({
          token: getAddress(l.address),
          symbol: m.symbol,
          spender: ev.args.spender,
          amount: amt(ev.args.value),
        });
    } catch {}
  }
  const l1 =
    rc && typeof (rc as { l1Fee?: unknown }).l1Fee === "bigint"
      ? (rc as unknown as { l1Fee: bigint }).l1Fee
      : 0n;
  const feeNative = rc
    ? formatUnits(rc.gasUsed * (rc.effectiveGasPrice ?? tx.gasPrice ?? 0n) + l1, 18)
    : null;
  const px = await prices(f, [{ chainId, address: NATIVE_TOKEN }]);
  const nativePx = pxOf(px, chainId, NATIVE_TOKEN)?.price ?? null;
  const method =
    tx.input && tx.input.length >= 10 ? await selectorName(f, tx.input.slice(0, 10)) : null;
  const sym = NATIVE_SYMBOL[chainId] ?? "ETH";
  const lc = from.toLowerCase();
  const sent = transfers.filter((t) => t.from.toLowerCase() === lc);
  const recv = transfers.filter((t) => t.to.toLowerCase() === lc);
  if (tx.value > 0n)
    sent.unshift({
      token: NATIVE_TOKEN,
      symbol: sym,
      from,
      to: tx.to ?? "",
      amount: formatUnits(tx.value, 18),
    });
  const code = tx.to ? await c.getCode({ address: tx.to }).catch(() => undefined) : undefined;
  const isContract = !!code && code !== "0x";
  let kind = "contract call";
  if (!tx.to) kind = "contract deployment";
  else if (!isContract && tx.input === "0x") kind = "native transfer";
  else if (sent.length && recv.length) kind = "swap";
  else if (approvalsSet.length && !transfers.length) kind = "approval";
  else if (transfers.length === 1 && sent.length === 1) kind = "token transfer";
  const status = rc
    ? rc.status === "success"
      ? "succeeded"
      : "FAILED (reverted)"
    : "is still pending";
  const when = block ? new Date(Number(block.timestamp) * 1000).toISOString() : null;
  const lines = [
    `${cap(kind)} on ${chainName(chainId)} that ${status}${when ? ` at ${when}` : ""}.`,
  ];
  if (kind === "swap")
    lines.push(
      `${from} swapped ${sent.map((t) => `${fmt(t.amount)} ${t.symbol}`).join(" + ")} for ${recv.map((t) => `${fmt(t.amount)} ${t.symbol}`).join(" + ")}.`,
    );
  else {
    for (const t of sent.slice(0, 5))
      lines.push(
        `${from} sent ${t.amount === "unlimited" ? t.amount : fmt(t.amount)} ${t.symbol} to ${t.to}.`,
      );
    for (const t of recv.slice(0, 5))
      lines.push(`Received ${fmt(t.amount)} ${t.symbol} from ${t.from}.`);
    if (!sent.length && !recv.length)
      for (const t of transfers.slice(0, 5))
        lines.push(
          `${t.from} sent ${t.amount === "unlimited" ? t.amount : fmt(t.amount)} ${t.symbol} to ${t.to}.`,
        );
  }
  for (const a of approvalsSet.slice(0, 3))
    lines.push(
      `Approved ${a.spender} to spend ${a.amount === "unlimited" ? "an UNLIMITED amount of" : fmt(a.amount)} ${a.symbol}.`,
    );
  if (tx.to && kind !== "native transfer")
    lines.push(`Called contract ${tx.to}${method ? ` (${method})` : ""}.`);
  if (feeNative)
    lines.push(
      `Fee: ${fmt(feeNative)} ${sym}${nativePx ? ` (~$${(Number(feeNative) * nativePx).toFixed(4)})` : ""}.`,
    );
  return {
    chainId,
    chain: chainName(chainId),
    hash,
    status: rc ? rc.status : "pending",
    kind,
    summary: lines.join(" "),
    from,
    to: tx.to,
    method,
    valueNative: formatUnits(tx.value, 18),
    feeNative,
    feeUsd: feeNative && nativePx ? Number(feeNative) * nativePx : null,
    blockNumber: rc ? Number(rc.blockNumber) : null,
    timestamp: when,
    tokenTransfers: transfers.slice(0, 50),
    approvals: approvalsSet,
    contractsTouched: [...new Set(logs.map((l) => getAddress(l.address)))].slice(0, 30),
    explorerUrl: `${EXPLORER[chainId]}/tx/${hash}`,
    sources: ["public RPC tx + receipt + logs", "Sourcify 4byte selectors", "DefiLlama price"],
  };
}
const SOL_PROGRAMS: Record<string, string> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter Aggregator v6",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpools",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium CLMM",
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "Raydium CPMM",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "PumpSwap AMM",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
  "11111111111111111111111111111111": "System Program",
  ComputeBudget111111111111111111111111111111: "Compute Budget",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token Account",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
};
const BORING = new Set([
  "Compute Budget",
  "System Program",
  "SPL Token",
  "Token-2022",
  "Associated Token Account",
]);
async function explainSol(f: F, env: NodeJS.ProcessEnv, sig: string) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig))
    throw new BadRequest("Solana signature must be base58 (~88 chars)");
  type Bal = { mint: string; owner?: string; uiTokenAmount: { uiAmountString: string } };
  const tx = await solRpc<{
    blockTime: number | null;
    slot: number;
    meta: {
      err: unknown;
      fee: number;
      preBalances: number[];
      postBalances: number[];
      preTokenBalances: Bal[];
      postTokenBalances: Bal[];
    };
    transaction: {
      message: {
        accountKeys: { pubkey: string; signer: boolean }[];
        instructions: { programId: string }[];
      };
    };
  } | null>(f, env, "getTransaction", [
    sig,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" },
  ]);
  if (!tx) throw new BadRequest("transaction not found (public Solana RPCs keep limited history)");
  const SOLN = NON_EVM[SOLANA]!.native;
  const keys = tx.transaction.message.accountKeys;
  const signer = keys.find((k) => k.signer)?.pubkey ?? keys[0]!.pubkey;
  const solDelta =
    ((tx.meta.postBalances[0] ?? 0) - (tx.meta.preBalances[0] ?? 0) + tx.meta.fee) / 1e9;
  const deltas = new Map<string, number>();
  for (const b of tx.meta.postTokenBalances.filter((b) => b.owner === signer))
    deltas.set(b.mint, (deltas.get(b.mint) ?? 0) + Number(b.uiTokenAmount.uiAmountString));
  for (const b of tx.meta.preTokenBalances.filter((b) => b.owner === signer))
    deltas.set(b.mint, (deltas.get(b.mint) ?? 0) - Number(b.uiTokenAmount.uiAmountString));
  // wSOL wrap/unwrap shows up as both; fold wSOL into SOL.
  const WSOL = "So11111111111111111111111111111111111111112";
  const nativeDelta = solDelta + (deltas.get(WSOL) ?? 0);
  deltas.delete(WSOL);
  if (Math.abs(nativeDelta) > 1e-9) deltas.set(SOLN, nativeDelta);
  const px = await prices(
    f,
    [...deltas.keys(), SOLN].map((a) => ({ chainId: SOLANA, address: a })),
  );
  const symOf = (m: string) =>
    m === SOLN
      ? "SOL"
      : (listed(SOLANA).find((t) => t.address === m)?.symbol ??
        pxOf(px, SOLANA, m)?.symbol ??
        `${m.slice(0, 4)}…`);
  const changes = [...deltas]
    .filter(([, d]) => Math.abs(d) > 1e-12)
    .map(([mint, d]) => ({ mint, symbol: symOf(mint), change: d }));
  const out = changes.filter((c) => c.change < 0);
  const inn = changes.filter((c) => c.change > 0);
  const programs = [...new Set(tx.transaction.message.instructions.map((i) => i.programId))].map(
    (p) => ({ programId: p, name: SOL_PROGRAMS[p] ?? null }),
  );
  const kind =
    out.length && inn.length
      ? "swap"
      : out.length
        ? "transfer out"
        : inn.length
          ? "transfer in"
          : "program call";
  const feeSol = tx.meta.fee / 1e9;
  const solPx = pxOf(px, SOLANA, SOLN)?.price ?? null;
  const when = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null;
  const lines = [
    `${cap(kind)} on Solana that ${tx.meta.err ? "FAILED" : "succeeded"}${when ? ` at ${when}` : ""}.`,
  ];
  if (kind === "swap")
    lines.push(
      `${signer} swapped ${out.map((c) => `${fmt(-c.change)} ${c.symbol}`).join(" + ")} for ${inn.map((c) => `${fmt(c.change)} ${c.symbol}`).join(" + ")}.`,
    );
  else
    for (const c of changes)
      lines.push(
        `${signer} ${c.change < 0 ? "sent" : "received"} ${fmt(Math.abs(c.change))} ${c.symbol}.`,
      );
  const named = programs.filter((p) => p.name && !BORING.has(p.name)).map((p) => p.name);
  if (named.length) lines.push(`Via ${named.join(", ")}.`);
  lines.push(`Fee: ${fmt(feeSol)} SOL${solPx ? ` (~$${(feeSol * solPx).toFixed(4)})` : ""}.`);
  return {
    chainId: SOLANA,
    chain: "Solana",
    hash: sig,
    status: tx.meta.err ? "failed" : "success",
    kind,
    summary: lines.join(" "),
    signer,
    balanceChanges: changes,
    feeSol,
    feeUsd: solPx ? feeSol * solPx : null,
    slot: tx.slot,
    timestamp: when,
    programs,
    explorerUrl: `https://solscan.io/tx/${sig}`,
    sources: ["Solana RPC getTransaction", "DefiLlama prices"],
  };
}
async function explainBtc(f: F, txid: string) {
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new BadRequest("Bitcoin txid must be 64 hex");
  const t = await json<{
    fee: number;
    weight: number;
    vin: { prevout: { scriptpubkey_address?: string; value: number } | null }[];
    vout: { scriptpubkey_address?: string; value: number }[];
    status: { confirmed: boolean; block_time?: number; block_height?: number };
  }>(f, `https://mempool.space/api/tx/${txid}`).catch(() => null);
  if (!t) throw new BadRequest("Bitcoin transaction not found");
  const BTCN = NON_EVM[BITCOIN]!.native;
  const p =
    pxOf(await prices(f, [{ chainId: BITCOIN, address: BTCN }]), BITCOIN, BTCN)?.price ?? null;
  const inputs = [
    ...new Set(t.vin.map((v) => v.prevout?.scriptpubkey_address).filter((x): x is string => !!x)),
  ];
  const outs = t.vout.map((o) => ({
    address: o.scriptpubkey_address ?? "(OP_RETURN / script)",
    btc: o.value / 1e8,
    change: !!o.scriptpubkey_address && inputs.includes(o.scriptpubkey_address),
  }));
  const paid = outs.filter((o) => !o.change);
  const vb = Math.ceil(t.weight / 4);
  const when = t.status.block_time ? new Date(t.status.block_time * 1000).toISOString() : null;
  const summary = `Bitcoin transaction ${t.status.confirmed ? `confirmed in block ${t.status.block_height}${when ? ` at ${when}` : ""}` : "still unconfirmed in the mempool"}. ${inputs.length} input address(es) paid ${paid
    .slice(0, 5)
    .map((o) => `${fmt(o.btc)} BTC to ${o.address}`)
    .join(
      ", ",
    )}${paid.length > 5 ? ` and ${paid.length - 5} more outputs` : ""}${outs.some((o) => o.change) ? " (the rest came back as change)" : ""}. Fee: ${t.fee} sats (${(t.fee / vb).toFixed(1)} sat/vB)${p ? `, about $${((t.fee / 1e8) * p).toFixed(2)}` : ""}.`;
  return {
    chainId: BITCOIN,
    chain: "Bitcoin",
    hash: txid,
    status: t.status.confirmed ? "confirmed" : "pending",
    kind: "bitcoin payment",
    summary,
    inputs,
    outputs: outs,
    feeSats: t.fee,
    feeUsd: p ? (t.fee / 1e8) * p : null,
    vsize: vb,
    timestamp: when,
    explorerUrl: `https://mempool.space/tx/${txid}`,
    sources: ["mempool.space", "DefiLlama price"],
  };
}

// ---------- base58 (blocktools wasm; fails closed) ----------
export const b58encode = (bytes: Uint8Array): string => btB58Encode(bytes);
export function b58decode(s: string): Uint8Array {
  if (!blocktools()) throw new Error("blocktools unavailable");
  try {
    return btB58Decode(s);
  } catch {
    throw new BadRequest("invalid base58");
  }
}
const sha256 = (...parts: Uint8Array[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};
export function tronAddr(hex41: string): string {
  let h = hex41.replace(/^0x/, "").toLowerCase();
  if (h.length === 40) h = `41${h}`;
  const raw = Uint8Array.from(Buffer.from(h, "hex"));
  const chk = sha256(sha256(raw)).slice(0, 4);
  return b58encode(Uint8Array.from([...raw, ...chk]));
}

async function explainTron(f: F, txid: string) {
  const id = txid.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(id)) throw new BadRequest("Tron txid must be 64 hex");
  const post = <T>(p: string) =>
    json<T>(f, `https://api.trongrid.io/wallet/${p}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: id }),
    });
  type Contract = { type: string; parameter: { value: Record<string, unknown> } };
  const [tx, info] = await Promise.all([
    post<{ txID?: string; ret?: { contractRet: string }[]; raw_data?: { contract: Contract[] } }>(
      "gettransactionbyid",
    ),
    post<{
      fee?: number;
      blockTimeStamp?: number;
      blockNumber?: number;
      receipt?: { result?: string; energy_usage_total?: number };
      log?: { address: string; topics: string[]; data: string }[];
    }>("gettransactioninfobyid"),
  ]);
  if (!tx.txID) throw new BadRequest("Tron transaction not found");
  const ct = tx.raw_data?.contract[0];
  const v = ct?.parameter.value ?? {};
  const owner = typeof v.owner_address === "string" ? tronAddr(v.owner_address) : "?";
  const lines: string[] = [];
  const transfers: Xfer[] = [];
  for (const l of info.log ?? []) {
    if (l.topics[0] !== TRANSFER_TOPIC.slice(2) || l.topics.length !== 3) continue;
    const token = tronAddr(`41${l.address}`);
    const t = listed(TRON).find((x) => x.address === token);
    const raw = BigInt(`0x${l.data || "0"}`);
    transfers.push({
      token,
      symbol: t?.symbol ?? "?",
      from: tronAddr(`41${l.topics[1]!.slice(24)}`),
      to: tronAddr(`41${l.topics[2]!.slice(24)}`),
      amount: t ? formatUnits(raw, t.decimals) : raw.toString(),
    });
  }
  let kind = ct?.type ?? "unknown";
  if (ct?.type === "TransferContract") {
    kind = "TRX transfer";
    lines.push(
      `${owner} sent ${fmt(Number(v.amount) / 1e6)} TRX to ${tronAddr(String(v.to_address))}.`,
    );
  } else if (ct?.type === "TriggerSmartContract") {
    kind =
      transfers.length === 1
        ? "token transfer"
        : transfers.length > 1
          ? "contract call (likely swap)"
          : "contract call";
    for (const t of transfers.slice(0, 5))
      lines.push(`${t.from} sent ${fmt(t.amount)} ${t.symbol} to ${t.to}.`);
    lines.push(`Called contract ${tronAddr(String(v.contract_address))}.`);
  }
  const ok = tx.ret?.[0]?.contractRet === "SUCCESS";
  const when = info.blockTimeStamp ? new Date(info.blockTimeStamp).toISOString() : null;
  const feeTrx = (info.fee ?? 0) / 1e6;
  lines.unshift(
    `${cap(kind)} on Tron that ${ok ? "succeeded" : `did not succeed (${tx.ret?.[0]?.contractRet ?? "pending"})`}${when ? ` at ${when}` : ""}.`,
  );
  lines.push(
    `Fee: ${fmt(feeTrx)} TRX burned${info.receipt?.energy_usage_total ? ` (${info.receipt.energy_usage_total} energy)` : ""}.`,
  );
  return {
    chainId: TRON,
    chain: "Tron",
    hash: id,
    status: ok ? "success" : (tx.ret?.[0]?.contractRet ?? "pending"),
    kind,
    summary: lines.join(" "),
    from: owner,
    contractType: ct?.type,
    tokenTransfers: transfers,
    feeTrx,
    blockNumber: info.blockNumber ?? null,
    timestamp: when,
    explorerUrl: `https://tronscan.org/#/transaction/${id}`,
    sources: ["TronGrid"],
  };
}

// ---------- 4. gas ----------
const OP_STACK = new Set([8453, 10]);
export async function gas(f: F, env: NodeJS.ProcessEnv, chains?: number[]) {
  const want = chains?.length ? chains : ALL_IDS;
  return cached(`gas:${want.join(",")}`, 15_000, async () => {
    const px = await prices(
      f,
      want.map((id) => ({ chainId: id, address: NON_EVM[id]?.native ?? NATIVE_TOKEN })),
    );
    const np = (id: number) => pxOf(px, id, NON_EVM[id]?.native ?? NATIVE_TOKEN)?.price ?? null;
    const rows = await Promise.all(
      want.map(async (id) => {
        try {
          if (vmOf(id) === "evm") {
            const wei = await evmClient(id, env).getGasPrice();
            // rough L1 data fee for OP-stack L2s on a ~1 KB swap tx
            const l1 = OP_STACK.has(id) ? 1e-7 : 0;
            const swapNative = (Number(wei) * 180_000) / 1e18 + l1;
            return {
              chainId: id,
              chain: chainName(id),
              gasPriceGwei: Number(wei) / 1e9,
              swapCostNative: swapNative,
              nativeSymbol: NATIVE_SYMBOL[id],
              swapCostUsd: np(id) ? swapNative * np(id)! : null,
              assumption: "~180k gas DEX swap",
            };
          }
          if (id === SOLANA) {
            const fees = await solRpc<{ prioritizationFee: number }[]>(
              f,
              env,
              "getRecentPrioritizationFees",
              [["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"]],
            );
            const s = fees.map((x) => x.prioritizationFee).sort((a, b) => a - b);
            const med = s[Math.floor(s.length / 2)] ?? 0;
            const sol = (5000 + (med * 300_000) / 1e6) / 1e9;
            return {
              chainId: id,
              chain: "Solana",
              priorityFeeMicroLamportsPerCU: med,
              swapCostNative: sol,
              nativeSymbol: "SOL",
              swapCostUsd: np(id) ? sol * np(id)! : null,
              assumption: "5000 lamports base + median priority fee × 300k CU",
            };
          }
          if (id === BITCOIN) {
            const r = await json<{
              fastestFee: number;
              halfHourFee: number;
              hourFee: number;
              economyFee: number;
            }>(f, "https://mempool.space/api/v1/fees/recommended");
            const btc = (r.halfHourFee * 200) / 1e8;
            return {
              chainId: id,
              chain: "Bitcoin",
              satPerVb: r,
              swapCostNative: btc,
              nativeSymbol: "BTC",
              swapCostUsd: np(id) ? btc * np(id)! : null,
              assumption: "~200 vB payment at the half-hour fee rate",
            };
          }
          const r = await json<{ chainParameter: { key: string; value?: number }[] }>(
            f,
            "https://api.trongrid.io/wallet/getchainparameters",
          );
          const p = (k: string) => r.chainParameter.find((x) => x.key === k)?.value ?? 0;
          const trx = (p("getEnergyFee") * 130_000 + p("getTransactionFee") * 350) / 1e6;
          return {
            chainId: id,
            chain: "Tron",
            energyFeeSun: p("getEnergyFee"),
            swapCostNative: trx,
            nativeSymbol: "TRX",
            swapCostUsd: np(id) ? trx * np(id)! : null,
            assumption: "~130k energy + 350 bandwidth, burned (no staked energy)",
          };
        } catch (e) {
          return { chainId: id, chain: chainName(id), error: (e as Error).message.slice(0, 120) };
        }
      }),
    );
    const priced = rows.filter(
      (r): r is typeof r & { swapCostUsd: number } =>
        typeof (r as { swapCostUsd?: unknown }).swapCostUsd === "number",
    );
    priced.sort((a, b) => a.swapCostUsd - b.swapCostUsd);
    return {
      cheapest: priced[0] ? { chain: priced[0].chain, swapCostUsd: priced[0].swapCostUsd } : null,
      chains: rows,
      asOf: new Date().toISOString(),
      note: "Estimates of network fees only; the SwapChan quote shows exact route fees.",
      sources: [
        "public RPC eth_gasPrice",
        "Solana getRecentPrioritizationFees",
        "mempool.space",
        "TronGrid",
        "DefiLlama prices",
      ],
    };
  });
}

// ---------- 5. token info ----------
const scanChainOf = (id: number) =>
  Object.entries(SCAN_CHAINS).find(([, v]) => v.chainId === id)?.[0] as ScanChain | undefined;
export async function tokenInfo(f: F, env: NodeJS.ProcessEnv, chainId: number, address: string) {
  return cached(`tinfo:${chainId}:${address}`, 120_000, async () => {
    const out: Record<string, unknown> = { chainId, chain: chainName(chainId), address };
    const sources: string[] = [];
    if (vmOf(chainId) === "evm") {
      if (!isAddress(address)) throw new BadRequest("EVM token address required");
      const a = getAddress(address);
      out.address = a;
      const r = await evmClient(chainId, env).multicall({
        allowFailure: true,
        contracts: (["name", "symbol", "decimals", "totalSupply"] as const).map((fn) => ({
          address: a,
          abi: erc20Abi,
          functionName: fn,
        })) as never[],
      });
      const [name, symbol, dec, ts] = r.map((x) => (x.status === "success" ? x.result : null));
      if (symbol === null && dec === null)
        throw new BadRequest(`no ERC-20 at ${a} on ${chainName(chainId)}`);
      Object.assign(out, {
        name,
        symbol,
        decimals: dec === null ? null : Number(dec),
        totalSupply:
          ts === null || dec === null ? null : formatUnits(ts as unknown as bigint, Number(dec)),
      });
      sources.push("public RPC");
      const gp = await cached(`gpt:${chainId}:${a}`, 300_000, () =>
        json<{
          result: Record<
            string,
            {
              holder_count?: string;
              holders?: {
                address: string;
                percent: string;
                is_contract: number;
                tag?: string;
                is_locked: number;
              }[];
              creator_address?: string;
              owner_address?: string;
              is_open_source?: string;
              is_proxy?: string;
              is_mintable?: string;
              buy_tax?: string;
              sell_tax?: string;
            }
          >;
        }>(f, `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${a}`),
      ).catch(() => null);
      const g = gp?.result?.[a.toLowerCase()];
      if (g) {
        sources.push("GoPlus");
        Object.assign(out, {
          holderCount: g.holder_count ? Number(g.holder_count) : null,
          topHolders: (g.holders ?? []).slice(0, 10).map((h) => ({
            address: h.address,
            pct: Math.round(Number(h.percent) * 10000) / 100,
            contract: h.is_contract === 1,
            locked: h.is_locked === 1,
            tag: h.tag || null,
          })),
          creator: g.creator_address || null,
          owner: g.owner_address || null,
          verifiedSource: g.is_open_source === "1",
          proxy: g.is_proxy === "1",
          mintable: g.is_mintable === "1",
          buyTaxPct: g.buy_tax ? Number(g.buy_tax) * 100 : null,
          sellTaxPct: g.sell_tax ? Number(g.sell_tax) * 100 : null,
        });
      }
      if (chainId === 1) {
        const ep = await cached(`eplr:${a}`, 3_600_000, () =>
          json<{
            txsCount?: number;
            holdersCount?: number;
            contractInfo?: { creationTimestamp?: number; creationTransactionHash?: string };
          }>(f, `https://api.ethplorer.io/getTokenInfo/${a}?apiKey=freekey`),
        ).catch(() => null);
        if (ep?.contractInfo?.creationTimestamp) {
          sources.push("Ethplorer");
          out.deployedAt = new Date(ep.contractInfo.creationTimestamp * 1000).toISOString();
          out.deployTx = ep.contractInfo.creationTransactionHash
            ? `${EXPLORER[1]}/tx/${ep.contractInfo.creationTransactionHash}`
            : null;
          if (out.holderCount == null && ep.holdersCount) out.holderCount = ep.holdersCount;
        }
      }
    } else if (chainId === SOLANA) {
      type Mint = {
        value: {
          owner: string;
          data: {
            parsed?: {
              type: string;
              info: {
                decimals: number;
                supply: string;
                mintAuthority: string | null;
                freezeAuthority: string | null;
              };
            };
          };
        } | null;
      };
      const [acct, largest] = await Promise.all([
        solRpc<Mint>(f, env, "getAccountInfo", [address, { encoding: "jsonParsed" }]),
        solRpc<{ value: { address: string; uiAmountString: string }[] }>(
          f,
          env,
          "getTokenLargestAccounts",
          [address],
        ).catch(() => null),
      ]);
      const i = acct.value?.data.parsed?.type === "mint" ? acct.value.data.parsed.info : null;
      if (!i) throw new BadRequest("not an SPL mint");
      const supply = Number(i.supply) / 10 ** i.decimals;
      const t = listed(SOLANA).find((x) => x.address === address);
      Object.assign(out, {
        symbol: t?.symbol ?? null,
        name: t?.name ?? null,
        decimals: i.decimals,
        totalSupply: String(supply),
        program: acct.value!.owner === SPL22 ? "Token-2022" : "SPL Token",
        mintAuthority: i.mintAuthority,
        freezeAuthority: i.freezeAuthority,
        mintable: !!i.mintAuthority,
        freezable: !!i.freezeAuthority,
        topHolders: (largest?.value ?? []).slice(0, 10).map((h) => ({
          tokenAccount: h.address,
          pct: supply ? Math.round((Number(h.uiAmountString) / supply) * 10000) / 100 : null,
        })),
      });
      sources.push("Solana RPC");
    } else throw new BadRequest("token_info supports EVM chains and Solana");
    const px = await prices(f, [{ chainId, address: String(out.address) }]);
    const p = pxOf(px, chainId, String(out.address));
    if (p) {
      out.symbol ??= p.symbol ?? null;
      out.priceUsd = p.price;
      out.fdvUsd = out.totalSupply ? Math.round(Number(out.totalSupply) * p.price) : null;
      sources.push("DefiLlama");
    }
    const sc = scanChainOf(chainId);
    if (sc) {
      const risk = await tokenRisk(f, env, sc, String(out.address)).catch(() => null);
      if (risk) {
        out.risk = risk;
        sources.push("SwapChan token risk (DexScreener/GoPlus/RugCheck)");
      }
    }
    out.listedOnSwapChan = listed(chainId).some(
      (t) => t.address.toLowerCase() === String(out.address).toLowerCase(),
    );
    out.swapUrl = swapUrl(chainId, usdcOf(chainId) ?? NATIVE_TOKEN, chainId, String(out.address));
    out.sources = sources;
    return out;
  });
}

// ---------- 6. names (ENS / Basenames / SNS) ----------
/** Is this 32-byte string a valid compressed ed25519 point? (PDAs must NOT be.) blocktools wasm. */
export const onCurve = (b: Uint8Array): boolean => btSolOnCurve(b);
export const findPda = (seeds: Uint8Array[], programId: string): string =>
  btSolPda(seeds, programId).address;
const SNS_PROGRAM = "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX";
const SOL_TLD = "58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx";
export function snsKey(name: string, parent = SOL_TLD): string {
  const hashed = sha256(new TextEncoder().encode(`SPL Name Service${name}`));
  return findPda([hashed, new Uint8Array(32), b58decode(parent)], SNS_PROGRAM);
}
export async function resolveName(f: F, env: NodeJS.ProcessEnv, input: string) {
  const q = input.trim();
  return cached(`name:${q.toLowerCase()}`, 600_000, async () => {
    if (/\.sol$/i.test(q)) {
      const label = q.toLowerCase().replace(/\.sol$/, "");
      if (label.includes("."))
        throw new BadRequest("only top-level .sol names (no subdomains) are supported");
      const key = snsKey(label);
      const r = await solRpc<{ value: { data: [string, string] } | null }>(
        f,
        env,
        "getAccountInfo",
        [key, { encoding: "base64" }],
      );
      if (!r.value) return { input: q, type: "sns", resolved: false, note: "name not registered" };
      const data = Buffer.from(r.value.data[0], "base64");
      const owner = b58encode(Uint8Array.from(data.subarray(32, 64)));
      return {
        input: q,
        type: "sns",
        resolved: true,
        address: owner,
        chainId: SOLANA,
        nameAccount: key,
        sources: ["Solana RPC (SNS name account, derived locally)"],
        next: balancesHint(owner),
      };
    }
    if (/\.[a-z0-9-]+$/i.test(q) && !isAddress(q)) {
      const c = evmClient(1, env);
      const name = normalize(q);
      const [address, avatar] = await Promise.all([
        c.getEnsAddress({ name }).catch(() => null),
        c.getEnsAvatar({ name }).catch(() => null),
      ]);
      const twitter = await c.getEnsText({ name, key: "com.twitter" }).catch(() => null);
      return {
        input: q,
        type: /\.base\.eth$/i.test(q) ? "basename" : "ens",
        resolved: !!address,
        address,
        avatar,
        twitter,
        chainId: 1,
        sources: ["ENS via public Ethereum RPC (CCIP-read for Basenames)"],
        ...(address ? { next: balancesHint(address) } : {}),
      };
    }
    if (isAddress(q)) {
      const c = evmClient(1, env);
      const name = await c.getEnsName({ address: getAddress(q) }).catch(() => null);
      // Basenames reverse records live on Base's L2 resolver; viem resolves via mainnet only for ENS.
      return {
        input: q,
        type: "evm-reverse",
        resolved: !!name,
        name,
        sources: ["ENS reverse record"],
        next: balancesHint(q),
      };
    }
    if (isVmAddress(q, "svm")) {
      const r = await json<{ s: string; result: string | null }>(
        f,
        `https://sns-sdk-proxy.bonfida.workers.dev/favorite-domain/${q}`,
        undefined,
        6_000,
      ).catch(() => null);
      const name = r?.s === "ok" && r.result ? `${r.result}.sol` : null;
      return {
        input: q,
        type: "sns-reverse",
        resolved: !!name,
        name,
        note: name
          ? undefined
          : "SNS reverse lookup is best-effort (favorite domain via Bonfida proxy)",
        sources: ["Bonfida SNS proxy"],
        next: balancesHint(q),
      };
    }
    throw new BadRequest(
      "give an ENS name (vitalik.eth), Basename (x.base.eth), SNS name (toly.sol), or an EVM/Solana address",
    );
  });
}
const balancesHint = (a: string) =>
  `get_wallet_balances(${a}) to see holdings, then swap on SwapChan`;

// ---------- 7. watches (pull-based, SQLite) ----------
export type BestOut = (q: {
  fromChainId: number;
  fromToken: string;
  toChainId: number;
  toToken: string;
  amount: string;
}) => Promise<number | null>;
export function openWatchDb(file: string) {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS watches (
    watch_id TEXT NOT NULL, item_id TEXT NOT NULL, chain_id INTEGER NOT NULL, address TEXT NOT NULL, symbol TEXT,
    base_price REAL, up_pct REAL, down_pct REAL, above REAL, below REAL, swap TEXT, best_out REAL, last_price REAL,
    created_at INTEGER NOT NULL, checked_at INTEGER, PRIMARY KEY (watch_id, item_id))`);
  return db;
}
export const WatchItem = z.object({
  chainId: z.union([z.number(), z.string()]),
  address: z.string().min(1),
  upPct: z.number().positive().optional(),
  downPct: z.number().positive().optional(),
  above: z.number().positive().optional(),
  below: z.number().positive().optional(),
  swap: z
    .object({
      toChainId: z.union([z.number(), z.string()]),
      toToken: z.string(),
      amount: z.string(),
    })
    .optional(),
});
const WATCH_ID = /^[A-Za-z0-9_-]{8,64}$/;
async function spot(
  f: F,
  chainId: number,
  address: string,
): Promise<{ price: number | null; symbol: string | null }> {
  const p = pxOf(await prices(f, [{ chainId, address }]), chainId, address);
  if (p) return { price: p.price, symbol: p.symbol ?? null };
  const sc = scanChainOf(chainId);
  if (!sc) return { price: null, symbol: null };
  const r = await cached(`dsp:${chainId}:${address}`, 30_000, () =>
    json<
      {
        priceUsd?: string;
        liquidity?: { usd?: number };
        baseToken: { symbol: string; address: string };
      }[]
    >(f, `https://api.dexscreener.com/tokens/v1/${SCAN_CHAINS[sc].ds}/${address}`),
  ).catch(() => []);
  const best = r
    .filter((x) => x.baseToken.address.toLowerCase() === address.toLowerCase())
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  return {
    price: best?.priceUsd ? Number(best.priceUsd) : null,
    symbol: best?.baseToken.symbol ?? null,
  };
}
type Row = {
  watch_id: string;
  item_id: string;
  chain_id: number;
  address: string;
  symbol: string | null;
  base_price: number | null;
  up_pct: number | null;
  down_pct: number | null;
  above: number | null;
  below: number | null;
  swap: string | null;
  best_out: number | null;
  last_price: number | null;
  created_at: number;
  checked_at: number | null;
};
const rowOut = (r: Row) => ({
  itemId: r.item_id,
  chainId: r.chain_id,
  chain: chainName(r.chain_id),
  address: r.address,
  symbol: r.symbol,
  basePrice: r.base_price,
  lastPrice: r.last_price,
  upPct: r.up_pct,
  downPct: r.down_pct,
  above: r.above,
  below: r.below,
  swap: r.swap ? JSON.parse(r.swap) : null,
  bestOut: r.best_out,
  createdAt: new Date(r.created_at).toISOString(),
  checkedAt: r.checked_at ? new Date(r.checked_at).toISOString() : null,
});
export async function addWatch(
  f: F,
  db: DatabaseSync,
  watchId: string,
  items: z.infer<typeof WatchItem>[],
  bestOut: BestOut,
) {
  if (!WATCH_ID.test(watchId))
    throw new BadRequest("watchId: 8-64 chars of [A-Za-z0-9_-]; generate a random one and keep it");
  const n = (
    db.prepare("SELECT COUNT(*) n FROM watches WHERE watch_id=?").get(watchId) as { n: number }
  ).n;
  if (n + items.length > 50) throw new BadRequest("max 50 items per watchId");
  const added = [];
  for (const it of items) {
    const chainId = chainOf(it.chainId);
    const address =
      vmOf(chainId) === "evm"
        ? isAddress(it.address)
          ? getAddress(it.address)
          : (() => {
              throw new BadRequest(`bad address ${it.address}`);
            })()
        : it.address;
    const s = await spot(f, chainId, address);
    const swap = it.swap
      ? { toChainId: chainOf(it.swap.toChainId), toToken: it.swap.toToken, amount: it.swap.amount }
      : null;
    const bo = swap
      ? await bestOut({ fromChainId: chainId, fromToken: address, ...swap }).catch(() => null)
      : null;
    const itemId = `${chainId}-${address}`.slice(0, 120);
    const noThresh = !it.upPct && !it.downPct && !it.above && !it.below;
    db.prepare(`INSERT OR REPLACE INTO watches VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      watchId,
      itemId,
      chainId,
      address,
      s.symbol,
      s.price,
      it.upPct ?? (noThresh ? 10 : null),
      it.downPct ?? (noThresh ? 10 : null),
      it.above ?? null,
      it.below ?? null,
      swap ? JSON.stringify(swap) : null,
      bo,
      s.price,
      Date.now(),
      null,
    );
    added.push(
      rowOut(
        db
          .prepare("SELECT * FROM watches WHERE watch_id=? AND item_id=?")
          .get(watchId, itemId) as Row,
      ),
    );
  }
  return {
    watchId,
    added,
    note: "Pull-based: call check_watches(watchId) whenever you want; nothing is pushed. Keep the watchId, it is the only key.",
  };
}
export function listWatches(db: DatabaseSync, watchId: string) {
  const rows = db
    .prepare("SELECT * FROM watches WHERE watch_id=? ORDER BY created_at")
    .all(watchId) as Row[];
  return { watchId, count: rows.length, items: rows.map(rowOut) };
}
export function removeWatch(db: DatabaseSync, watchId: string, itemId?: string) {
  const r = itemId
    ? db.prepare("DELETE FROM watches WHERE watch_id=? AND item_id=?").run(watchId, itemId)
    : db.prepare("DELETE FROM watches WHERE watch_id=?").run(watchId);
  return { watchId, removed: Number(r.changes) };
}
export async function checkWatches(f: F, db: DatabaseSync, watchId: string, bestOut: BestOut) {
  const rows = db.prepare("SELECT * FROM watches WHERE watch_id=?").all(watchId) as Row[];
  const triggered: unknown[] = [];
  const items: unknown[] = [];
  for (const r of rows) {
    const s = await spot(f, r.chain_id, r.address);
    const p = s.price;
    const ch = p && r.base_price ? ((p - r.base_price) / r.base_price) * 100 : null;
    const reasons: string[] = [];
    if (ch !== null && r.up_pct && ch >= r.up_pct)
      reasons.push(`up ${ch.toFixed(2)}% since watch started`);
    if (ch !== null && r.down_pct && ch <= -r.down_pct)
      reasons.push(`down ${Math.abs(ch).toFixed(2)}% since watch started`);
    if (p && r.above && p >= r.above) reasons.push(`price ${p} ≥ ${r.above}`);
    if (p && r.below && p <= r.below) reasons.push(`price ${p} ≤ ${r.below}`);
    const swap = r.swap
      ? (JSON.parse(r.swap) as { toChainId: number; toToken: string; amount: string })
      : null;
    let bo: number | null = null;
    if (swap) {
      bo = await bestOut({ fromChainId: r.chain_id, fromToken: r.address, ...swap }).catch(
        () => null,
      );
      if (bo && r.best_out && bo > r.best_out * 1.005)
        reasons.push(
          `better route: output up ${(((bo - r.best_out) / r.best_out) * 100).toFixed(2)}% (${r.best_out} → ${bo})`,
        );
    }
    db.prepare(
      "UPDATE watches SET last_price=?, checked_at=?, best_out=COALESCE(?, best_out), symbol=COALESCE(symbol, ?) WHERE watch_id=? AND item_id=?",
    ).run(p, Date.now(), bo, s.symbol, watchId, r.item_id);
    const to = swap ?? {
      toChainId: r.chain_id,
      toToken: usdcOf(r.chain_id) ?? NATIVE_TOKEN,
      amount: undefined,
    };
    const item = {
      ...rowOut(r),
      price: p,
      changePct: ch === null ? null : Math.round(ch * 100) / 100,
      currentBestOut: bo,
      triggered: reasons.length > 0,
      reasons,
      swapUrl: swapUrl(r.chain_id, r.address, to.toChainId, to.toToken, to.amount),
    };
    items.push(item);
    if (reasons.length) triggered.push(item);
  }
  return {
    watchId,
    checkedAt: new Date().toISOString(),
    triggeredCount: triggered.length,
    triggered,
    items,
    sources: [
      "DefiLlama prices",
      "DexScreener fallback",
      "SwapChan /quote for better-route checks",
    ],
  };
}

// ---------- 8. yields (DefiLlama) ----------
type Pool = {
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number | null;
  apyBase: number | null;
  apyReward: number | null;
  pool: string;
  stablecoin: boolean;
  ilRisk: string;
  exposure: string;
  outlier: boolean;
  underlyingTokens: string[] | null;
  predictions?: { predictedClass?: string };
};
const LLAMA_YIELD_CHAIN: Record<number, string> = {
  1: "Ethereum",
  8453: "Base",
  42161: "Arbitrum",
  10: "Optimism",
  137: "Polygon",
  56: "BSC",
  43114: "Avalanche",
  59144: "Linea",
  534352: "Scroll",
  [SOLANA]: "Solana",
  [TRON]: "Tron",
  [BITCOIN]: "Bitcoin",
};
export async function yields(
  f: F,
  opts: {
    asset?: string | undefined;
    chainId?: number | undefined;
    minTvlUsd?: number | undefined;
    stablecoinOnly?: boolean | undefined;
    limit?: number | undefined;
  },
) {
  const all = await cached(
    "llama:pools",
    900_000,
    async () =>
      (await json<{ data: Pool[] }>(f, "https://yields.llama.fi/pools", undefined, 30_000)).data,
  );
  const asset = opts.asset?.toUpperCase();
  const chainName2 = opts.chainId ? LLAMA_YIELD_CHAIN[opts.chainId] : undefined;
  const stableOnly = opts.stablecoinOnly ?? !asset;
  const minTvl = opts.minTvlUsd ?? 1_000_000;
  const rows = all
    .filter(
      (p) =>
        Object.values(LLAMA_YIELD_CHAIN).includes(p.chain) &&
        (!chainName2 || p.chain === chainName2),
    )
    .filter((p) => p.tvlUsd >= minTvl && p.apy !== null && p.apy > 0 && p.apy < 200 && !p.outlier)
    .filter(
      (p) =>
        (!stableOnly || p.stablecoin) &&
        (!asset ||
          p.symbol
            .toUpperCase()
            .split(/[-_ /]/)
            .includes(asset)),
    )
    .sort((a, b) => (b.apy ?? 0) - (a.apy ?? 0))
    .slice(0, Math.min(opts.limit ?? 15, 50));
  const idOf = Object.fromEntries(
    Object.entries(LLAMA_YIELD_CHAIN).map(([k, v]) => [v, Number(k)]),
  );
  return {
    filters: {
      asset: asset ?? null,
      chain: chainName2 ?? "all SwapChan chains",
      minTvlUsd: minTvl,
      stablecoinOnly: stableOnly,
    },
    count: rows.length,
    pools: rows.map((p) => {
      const cid = idOf[p.chain]!;
      const u = p.underlyingTokens?.[0];
      const notes: string[] = [];
      if (p.ilRisk === "yes") notes.push("impermanent loss risk");
      if ((p.apyReward ?? 0) > (p.apyBase ?? 0))
        notes.push("most APY is token rewards (can drop fast)");
      if (p.exposure === "multi") notes.push("LP position (multi-asset)");
      if (p.tvlUsd < 5_000_000) notes.push("smaller TVL");
      return {
        project: p.project,
        chain: p.chain,
        chainId: cid,
        symbol: p.symbol,
        apy: Math.round((p.apy ?? 0) * 100) / 100,
        apyBase: p.apyBase,
        apyReward: p.apyReward,
        tvlUsd: Math.round(p.tvlUsd),
        stablecoin: p.stablecoin,
        riskNotes: notes,
        llamaUrl: `https://defillama.com/yields/pool/${p.pool}`,
        swapIntoUnderlying:
          u &&
          vmOf(cid) === "evm" &&
          isAddress(u) &&
          u !== "0x0000000000000000000000000000000000000000"
            ? swapUrl(
                cid,
                usdcOf(cid)?.toLowerCase() === u.toLowerCase()
                  ? NATIVE_TOKEN
                  : (usdcOf(cid) ?? NATIVE_TOKEN),
                cid,
                getAddress(u),
              )
            : null,
      };
    }),
    note: "APYs are variable and not guaranteed. SwapChan swaps/bridges you into the underlying asset; depositing happens on the protocol's own site.",
    sources: ["DefiLlama yields (15 min cache)"],
  };
}

/** A few common ticker → CoinGecko-id shortcuts so the agent can pass "DOGE" as well as "dogecoin". */
const SYMBOL_GECKO: Record<string, string> = {
  btc: "bitcoin",
  eth: "ethereum",
  sol: "solana",
  doge: "dogecoin",
  ltc: "litecoin",
  bch: "bitcoin-cash",
  bnb: "binancecoin",
  xrp: "ripple",
  ada: "cardano",
  avax: "avalanche-2",
  matic: "polygon-ecosystem-token",
  pol: "polygon-ecosystem-token",
  usdc: "usd-coin",
  usdt: "tether",
  dai: "dai",
  trx: "tron",
};

/**
 * Historical USD price of a coin from DefiLlama's keyless coins API (the same source we price
 * everything with). `coin` is a CoinGecko id ("dogecoin"), a common ticker ("DOGE"), or an explicit
 * DefiLlama key ("ethereum:0x…"); `at` is a unix-seconds timestamp. With `span` > 0, also returns a
 * daily series from `at` forward so the agent can describe the trend. NOT live — a point in the past.
 */
export async function priceHistory(f: F, coin: string, at: number, span = 0) {
  const raw = coin.trim();
  const key = raw.includes(":")
    ? raw
    : `coingecko:${SYMBOL_GECKO[raw.toLowerCase()] ?? raw.toLowerCase()}`;
  const point = await f(
    `https://coins.llama.fi/prices/historical/${at}/${encodeURIComponent(key)}`,
    {
      signal: AbortSignal.timeout(6000),
    },
  )
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const c = (point as { coins?: Record<string, { price?: number; symbol?: string }> } | null)
    ?.coins?.[key];
  let series: { t: number; price: number }[] = [];
  if (span > 0) {
    const chart = await f(
      `https://coins.llama.fi/chart/${encodeURIComponent(key)}?start=${at}&span=${Math.min(span, 365)}&period=1d`,
      { signal: AbortSignal.timeout(6000) },
    )
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    series = (
      (
        chart as {
          coins?: Record<string, { prices?: { timestamp: number; price: number }[] }>;
        } | null
      )?.coins?.[key]?.prices ?? []
    ).map((p) => ({ t: p.timestamp, price: p.price }));
  }
  return {
    coin: key,
    symbol: c?.symbol ?? null,
    at,
    date: new Date(at * 1000).toISOString().slice(0, 10),
    priceUsd: c?.price ?? null,
    series,
    source: "DefiLlama coins API (coins.llama.fi/prices/historical), spot at that timestamp",
    note: "Historical spot price, not live. For a full chart use CoinGecko/CoinMarketCap.",
  };
}

// ---------- routes ----------
export function onchainRoutes(f: F, env: NodeJS.ProcessEnv, db: DatabaseSync, bestOut: BestOut) {
  const app = new Hono();
  const run = async (
    c: { json: (b: unknown, s?: 200 | 400 | 502) => Response },
    fn: () => Promise<unknown> | unknown,
  ) => {
    try {
      return c.json(await fn());
    } catch (e) {
      const bad = e instanceof BadRequest || e instanceof z.ZodError;
      return c.json({ error: (e as Error).message.slice(0, 300) }, bad ? 400 : 502);
    }
  };
  const need = (v: string | undefined, n: string) => {
    if (!v) throw new BadRequest(`${n} is required`);
    return v;
  };
  app.get("/balances", (c) =>
    run(c, () =>
      walletBalances(
        f,
        env,
        need(c.req.query("address"), "address"),
        c.req.query("chains")?.split(",").filter(Boolean).map(chainOf),
      ),
    ),
  );
  app.get("/approvals", (c) =>
    run(c, () =>
      approvals(
        f,
        env,
        need(c.req.query("owner"), "owner"),
        chainOf(need(c.req.query("chainId"), "chainId")),
      ),
    ),
  );
  app.get("/revoke", (c) =>
    run(c, () =>
      revokeTx(
        need(c.req.query("chainId"), "chainId"),
        need(c.req.query("token"), "token"),
        need(c.req.query("spender"), "spender"),
      ),
    ),
  );
  app.get("/tx", (c) =>
    run(c, () =>
      explainTx(
        f,
        env,
        chainOf(need(c.req.query("chainId"), "chainId")),
        need(c.req.query("hash"), "hash"),
      ),
    ),
  );
  app.get("/gas", (c) =>
    run(c, () => gas(f, env, c.req.query("chains")?.split(",").filter(Boolean).map(chainOf))),
  );
  app.get("/token", (c) =>
    run(c, () =>
      tokenInfo(
        f,
        env,
        chainOf(need(c.req.query("chainId"), "chainId")),
        need(c.req.query("address"), "address"),
      ),
    ),
  );
  app.get("/price-history", (c) =>
    run(c, () =>
      priceHistory(
        f,
        need(c.req.query("coin"), "coin"),
        Number(need(c.req.query("at"), "at")),
        c.req.query("span") ? Number(c.req.query("span")) : 0,
      ),
    ),
  );
  app.get("/name", (c) => run(c, () => resolveName(f, env, need(c.req.query("q"), "q"))));
  app.get("/yields", (c) =>
    run(c, () => {
      const q = c.req.query();
      return yields(f, {
        asset: q.asset,
        chainId: q.chainId ? chainOf(q.chainId) : undefined,
        minTvlUsd: q.minTvlUsd ? Number(q.minTvlUsd) : undefined,
        stablecoinOnly: q.stablecoinOnly === undefined ? undefined : q.stablecoinOnly === "true",
        limit: q.limit ? Number(q.limit) : undefined,
      });
    }),
  );
  app.post("/watches", (c) =>
    run(c, async () => {
      const b = z
        .object({ watchId: z.string(), items: z.array(WatchItem).min(1).max(50) })
        .parse(await c.req.json());
      return addWatch(f, db, b.watchId, b.items, bestOut);
    }),
  );
  app.get("/watches/:watchId", (c) => run(c, () => listWatches(db, c.req.param("watchId"))));
  app.get("/watches/:watchId/check", (c) =>
    run(c, () => checkWatches(f, db, c.req.param("watchId"), bestOut)),
  );
  app.delete("/watches/:watchId/:itemId?", (c) =>
    run(c, () => removeWatch(db, c.req.param("watchId"), c.req.param("itemId"))),
  );
  return app;
}
