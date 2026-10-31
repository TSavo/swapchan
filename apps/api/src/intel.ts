import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  BITCOIN,
  NATIVE_TOKEN,
  NON_EVM,
  playbook,
  SOLANA,
  TRON,
  tokenList,
  vmOf,
} from "@swapchan/shared";
import { Hono } from "hono";
import { erc20Abi, formatUnits, getAddress, isAddress, parseAbiItem } from "viem";
import { z } from "zod";
import { aaveSupplied } from "./aave.js";
import {
  blockscoutAbi,
  bytecodeSelectors,
  recoveryCandidates,
  resolveSelectors,
} from "./abiprobe.js";
import { beaconValidators } from "./beacon.js";
import { btDetectChains, btSelector, encodeFunctionData } from "./blocktools.js";
import { bridgeWithdrawals } from "./bridges.js";
import { eigenLayer } from "./eigen.js";
import { ensDeeds } from "./ensdeed.js";
import { ETH_FORKS, type EthFork, ethForkScan, forkSweep } from "./ethforks.js";
import { exitDeadline, minOut, NO_QUOTE_NOTE, PRIVATE_SUBMISSION_NOTE } from "./exitguard.js";
import { evmSweep, extraEvmScan } from "./extraevm.js";
import { clientIpOf, moneyWithFreshness } from "./fresh.js";
import { stakedLp, sushiChef } from "./gauges.js";
import { EVM_ROUTERS } from "./guard/allowlist.js";
import { recoveryGuide } from "./keyrecovery.js";
import {
  algoScan,
  atomScan,
  isXlmAddress,
  isXrpAddress,
  RECOGNISED_ONLY,
  recognisedOnly,
  signumAddress,
  signumScan,
  xlmScan,
  xrpScan,
} from "./ledgers.js";
import { adaScan, dotScan, tonScan } from "./ledgers2.js";
import { verifyApproval } from "./legacy/burnrefund.js";
import {
  REGISTRY,
  REGISTRY_ALLOWLIST,
  REGISTRY_APPROVALS,
  scanned as registryScanned,
  scanRegistry,
} from "./legacy/registry.js";
import { CALLER_ARG_SPECS, simClaimData } from "./legacy/simclaim.js";
import { hedgeyPlans, superfluidBalances, teamFinanceLocks, uncxLocks } from "./locks.js";
import { clPositions } from "./lp.js";
import { v4Positions } from "./lpv4.js";
import { lstQueues } from "./lst.js";
import {
  batchIpLimiter,
  batchStatus,
  initBatchStore,
  parseAddresses,
  BatchRateLimited as RateLimited,
  startBatch,
} from "./moneybatch.js";
import {
  ALL_IDS,
  approvals,
  BadRequest,
  chainName,
  chainOf,
  ETHERSCAN_FREE,
  EVM_IDS,
  EXPLORER,
  evmClient,
  gas,
  json,
  listed,
  NATIVE_SYMBOL,
  prices,
  pxOf,
  resolveName,
  SITE,
  STABLES,
  solRpc,
  swapUrl,
  tronAddr,
  usdcOf,
  walletBalances,
  yields,
} from "./onchain.js";
import { maturedPendle } from "./pendle.js";
import { perpsBalances } from "./perps.js";
import { READ_OPS, readChain } from "./readchain.js";
import { INCOMPLETE, safeReason, scrubText, tidyNotChecked } from "./reasons.js";
import {
  type Evidence,
  lidoWithdrawals,
  ownedSafes,
  recoveryFlow,
  setClaimCheck,
  solanaStake,
  verifyRecovery,
  wrappedNative,
} from "./recover.js";
import { recoverUrlSigned } from "./recoverSig.js";
import { daoRefunds } from "./refunds.js";
import { migrateLinksRetention } from "./retention.js";
import { BusyError, gate, recordScan, withScanScope } from "./scanctx.js";
import { cached, tokenRisk } from "./scanner.js";
import { kaminoObligations, marinadeTickets } from "./solstake.js";
import { tronExtras, tronV1Account } from "./tron2.js";
import { COINS, type Coin, coinOf, decodeAny, utxoSources, utxoSweep } from "./utxochains.js";
import { vaultList, vaultPositions } from "./vaults.js";
import { sablierStreams } from "./vesting.js";

// at most N full scans at once; the rest queue (and get a 503 after the wait) instead of piling up abandoned work
const scanGate = gate(
  Number(process.env.FIND_MAX_CONCURRENT ?? 4),
  Number(process.env.FIND_QUEUE_WAIT_MS ?? 30_000),
);
// POST /money/batch scans run behind their own gate, so a batch can never take the site's scan slots
const batchGate = gate(
  Number(process.env.FIND_BATCH_MAX_CONCURRENT ?? 2),
  Number(process.env.FIND_BATCH_QUEUE_WAIT_MS ?? 600_000),
);

import { fullAddress } from "./addrDisplay.js";
import {
  broadcastClientKey,
  broadcastExtra,
  broadcastLimiter,
  routeBroadcast,
} from "./broadcastmore.js";
import { burnAddressResult, isBurnAddress } from "./burnAddresses.js";
import { socketAddressOf } from "./clientip.js";
import { btcXpubScan, logPromoteCandidate, stuckMoneyRegistry } from "./stuck.js";
import { broadcastTx, signingGuide, txStatus, verifyTx } from "./txtools.js";

/**
 * Free "DeFi toolbox" readers (v0.3): simulate, wallet history/PnL, pools, whales, contract reader,
 * airdrops, market context, rebalance plans, bridge doctor, gas history and find_money.
 * Every source is free and keyless: public RPCs (eth_simulateV1, eth_feeHistory, eth_getLogs),
 * Solana public RPC, Blockscout (eth/optimism/scroll), Routescan (eth/avax), Sourcify, DexScreener,
 * GoPlus, RugCheck, DefiLlama (coins/yields/stablecoins/TVL), alternative.me, Hyperliquid, OKX,
 * Merkl, LI.FI/Across/Relay/deBridge/THORChain status APIs.
 */
type F = typeof fetch;
export type QuoteFn = (q: {
  fromChainId: number;
  fromToken: string;
  toChainId: number;
  toToken: string;
  amount: string;
}) => Promise<{ id: string; provider: string; toAmount: string; netUsd?: number | null } | null>;

const r2 = (n: number) => Math.round(n * 100) / 100;
const nativeOf = (id: number) => NON_EVM[id]?.native ?? NATIVE_TOKEN;
const isNative = (id: number, a: string) =>
  a === nativeOf(id) || a.toLowerCase() === NATIVE_TOKEN.toLowerCase() || /^0x0{40}$/i.test(a);
/** Contextual next step: every result ends in a prefilled SwapChan swap. */
export const cta = (label: string, url: string) => ({ label, swapUrl: url });
const DS_CHAIN: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  42161: "arbitrum",
  10: "optimism",
  137: "polygon",
  56: "bsc",
  43114: "avalanche",
  59144: "linea",
  534352: "scroll",
  [SOLANA]: "solana",
  [TRON]: "tron",
};
const BLOCKSCOUT: Record<number, string> = {
  1: "https://eth.blockscout.com",
  10: "https://optimism.blockscout.com",
  534352: "https://scroll.blockscout.com",
};
const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
/** Full address (EIP-55 for EVM), never shortened: lookalike addresses copy the ends. */
const short = fullAddress;
const toUsdc = (chainId: number, from: string, amount?: string) =>
  swapUrl(chainId, from, chainId, usdcOf(chainId) ?? nativeOf(chainId), amount);
const buy = (chainId: number, token: string) =>
  swapUrl(chainId, usdcOf(chainId) ?? nativeOf(chainId), chainId, token);

async function resolveAddr(f: F, env: NodeJS.ProcessEnv, input: string) {
  const s = input.trim();
  if (/\.(eth|sol)$/i.test(s) || /\.base\.eth$/i.test(s)) {
    const r = (await resolveName(f, env, s)) as { address?: string; addresses?: string[] };
    const a = r.address ?? r.addresses?.[0];
    if (!a) throw new BadRequest(`could not resolve ${s}`);
    return { address: a, name: s };
  }
  return { address: s, name: null as string | null };
}
/** "svm" only for a base58 string that decodes to a 32-byte ed25519 pubkey. BTC/DOGE/LTC legacy, Tron
 *  and XRP addresses also match the base58 charset but decode to 25 bytes (blocktools detectAddress sol = 32-byte key, fails closed); before this check they were
 *  classified "svm" and got Solana/Kamino sources and "Solana rent" lines. */
export const vmOfAddr = (a: string) =>
  isAddress(a)
    ? "evm"
    : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) && btDetectChains(a).includes("sol")
      ? "svm"
      : "other";

// ---------- 1. simulate_swap ----------
const ROUTERS_BY_CHAIN = (chainId: number) =>
  new Set(
    Object.values(EVM_ROUTERS).flatMap((m) =>
      [...(m[chainId] ?? []), ...(m["*"] ?? [])].map((x) => x.toLowerCase()),
    ),
  );
export const SimulateBody = z.object({
  chainId: z.union([z.number(), z.string()]),
  from: z.string(),
  to: z.string().optional(),
  data: z.string().optional(),
  value: z.string().optional(),
  /** Solana: base64 versioned tx. */
  tx: z.string().optional(),
  /** Optional ERC-20 approve to run first, so ERC-20 sells don't revert on allowance. */
  approve: z.object({ token: z.string(), spender: z.string(), amount: z.string() }).optional(),
});
export async function simulateSwap(
  f: F,
  env: NodeJS.ProcessEnv,
  body: z.infer<typeof SimulateBody>,
) {
  const chainId = chainOf(body.chainId);
  if (chainId === SOLANA) {
    if (!body.tx) throw new BadRequest("tx (base64) is required for Solana");
    const before = await solRpc<{ value: number }>(f, env, "getBalance", [body.from]);
    const r = await solRpc<{
      value: {
        err: unknown;
        logs: string[] | null;
        unitsConsumed?: number;
        accounts?: ({ lamports: number } | null)[];
      };
    }>(f, env, "simulateTransaction", [
      body.tx,
      {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: true,
        accounts: { encoding: "base64", addresses: [body.from] },
      },
    ]);
    const v = r.value;
    const after = v.accounts?.[0]?.lamports;
    return {
      chainId,
      chain: "Solana",
      ok: v.err === null,
      revertReason: v.err ? JSON.stringify(v.err) : null,
      computeUnits: v.unitsConsumed ?? null,
      balanceChanges:
        after === undefined
          ? []
          : [{ token: "SOL", address: nativeOf(chainId), delta: (after - before.value) / 1e9 }],
      logsTail: (v.logs ?? []).slice(-8),
      method: "Solana simulateTransaction (public RPC, sigVerify off)",
      coverage: "Solana: SOL delta of the signer; SPL deltas show in logs only.",
      next: cta("Execute this swap on SwapChan", SITE),
    };
  }
  if (vmOf(chainId) !== "evm") throw new BadRequest("simulation supports EVM chains and Solana");
  if (!body.to || !body.data) throw new BadRequest("to and data are required for EVM");
  const from = getAddress(body.from);
  const calls: Record<string, string>[] = [];
  if (body.approve)
    calls.push({
      from,
      to: getAddress(body.approve.token),
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [getAddress(body.approve.spender), BigInt(body.approve.amount)],
      }),
    });
  calls.push({
    from,
    to: getAddress(body.to),
    data: body.data,
    value: `0x${BigInt(body.value ?? "0").toString(16)}`,
  });
  const client = evmClient(chainId, env);
  type SimCall = {
    status: string;
    gasUsed: string;
    returnData: string;
    error?: { message: string; data?: string };
    logs: { address: string; topics: string[]; data: string }[];
  };
  const res = (await client.request({
    method: "eth_simulateV1" as never,
    params: [
      { blockStateCalls: [{ calls }], traceTransfers: true, validation: false },
      "latest",
    ] as never,
  })) as { calls: SimCall[] }[];
  const swap = res[0]?.calls.at(-1);
  if (!swap) throw new Error("empty simulation result");
  const deltas = new Map<string, bigint>();
  const me = from.toLowerCase();
  for (const c of res[0]!.calls)
    for (const l of c.logs) {
      if (
        l.topics[0] !== "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" ||
        l.topics.length < 3
      )
        continue;
      const fa = `0x${l.topics[1]!.slice(26)}`;
      const ta = `0x${l.topics[2]!.slice(26)}`;
      const amt = BigInt(l.data === "0x" ? 0 : l.data);
      const tok = l.address.toLowerCase();
      if (fa === me) deltas.set(tok, (deltas.get(tok) ?? 0n) - amt);
      if (ta === me) deltas.set(tok, (deltas.get(tok) ?? 0n) + amt);
    }
  const NATIVE_PSEUDO = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const changes = await Promise.all(
    [...deltas.entries()].map(async ([tok, d]) => {
      const nat = tok === NATIVE_PSEUDO;
      let symbol = NATIVE_SYMBOL[chainId] ?? "native";
      let decimals = 18;
      if (!nat) {
        const t = listed(chainId).find((x) => x.address.toLowerCase() === tok);
        if (t) {
          symbol = t.symbol;
          decimals = t.decimals;
        } else {
          const [s, dd] = await Promise.all([
            client
              .readContract({ address: getAddress(tok), abi: erc20Abi, functionName: "symbol" })
              .catch(() => "?"),
            client
              .readContract({ address: getAddress(tok), abi: erc20Abi, functionName: "decimals" })
              .catch(() => 18),
          ]);
          symbol = String(s);
          decimals = Number(dd);
        }
      }
      return {
        token: symbol,
        address: nat ? NATIVE_TOKEN : getAddress(tok),
        delta: Number(formatUnits(d, decimals)),
      };
    }),
  );
  const toAddr = getAddress(body.to).toLowerCase();
  const ok = swap.status === "0x1";
  const got = changes.find((c) => c.delta > 0);
  return {
    chainId,
    chain: chainName(chainId),
    ok,
    revertReason: ok ? null : (swap.error?.message ?? "reverted"),
    gasUsed: Number(BigInt(swap.gasUsed)),
    balanceChanges: changes,
    expectedOutput: got ?? null,
    guard: {
      routerAllowlisted: ROUTERS_BY_CHAIN(chainId).has(toAddr),
      claimAllowlisted: await simClaimAllowlisted(client, chainId, from, toAddr, body),
      note: "SwapChan's /build already decodes and verifies router, recipient, minOut and approvals before returning a tx; this re-checks the router allowlist on the tx you pass.",
    },
    hint:
      !ok &&
      /allowance|transfer amount exceeds|STF|TRANSFER_FROM_FAILED/i.test(swap.error?.message ?? "")
        ? "Looks like a missing ERC-20 approval: pass `approve` {token, spender, amount} to simulate approve+swap together."
        : undefined,
    method: "eth_simulateV1 with traceTransfers (public RPC)",
    next: cta(
      ok ? "Looks good. Execute it on SwapChan" : "Get a fresh best-price route on SwapChan",
      SITE,
    ),
  };
}

/** guard.claimAllowlisted for /simulate. A LegacyETH approval is only allowlisted up to the sender's token balance,
 *  so for an approve() to a registry token read balanceOf(from) at the simulated block ("latest") and pass it on.
 *  Fails closed: if that read fails, the approval is reported as not allowlisted. */
export async function simClaimAllowlisted(
  client: { readContract: (a: never) => Promise<unknown> },
  chainId: number,
  from: string,
  toAddr: string,
  body: { data?: string | undefined; value?: string | number | undefined },
): Promise<boolean> {
  if (chainId !== 1) return false;
  const tx = { to: toAddr, data: body.data ?? "0x", value: String(body.value ?? "0") };
  if (
    tx.data.slice(0, 10).toLowerCase() !== "0x095ea7b3" ||
    !(toAddr.toLowerCase() in REGISTRY_APPROVALS_LC())
  )
    return verifyClaimTx(tx, undefined, from).verified;
  let bal: bigint;
  try {
    bal = BigInt(
      (await client.readContract({
        address: getAddress(toAddr),
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [getAddress(from)],
        blockTag: "latest",
      } as never)) as bigint,
    );
  } catch {
    return false;
  }
  return verifyClaimTx(tx, bal).verified;
}
const REGISTRY_APPROVALS_LC = () =>
  Object.fromEntries(Object.entries(REGISTRY_APPROVALS).map(([k, v]) => [k.toLowerCase(), v]));

// ---------- 2. wallet_history + wallet_pnl ----------
/** Airdrop/phishing spam tokens: URL/claim-bait symbols, or nothing in the leg has a price. */
export const SPAM_SYMBOL =
  /(https?:|www\.|\.(com|io|org|net|xyz|cfd|top|site|online|app|fi|gift|lol|click|link|pro|vip|shop|live)\b|claim|visit|reward|airdrop|voucher|✅|\$\s?\d)/i;
export function isSpamLegs(ls: { symbol: string; usd?: number | null }[]) {
  if (!ls.length) return false;
  if (ls.some((l) => SPAM_SYMBOL.test(l.symbol) || /[^\x20-\x7e]/.test(l.symbol))) return true;
  return ls.every((l) => l.usd === null || l.usd === undefined);
}
interface Leg {
  chainId: number;
  address: string;
  symbol: string;
  amount: number;
}
export interface SwapEvent {
  chainId: number;
  chain: string;
  hash: string;
  time: string;
  sold: Leg[];
  bought: Leg[];
  explorer: string;
}

const HIST_CAP = 10_000;
/** Free Etherscan-compatible explorers with full account history. ETHERSCAN_API_KEY (free tier) unlocks every chain. */
function explorerApi(chainId: number, env: NodeJS.ProcessEnv) {
  const out: { name: string; url: (q: string) => string }[] = [];
  // Ethereum: Routescan (keyless) first. Etherscan's key is rate-limited per second across the whole process
  // (measured: half of one scan's ~40 Etherscan calls came back rate-limited); Routescan answered txlist/tokentx 2000 rows in 0.1-0.2 s and the items found were identical
  // (18/18 for one address). Etherscan then Blockscout stay as fallbacks.
  if (chainId === 1)
    out.push({
      name: "Routescan",
      url: (q) => `https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api?${q}`,
    });
  if (env.ETHERSCAN_API_KEY && ETHERSCAN_FREE.has(chainId))
    out.push({
      name: "Etherscan v2",
      url: (q: string) =>
        `https://api.etherscan.io/v2/api?chainid=${chainId}&${q}&apikey=${env.ETHERSCAN_API_KEY}`,
    });
  const bs: Record<number, string> = {
    1: "https://eth.blockscout.com/api",
    10: "https://optimism.blockscout.com/api",
    534352: "https://scroll.blockscout.com/api",
    59144: "https://api-explorer.linea.build/api",
  };
  const rs: Record<number, string> = {
    43114: "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api",
  };
  // Linea: its Blockscout returns the full history (measured for one address: 341 txs / 86 tokens vs Etherscan v2's
  // 0 / 44) and costs no Etherscan quota, so it goes first there; Etherscan stays the fallback.
  if (bs[chainId] && chainId === 59144)
    out.unshift({ name: "Blockscout", url: (q) => `${bs[chainId]}?${q}` });
  else if (bs[chainId]) out.push({ name: "Blockscout", url: (q) => `${bs[chainId]}?${q}` });
  if (rs[chainId]) out.push({ name: "Routescan", url: (q) => `${rs[chainId]}?${q}` });
  return out;
}

/** Alchemy network slugs for alchemy_getAssetTransfers (the one keyed source that covers Base/Arbitrum). */
const ALCHEMY_NET: Record<number, string> = {
  1: "eth-mainnet",
  10: "opt-mainnet",
  137: "polygon-mainnet",
  42161: "arb-mainnet",
  8453: "base-mainnet",
  43114: "avax-mainnet",
  59144: "linea-mainnet",
  534352: "scroll-mainnet",
};

/**
 * Interaction-native discovery via Alchemy getAssetTransfers: the token contracts the wallet
 * received/sent (every LP mint, staked-receipt, vault share lands here) plus the contracts it sent
 * native value to (staking deposits that mint no token). This is the only free-tier source that
 * serves Base/Arbitrum history, so archaeology works there instead of going blind. Returns null when
 * no key / unsupported chain.
 */
async function alchemyDiscover(
  f: F,
  env: NodeJS.ProcessEnv,
  chainId: number,
  owner: string,
): Promise<{ tokens: string[]; called: string[] } | null> {
  const net = ALCHEMY_NET[chainId];
  const key = env.ALCHEMY_API_KEY;
  if (!net || !key) return null;
  const url = `https://${net}.g.alchemy.com/v2/${key}`;
  const call = async (params: Record<string, unknown>) => {
    const res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "alchemy_getAssetTransfers",
        params: [params],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await res.json()) as {
      result?: { transfers?: { rawContract?: { address?: string }; to?: string }[] };
    };
    return j.result?.transfers ?? [];
  };
  const base = { fromBlock: "0x0", toBlock: "latest", maxCount: "0x3e8" };
  const [recv, sent, ext] = await Promise.all([
    call({ ...base, toAddress: owner, category: ["erc20"] }).catch(() => []),
    call({ ...base, fromAddress: owner, category: ["erc20"] }).catch(() => []),
    call({ ...base, fromAddress: owner, category: ["external"] }).catch(() => []),
  ]);
  const tokens = new Set<string>();
  for (const t of [...recv, ...sent]) {
    const a = t.rawContract?.address;
    if (a) tokens.add(a.toLowerCase());
  }
  const called = new Set<string>();
  for (const t of ext) if (t.to) called.add(t.to.toLowerCase());
  return { tokens: [...tokens], called: [...called] };
}
type ExRow = {
  blockNumber: string;
  hash: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  contractAddress?: string;
  tokenSymbol?: string;
  tokenDecimal?: string;
  isError?: string;
};
async function explorerAll(f: F, ex: { url: (q: string) => string }, owner: string) {
  let truncated = false;
  const page = async (action: string) => {
    const rows: ExRow[] = [];
    let endblock = "";
    // walk newest→oldest in pages of 1000 via endblock (avoids the 10k page×offset limit)
    for (let i = 0; i < HIST_CAP / 1000; i++) {
      const q = `module=account&action=${action}&address=${owner}&sort=desc&page=1&offset=1000${endblock ? `&endblock=${endblock}` : ""}`;
      let r: { message?: string; result: ExRow[] | string | null } = { result: null };
      for (let attempt = 0; ; attempt++) {
        try {
          r = await json(f, ex.url(q), undefined, 20_000);
          if (typeof r.result === "string" && /rate limit/i.test(r.result)) throw new Error("429");
          break;
        } catch (e) {
          if (attempt >= 3 || !/429/.test((e as Error).message)) throw e;
          await new Promise((ok) => setTimeout(ok, 1200 * (attempt + 1)));
        }
      }
      if (!Array.isArray(r.result)) {
        if (/No (transactions|token transfers|internal)/i.test(`${r.message} ${r.result}`))
          return rows;
        throw new Error(String(r.result ?? r.message));
      }
      const res: ExRow[] = r.result;
      if (res.length < 1000) {
        rows.push(...res);
        return rows;
      }
      const last: string = res[res.length - 1]!.blockNumber;
      const keep = res.filter((x) => x.blockNumber !== last);
      if (!keep.length) {
        rows.push(...res);
        return rows;
      }
      rows.push(...keep); // the boundary block is fetched whole on the next page
      endblock = last;
    }
    truncated = true;
    return rows;
  };
  // sequential: free explorers rate-limit parallel bursts
  const tok = await page("tokentx");
  const txs = await page("txlist");
  const internal = await page("txlistinternal").catch(() => [] as ExRow[]);
  const me = owner.toLowerCase();
  const rows = [
    ...tok.map((t) => ({
      hash: t.hash,
      ts: Number(t.timeStamp),
      token: getAddress(t.contractAddress ?? NATIVE_TOKEN),
      symbol: t.tokenSymbol || "?",
      dec: Number(t.tokenDecimal || 18),
      from: t.from.toLowerCase(),
      to: (t.to ?? "").toLowerCase(),
      value: BigInt(t.value || "0"),
    })),
    ...[...txs, ...internal]
      .filter((t) => t.isError !== "1" && t.value && t.value !== "0")
      .filter((t) => t.from.toLowerCase() === me || (t.to ?? "").toLowerCase() === me)
      .map((t) => ({
        hash: t.hash ?? (t as { transactionHash?: string }).transactionHash ?? "",
        ts: Number(t.timeStamp),
        token: NATIVE_TOKEN,
        symbol: "__native__",
        dec: 18,
        from: t.from.toLowerCase(),
        to: (t.to ?? "").toLowerCase(),
        value: BigInt(t.value),
      })),
  ];
  return { rows, truncated };
}
async function evmTransfers(f: F, env: NodeJS.ProcessEnv, chainId: number, owner: string) {
  const me = owner.toLowerCase();
  type T = {
    hash: string;
    ts: number;
    token: string;
    symbol: string;
    dec: number;
    from: string;
    to: string;
    value: bigint;
  };
  const out: T[] = [];
  // Full history via Etherscan-compatible account APIs (tokentx + txlist + txlistinternal).
  for (const ex of explorerApi(chainId, env)) {
    try {
      const all = await explorerAll(f, ex, owner);
      out.push(...all.rows);
      return {
        rows: out,
        source: `${ex.name} (full history${all.truncated ? `, newest ${HIST_CAP} rows per kind` : ""})`,
        full: !all.truncated,
      };
    } catch (e) {
      if (process.env.DEBUG_HIST) console.error("explorer", ex.name, e);
    }
  }
  const c = evmClient(chainId, env);
  const head = await c.getBlockNumber();
  const span = 9_000n;
  const chunks = 5;
  const logs = (
    await Promise.all(
      Array.from({ length: chunks }, (_, i) => {
        const toB = head - BigInt(i) * (span + 1n);
        const fromB = toB - span;
        return Promise.all([
          c
            .getLogs({
              event: TRANSFER,
              args: { from: getAddress(owner) },
              fromBlock: fromB,
              toBlock: toB,
            })
            .catch(() => []),
          c
            .getLogs({
              event: TRANSFER,
              args: { to: getAddress(owner) },
              fromBlock: fromB,
              toBlock: toB,
            })
            .catch(() => []),
        ]);
      }),
    )
  ).flat(2);
  const toks = [...new Set(logs.map((l) => l.address.toLowerCase()))].slice(0, 40);
  const meta = new Map<string, { s: string; d: number }>();
  await Promise.all(
    toks.map(async (t) => {
      const lt = listed(chainId).find((x) => x.address.toLowerCase() === t);
      if (lt) return meta.set(t, { s: lt.symbol, d: lt.decimals });
      const [s, d] = await Promise.all([
        c
          .readContract({ address: getAddress(t), abi: erc20Abi, functionName: "symbol" })
          .catch(() => "?"),
        c
          .readContract({ address: getAddress(t), abi: erc20Abi, functionName: "decimals" })
          .catch(() => 18),
      ]);
      meta.set(t, { s: String(s), d: Number(d) });
    }),
  );
  const blocks = new Map<bigint, number>();
  for (const l of logs) {
    const m = meta.get(l.address.toLowerCase());
    if (!m || l.blockNumber === null) continue;
    blocks.set(l.blockNumber, 0);
    out.push({
      hash: l.transactionHash!,
      ts: Number(l.blockNumber),
      token: getAddress(l.address),
      symbol: m.s,
      dec: m.d,
      from: (l.args.from ?? "").toLowerCase(),
      to: (l.args.to ?? "").toLowerCase(),
      value: l.args.value ?? 0n,
    });
  }
  // block -> timestamp (only for the newest 30 distinct blocks)
  const bn = [...blocks.keys()].sort((a, b) => Number(b - a)).slice(0, 30);
  await Promise.all(
    bn.map(async (b) => blocks.set(b, Number((await c.getBlock({ blockNumber: b })).timestamp))),
  );
  for (const r of out) r.ts = blocks.get(BigInt(r.ts)) || 0;
  void me;
  return {
    rows: out.filter((r) => r.ts > 0),
    source:
      "public RPC eth_getLogs (~45k recent blocks; no free full-history explorer for this chain)",
    full: false,
  };
}

async function evmSwaps(f: F, env: NodeJS.ProcessEnv, chainId: number, owner: string) {
  const { rows, source, full } = await evmTransfers(f, env, chainId, owner);
  const me = owner.toLowerCase();
  const byTx = new Map<string, typeof rows>();
  for (const r of rows) byTx.set(r.hash, [...(byTx.get(r.hash) ?? []), r]);
  const swaps: SwapEvent[] = [];
  for (const [hash, rs] of byTx) {
    const net = new Map<string, { s: string; v: number }>();
    for (const r of rs) {
      const amt = Number(formatUnits(r.value, r.dec));
      const k = r.token;
      const cur = net.get(k) ?? {
        s: r.symbol === "__native__" ? (NATIVE_SYMBOL[chainId] ?? "ETH") : r.symbol,
        v: 0,
      };
      if (r.from === me) cur.v -= amt;
      if (r.to === me) cur.v += amt;
      net.set(k, cur);
    }
    const legs = [...net.entries()].map(([address, x]) => ({
      chainId,
      address,
      symbol: x.s,
      amount: x.v,
    }));
    const sold = legs.filter((l) => l.amount < 0).map((l) => ({ ...l, amount: -l.amount }));
    const bought = legs.filter((l) => l.amount > 0);
    // one-sided token legs are swaps against native ETH (native leg not visible in token transfers)
    if (!sold.length && !bought.length) continue;
    if (legs.every((l) => l.address === NATIVE_TOKEN)) continue; // plain native send/receive
    swaps.push({
      chainId,
      chain: chainName(chainId),
      hash,
      time: new Date(rs[0]!.ts * 1000).toISOString(),
      sold,
      bought,
      explorer: `${EXPLORER[chainId]}/tx/${hash}`,
    });
  }
  return { swaps, source, full };
}

async function solSwaps(f: F, env: NodeJS.ProcessEnv, owner: string, limit = 20) {
  const sigs = await solRpc<{ signature: string; blockTime: number | null; err: unknown }[]>(
    f,
    env,
    "getSignaturesForAddress",
    [owner, { limit }],
  );
  type Bal = { owner?: string; mint: string; uiTokenAmount: { uiAmount: number | null } };
  const txs = await Promise.all(
    sigs
      .filter((s) => !s.err)
      .map((s) =>
        solRpc<{
          blockTime: number;
          meta: {
            fee: number;
            preBalances: number[];
            postBalances: number[];
            preTokenBalances: Bal[];
            postTokenBalances: Bal[];
          };
          transaction: { message: { accountKeys: { pubkey: string }[] } };
        } | null>(f, env, "getTransaction", [
          s.signature,
          { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
        ])
          .then((t) => ({ sig: s.signature, t }))
          .catch(() => ({ sig: s.signature, t: null })),
      ),
  );
  const mints = new Set<string>();
  const swaps: SwapEvent[] = [];
  for (const { sig, t } of txs) {
    if (!t?.meta) continue;
    const net = new Map<string, number>();
    for (const b of t.meta.preTokenBalances ?? [])
      if (b.owner === owner)
        net.set(b.mint, (net.get(b.mint) ?? 0) - (b.uiTokenAmount.uiAmount ?? 0));
    for (const b of t.meta.postTokenBalances ?? [])
      if (b.owner === owner)
        net.set(b.mint, (net.get(b.mint) ?? 0) + (b.uiTokenAmount.uiAmount ?? 0));
    const idx = t.transaction.message.accountKeys.findIndex((k) => k.pubkey === owner);
    if (idx >= 0) {
      const sol =
        (t.meta.postBalances[idx]! - t.meta.preBalances[idx]! + (idx === 0 ? t.meta.fee : 0)) / 1e9;
      if (Math.abs(sol) > 0.001) net.set(nativeOf(SOLANA), (net.get(nativeOf(SOLANA)) ?? 0) + sol);
    }
    const legs = [...net.entries()].filter(([, v]) => Math.abs(v) > 1e-9);
    const sold = legs.filter(([, v]) => v < 0);
    const bought = legs.filter(([, v]) => v > 0);
    if (!sold.length || !bought.length) continue;
    for (const [m] of legs) mints.add(m);
    const L = (m: string, v: number) => ({
      chainId: SOLANA,
      address: m,
      symbol:
        m === nativeOf(SOLANA)
          ? "SOL"
          : (listed(SOLANA).find((x) => x.address === m)?.symbol ?? short(m)),
      amount: Math.abs(v),
    });
    swaps.push({
      chainId: SOLANA,
      chain: "Solana",
      hash: sig,
      time: new Date(t.blockTime * 1000).toISOString(),
      sold: sold.map(([m, v]) => L(m, v)),
      bought: bought.map(([m, v]) => L(m, v)),
      explorer: `${EXPLORER[SOLANA]}/tx/${sig}`,
    });
  }
  return { swaps, source: `Solana RPC (last ${limit} signatures)` };
}

const LLAMA_NATIVE: Record<number, string> = {
  [SOLANA]: "coingecko:solana",
  43114: "coingecko:avalanche-2",
  137: "coingecko:polygon-ecosystem-token",
  56: "coingecko:binancecoin",
};
export async function walletHistory(
  f: F,
  env: NodeJS.ProcessEnv,
  input: string,
  chain?: string,
  priceN = 40,
  twoSidedOnly = false,
) {
  const { address, name } = await resolveAddr(f, env, input);
  return cached(`hist:${address}:${chain ?? ""}:${priceN}:${twoSidedOnly}`, 300_000, async () => {
    const vm = vmOfAddr(address);
    let swaps: SwapEvent[] = [];
    const sources: string[] = [];
    const errors: { chain: string; error: string }[] = [];
    const perChain: { chain: string; source: string; fullHistory: boolean; swaps: number }[] = [];
    if (vm === "svm") {
      const r = await solSwaps(f, env, address);
      swaps = r.swaps;
      sources.push(r.source);
    } else if (vm === "evm") {
      const ids = chain ? [chainOf(chain)] : [1, 8453, 42161, 10, 43114, 534352];
      const rs = await Promise.all(
        ids.map((id) =>
          evmSwaps(f, env, id, address)
            .then((r) => {
              perChain.push({
                chain: chainName(id),
                source: r.source,
                fullHistory: r.full,
                swaps: r.swaps.length,
              });
              return r;
            })
            .catch((e) => {
              errors.push({ chain: chainName(id), error: (e as Error).message.slice(0, 100) });
              return { swaps: [], source: "", full: false };
            }),
        ),
      );
      swaps = rs.flatMap((r) => r.swaps);
      sources.push(...new Set(rs.map((r) => r.source).filter(Boolean)));
    } else throw new BadRequest("history supports EVM and Solana addresses");
    swaps.sort((a, b) => b.time.localeCompare(a.time));
    // price the legs at swap time (DefiLlama batchHistorical, free)
    const want = new Map<string, number[]>();
    const lid = (l: Leg) =>
      isNative(l.chainId, l.address)
        ? (LLAMA_NATIVE[l.chainId] ?? "coingecko:ethereum")
        : `${DS_LLAMA[l.chainId]}:${l.chainId === SOLANA ? l.address : l.address.toLowerCase()}`;
    // PnL needs real swaps; airdrop/spam receives would otherwise crowd out the priced window.
    const top = (
      twoSidedOnly ? swaps.filter((s) => s.sold.length && s.bought.length) : swaps
    ).slice(0, priceN);
    for (const s of top)
      for (const l of [...s.sold, ...s.bought])
        want.set(lid(l), [...(want.get(lid(l)) ?? []), Math.floor(Date.parse(s.time) / 1000)]);
    const hist = new Map<string, { timestamp: number; price: number }[]>();
    if (want.size) {
      // batch in small groups (URL length); cap timestamps per coin
      const entries = [...want.entries()].map(
        ([k, ts]) => [k, [...new Set(ts)].slice(0, 60)] as const,
      );
      const groups: (typeof entries)[] = [];
      for (let i = 0; i < Math.min(entries.length, 150); i += 15)
        groups.push(entries.slice(i, i + 15));
      await Promise.all(
        groups.map(async (g) => {
          try {
            const r = await json<{
              coins: Record<string, { prices: { timestamp: number; price: number }[] }>;
            }>(
              f,
              `https://coins.llama.fi/batchHistorical?coins=${encodeURIComponent(JSON.stringify(Object.fromEntries(g)))}&searchWidth=6h`,
              undefined,
              20_000,
            );
            for (const [k, v] of Object.entries(r.coins ?? {})) hist.set(k, v.prices);
          } catch (e) {
            errors.push({ chain: "prices", error: (e as Error).message });
          }
        }),
      );
      sources.push("DefiLlama historical prices");
    }
    const pxAt = (l: Leg, t: number) => {
      const p = hist.get(lid(l));
      if (!p?.length) return null;
      return p.reduce((a, b) => (Math.abs(b.timestamp - t) < Math.abs(a.timestamp - t) ? b : a))
        .price;
    };
    const priced = top.map((s) => {
      const t = Math.floor(Date.parse(s.time) / 1000);
      const v = (ls: Leg[]) =>
        ls.map((l) => ({ ...l, usd: pxAt(l, t) === null ? null : r2(pxAt(l, t)! * l.amount) }));
      return {
        ...s,
        sold: v(s.sold),
        bought: v(s.bought),
        kind:
          s.sold.length && s.bought.length
            ? "swap"
            : s.bought.length
              ? isSpamLegs(v(s.bought))
                ? "unsolicited/spam receive"
                : "receive/buy-with-native"
              : isSpamLegs(v(s.sold))
                ? "spam-token send (unsolicited token moved out)"
                : "send/sell-for-native",
      };
    });
    const last = priced.find((s) => s.bought.length);
    const lb = last?.bought[0];
    return {
      address,
      ...(name ? { name } : {}),
      count: swaps.length,
      priced: priced.length,
      swaps: priced.slice(0, 40),
      allPriced: priced,
      perChain,
      sources,
      errors,
      coverage:
        vm === "svm"
          ? "Solana: last 20 signatures, token + SOL deltas of this owner."
          : "EVM: full account history (ERC-20 + native + internal transfers, grouped by tx) from free Etherscan-compatible explorers on Ethereum, Optimism, Scroll (Blockscout) and Avalanche (Routescan); Base and Arbitrum explorers block keyless access, so those fall back to the last ~45k blocks via public RPC unless ETHERSCAN_API_KEY is set. See perChain.",
      next: lb
        ? cta(`Sell or add to your ${lb.symbol} on SwapChan`, toUsdc(lb.chainId, lb.address))
        : cta("Make your first SwapChan swap", SITE),
    };
  });
}
const DS_LLAMA: Record<number, string> = {
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
};

export async function walletPnl(f: F, env: NodeJS.ProcessEnv, input: string, chain?: string) {
  const h0 = await walletHistory(f, env, input, chain, 300, true);
  const h = { ...h0, swaps: h0.allPriced };
  const bal = (await walletBalances(f, env, h.address).catch(() => null)) as {
    holdings?: {
      chainId: number;
      address: string;
      symbol: string;
      balance: string;
      priceUsd: number | null;
    }[];
  } | null;
  type P = {
    chainId: number;
    address: string;
    symbol: string;
    inQty: number;
    inUsd: number;
    outQty: number;
    outUsd: number;
  };
  const pos = new Map<string, P>();
  const key = (l: Leg) => `${l.chainId}:${l.address.toLowerCase()}`;
  for (const s of h.swaps) {
    if (s.kind !== "swap") continue;
    for (const l of s.bought) {
      if (l.usd === null) continue;
      const p = pos.get(key(l)) ?? {
        chainId: l.chainId,
        address: l.address,
        symbol: l.symbol,
        inQty: 0,
        inUsd: 0,
        outQty: 0,
        outUsd: 0,
      };
      p.inQty += l.amount;
      p.inUsd += l.usd;
      pos.set(key(l), p);
    }
    for (const l of s.sold) {
      if (l.usd === null) continue;
      const p = pos.get(key(l)) ?? {
        chainId: l.chainId,
        address: l.address,
        symbol: l.symbol,
        inQty: 0,
        inUsd: 0,
        outQty: 0,
        outUsd: 0,
      };
      p.outQty += l.amount;
      p.outUsd += l.usd;
      pos.set(key(l), p);
    }
  }
  const rows = [...pos.values()]
    .filter((p) => !STABLES.has(p.symbol.toUpperCase()))
    .map((p) => {
      const avg = p.inQty ? p.inUsd / p.inQty : null;
      const realized = avg !== null ? p.outUsd - Math.min(p.outQty, p.inQty) * avg : null;
      const hold = bal?.holdings?.find(
        (x) => x.chainId === p.chainId && x.address.toLowerCase() === p.address.toLowerCase(),
      );
      const qty = hold ? Number(hold.balance) : 0;
      const unreal = avg !== null && hold?.priceUsd ? qty * (hold.priceUsd - avg) : null;
      return {
        ...p,
        inUsd: r2(p.inUsd),
        outUsd: r2(p.outUsd),
        avgCostUsd: avg,
        currentQty: qty,
        currentPriceUsd: hold?.priceUsd ?? null,
        realizedUsd: realized === null ? null : r2(realized),
        unrealizedUsd: unreal === null ? null : r2(unreal),
        swapUrl: qty > 0 ? toUsdc(p.chainId, p.address) : buy(p.chainId, p.address),
      };
    })
    .sort(
      (a, b) =>
        Math.abs(b.unrealizedUsd ?? 0) +
        Math.abs(b.realizedUsd ?? 0) -
        Math.abs(a.unrealizedUsd ?? 0) -
        Math.abs(a.realizedUsd ?? 0),
    );
  const tot = (k: "realizedUsd" | "unrealizedUsd") => r2(rows.reduce((s, r) => s + (r[k] ?? 0), 0));
  const best = rows.find((r) => (r.unrealizedUsd ?? 0) > 0 && r.currentQty > 0);
  const worst = rows.find((r) => (r.unrealizedUsd ?? 0) < 0 && r.currentQty > 0);
  return {
    address: h.address,
    realizedUsd: tot("realizedUsd"),
    unrealizedUsd: tot("unrealizedUsd"),
    tokens: rows.slice(0, 30),
    swapsAnalyzed: h.swaps.filter((s) => s.kind === "swap").length,
    method:
      "Average-cost basis from the newest 300 swaps across the wallet's full explorer history (see perChain), legs incl. native ETH priced at swap time (DefiLlama); unrealized = current balance × (price − avg cost).",
    caveat:
      "Estimate only: plain transfers in/out and airdrops are not cost basis; unpriced (spam/illiquid) legs are skipped; Base/Arbitrum use a ~45k-block window without an Etherscan key.",
    perChain: h0.perChain,
    coverage: h.coverage,
    sources: [...h.sources, "wallet balances"],
    next: best
      ? cta(`Take profit on ${best.symbol} (+$${best.unrealizedUsd}) on SwapChan`, best.swapUrl)
      : worst
        ? cta(`Cut or average down ${worst.symbol} on SwapChan`, worst.swapUrl)
        : cta("Swap at the best price on SwapChan", SITE),
  };
}

// ---------- 3. token_pools ----------
interface DsPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  url: string;
  labels?: string[];
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number; base?: number; quote?: number };
  volume?: { h24?: number };
  txns?: { h24?: { buys: number; sells: number } };
  pairCreatedAt?: number;
}
const SIZES = [1_000, 10_000, 100_000];
export async function tokenPools(f: F, chainIdIn: string | number, address: string) {
  const chainId = chainOf(chainIdIn);
  const ds = DS_CHAIN[chainId];
  if (!ds) throw new BadRequest("pools: unsupported chain");
  return cached(`pools:${chainId}:${address}`, 60_000, async () => {
    const pairs = await json<DsPair[]>(
      f,
      `https://api.dexscreener.com/token-pairs/v1/${ds}/${address}`,
    );
    const sources = ["DexScreener"];
    const locks = new Map<string, { lockedPct: number; burnedPct: number; lockers: string[] }>();
    if (vmOf(chainId) === "evm") {
      try {
        const g = await json<{
          result: Record<
            string,
            {
              lp_holders?: { address: string; percent: string; is_locked: number; tag?: string }[];
              is_in_dex?: string;
            }
          >;
        }>(
          f,
          `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${address.toLowerCase()}`,
        );
        const t = Object.values(g.result ?? {})[0];
        if (t?.lp_holders?.length) {
          const dead = (a: string) => /^0x0{40}$|^0x0{36}dead$/i.test(a);
          locks.set("*", {
            lockedPct: r2(
              t.lp_holders
                .filter((h) => h.is_locked && !dead(h.address))
                .reduce((s, h) => s + Number(h.percent) * 100, 0),
            ),
            burnedPct: r2(
              t.lp_holders
                .filter((h) => dead(h.address))
                .reduce((s, h) => s + Number(h.percent) * 100, 0),
            ),
            lockers: [
              ...new Set(
                t.lp_holders.filter((h) => h.is_locked).map((h) => h.tag ?? short(h.address)),
              ),
            ],
          });
          sources.push("GoPlus LP holders (main v2-style pool)");
        }
      } catch {}
    } else if (chainId === SOLANA) {
      try {
        const r = await json<{ markets?: { pubkey: string; lp?: { lpLockedPct?: number } }[] }>(
          f,
          `https://api.rugcheck.xyz/v1/tokens/${address}/report`,
          undefined,
          15_000,
        );
        for (const m of r.markets ?? [])
          if (m.lp?.lpLockedPct !== undefined)
            locks.set(m.pubkey, { lockedPct: r2(m.lp.lpLockedPct), burnedPct: 0, lockers: [] });
        sources.push("RugCheck markets");
      } catch {}
    }
    const rows = (pairs ?? [])
      .filter((p) => (p.liquidity?.usd ?? 0) > 0)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))
      .slice(0, 15)
      .map((p) => {
        const L = p.liquidity?.usd ?? 0;
        const conc =
          (p.labels ?? []).some((l) => /v3|v4|clmm|dlmm|whirlpool/i.test(l)) ||
          /v3|clmm|dlmm|whirlpool/i.test(p.dexId);
        return {
          dex: p.dexId,
          labels: p.labels ?? [],
          pair: `${p.baseToken.symbol}/${p.quoteToken.symbol}`,
          pairAddress: p.pairAddress,
          liquidityUsd: L,
          volume24hUsd: p.volume?.h24 ?? null,
          txns24h: p.txns?.h24 ?? null,
          createdAt: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : null,
          priceImpactPct: Object.fromEntries(
            SIZES.map((s) => [`$${s / 1000}k`, r2((s / (L / 2 + s)) * 100)]),
          ),
          impactModel: conc
            ? "constant-product estimate (concentrated pool: real impact can be lower in range, higher out of range)"
            : "constant-product estimate",
          lp:
            locks.get(p.pairAddress) ??
            (locks.has("*") && p === pairs[0] ? locks.get("*") : null) ??
            null,
          url: p.url,
        };
      });
    const total = rows.reduce((s, r) => s + r.liquidityUsd, 0);
    const sym =
      pairs?.[0]?.baseToken.address.toLowerCase() === address.toLowerCase()
        ? pairs[0]!.baseToken.symbol
        : (pairs?.[0]?.quoteToken.symbol ?? "token");
    const best1k = rows[0] ? rows[0].priceImpactPct["$1k"] : null;
    return {
      chainId,
      chain: chainName(chainId),
      address,
      symbol: sym,
      pools: rows,
      totalLiquidityUsd: r2(total),
      lpLock: locks.get("*") ?? null,
      sources,
      note: "Price impact = size / (poolLiquidity/2 + size), per pool. SwapChan splits across pools and aggregators, so the real route usually beats any single pool.",
      next: cta(
        `Buy ${sym} with the best route across all ${rows.length} pools on SwapChan${best1k !== null ? ` (single-pool impact at $1k ≈ ${best1k}%)` : ""}`,
        buy(chainId, address),
      ),
    };
  });
}

// ---------- 4. whale_watch ----------
export async function whaleWatch(
  f: F,
  env: NodeJS.ProcessEnv,
  chainIdIn: string | number,
  address: string,
  minUsd = 25_000,
) {
  const chainId = chainOf(chainIdIn);
  return cached(`whale:${chainId}:${address}:${minUsd}`, 60_000, async () => {
    const pools = await tokenPools(f, chainId, address).catch(() => null);
    const poolSet = new Set((pools?.pools ?? []).map((p) => p.pairAddress.toLowerCase()));
    const sym = pools?.symbol ?? "token";
    if (chainId === SOLANA) {
      const r = await json<{
        creator?: string;
        topHolders?: { owner: string; pct: number; uiAmount: number; insider?: boolean }[];
        insiderNetworks?: unknown[];
      }>(f, `https://api.rugcheck.xyz/v1/tokens/${address}/report`, undefined, 15_000);
      return {
        chainId,
        chain: "Solana",
        address,
        symbol: sym,
        transfers: [],
        topHolders: (r.topHolders ?? []).slice(0, 10).map((h) => ({
          owner: h.owner,
          pct: r2(h.pct),
          amount: h.uiAmount,
          insider: !!h.insider,
        })),
        deployer: r.creator ? { address: r.creator } : null,
        coverage:
          "Solana: top holders + creator from RugCheck; a live large-transfer feed is not available from free sources.",
        sources: ["RugCheck"],
        next: cta(`Trade ${sym} on SwapChan`, buy(chainId, address)),
      };
    }
    if (vmOf(chainId) !== "evm") throw new BadRequest("whale_watch supports EVM chains and Solana");
    const c = evmClient(chainId, env);
    const tok = getAddress(address);
    const [dec, head, px, gp] = await Promise.all([
      c.readContract({ address: tok, abi: erc20Abi, functionName: "decimals" }),
      c.getBlockNumber(),
      prices(f, [{ chainId, address: tok }]),
      json<{
        result: Record<
          string,
          { creator_address?: string; owner_address?: string; creator_percent?: string }
        >;
      }>(
        f,
        `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${tok.toLowerCase()}`,
      ).catch(() => null),
    ]);
    const price = pxOf(px, chainId, tok)?.price ?? (pools?.pools[0] ? null : null);
    const span = chainId === 1 ? 1_500n : 5_000n;
    const logs = (
      await Promise.all(
        [0n, 1n].map((i) => {
          const to = head - i * (span + 1n);
          return c
            .getLogs({ address: tok, event: TRANSFER, fromBlock: to - span, toBlock: to })
            .catch(() => []);
        }),
      )
    ).flat();
    const g = gp ? Object.values(gp.result ?? {})[0] : undefined;
    const dev = [g?.creator_address, g?.owner_address]
      .filter((x): x is string => !!x && !/^0x0{40}$/i.test(x))
      .map((x) => x.toLowerCase());
    const rows = logs
      .map((l) => {
        const amt = Number(formatUnits(l.args.value ?? 0n, Number(dec)));
        const from = (l.args.from ?? "").toLowerCase();
        const to = (l.args.to ?? "").toLowerCase();
        return {
          hash: l.transactionHash,
          block: Number(l.blockNumber),
          from,
          to,
          amount: amt,
          usd: price ? r2(amt * price) : null,
          kind: poolSet.has(from) ? "buy" : poolSet.has(to) ? "sell" : "transfer",
          devWallet: dev.includes(from)
            ? "from deployer/owner"
            : dev.includes(to)
              ? "to deployer/owner"
              : null,
        };
      })
      .filter((r) => (r.usd ?? 0) >= minUsd || r.devWallet);
    rows.sort((a, b) => b.block - a.block);
    const devSells = rows.filter((r) => r.devWallet === "from deployer/owner");
    const sells = rows.filter((r) => r.kind === "sell").reduce((s, r) => s + (r.usd ?? 0), 0);
    const buys = rows.filter((r) => r.kind === "buy").reduce((s, r) => s + (r.usd ?? 0), 0);
    return {
      chainId,
      chain: chainName(chainId),
      address: tok,
      symbol: sym,
      minUsd,
      priceUsd: price,
      window: `last ~${Number(span * 2n)} blocks`,
      whaleBuysUsd: r2(buys),
      whaleSellsUsd: r2(sells),
      transfers: rows
        .slice(0, 40)
        .map((r) => ({ ...r, explorer: `${EXPLORER[chainId]}/tx/${r.hash}` })),
      deployer: dev.length
        ? {
            addresses: dev,
            creatorHoldsPct: g?.creator_percent ? r2(Number(g.creator_percent) * 100) : null,
            movedInWindow: devSells.length,
          }
        : null,
      alert: devSells.length
        ? `Deployer/owner wallet moved tokens out ${devSells.length}× in this window`
        : null,
      sources: [
        "public RPC eth_getLogs",
        "DexScreener pools (buy/sell labels)",
        "GoPlus creator/owner",
        "DefiLlama price",
      ],
      next:
        devSells.length || sells > buys * 2
          ? cta(`Whales/dev are selling ${sym}: exit to USDC on SwapChan`, toUsdc(chainId, tok))
          : cta(
              `Whales are ${buys > sells ? "buying" : "quiet on"} ${sym}: trade it on SwapChan`,
              buy(chainId, tok),
            ),
    };
  });
}

// ---------- 5. contract_reader ----------
const POWERS: { sig: string; power: string; risk: "high" | "medium" | "low" }[] = [
  { sig: "mint(address,uint256)", power: "mint new tokens", risk: "high" },
  { sig: "mint(uint256)", power: "mint new tokens", risk: "high" },
  { sig: "pause()", power: "pause transfers", risk: "medium" },
  { sig: "unpause()", power: "unpause transfers", risk: "low" },
  { sig: "blacklist(address)", power: "blacklist addresses", risk: "high" },
  { sig: "addBlackList(address)", power: "blacklist addresses", risk: "high" },
  { sig: "addToBlacklist(address)", power: "blacklist addresses", risk: "high" },
  { sig: "setBlacklist(address,bool)", power: "blacklist addresses", risk: "high" },
  { sig: "blockAccount(address)", power: "block accounts", risk: "high" },
  { sig: "freeze(address)", power: "freeze accounts", risk: "high" },
  { sig: "setFee(uint256)", power: "change fees", risk: "medium" },
  { sig: "setFees(uint256,uint256)", power: "change buy/sell fees", risk: "high" },
  { sig: "setTaxes(uint256,uint256)", power: "change buy/sell taxes", risk: "high" },
  { sig: "setTaxFeePercent(uint256)", power: "change tax", risk: "high" },
  { sig: "setMaxTxAmount(uint256)", power: "limit max transaction", risk: "medium" },
  { sig: "excludeFromFee(address)", power: "exempt addresses from fees", risk: "low" },
  { sig: "setTradingEnabled(bool)", power: "toggle trading", risk: "high" },
  { sig: "enableTrading()", power: "enable trading (could have been off)", risk: "medium" },
  { sig: "upgradeTo(address)", power: "upgrade implementation", risk: "high" },
  { sig: "upgradeToAndCall(address,bytes)", power: "upgrade implementation", risk: "high" },
  { sig: "transferOwnership(address)", power: "transfer ownership", risk: "low" },
  { sig: "renounceOwnership()", power: "renounce ownership", risk: "low" },
  { sig: "owner()", power: "has an owner", risk: "low" },
  { sig: "burn(address,uint256)", power: "burn tokens from any address", risk: "high" },
  { sig: "destroyBlackFunds(address)", power: "seize blacklisted funds", risk: "high" },
  { sig: "withdraw()", power: "withdraw (dividends/funds)", risk: "low" },
];
const SEL = POWERS.map((p) => ({ ...p, sel: btSelector(p.sig).slice(2) }));
const SLOT_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const SLOT_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const SLOT_BEACON = "0xa3f0ad74e5423aebfd80d3be4bb4c0e1bd1f6a83eeca2b1a3f6e2ff6cc3a6f4a";
const slotAddr = (v: string | undefined) =>
  v && !/^0x0*$/.test(v) ? getAddress(`0x${v.slice(-40)}`) : null;
export async function contractReader(
  f: F,
  env: NodeJS.ProcessEnv,
  chainIdIn: string | number,
  address: string,
) {
  const chainId = chainOf(chainIdIn);
  return cached(`contract:${chainId}:${address}`, 300_000, async () => {
    if (chainId === SOLANA) {
      const r = await json<{
        mintAuthority?: string | null;
        freezeAuthority?: string | null;
        risks?: { name: string; level: string; description: string }[];
        score_normalised?: number;
        tokenMeta?: { symbol?: string; mutable?: boolean };
      }>(f, `https://api.rugcheck.xyz/v1/tokens/${address}/report`, undefined, 15_000);
      const powers = [
        ...(r.mintAuthority
          ? [{ power: "mint new tokens (mint authority set)", risk: "high" }]
          : []),
        ...(r.freezeAuthority
          ? [{ power: "freeze token accounts (freeze authority set)", risk: "high" }]
          : []),
        ...(r.tokenMeta?.mutable ? [{ power: "change token metadata", risk: "low" }] : []),
      ];
      const high = powers.some((p) => p.risk === "high");
      return {
        chainId,
        chain: "Solana",
        address,
        kind: "SPL mint",
        symbol: r.tokenMeta?.symbol ?? null,
        mintAuthority: r.mintAuthority ?? null,
        freezeAuthority: r.freezeAuthority ?? null,
        ownerPowers: powers,
        upgradeable: false,
        risks: (r.risks ?? []).map((x) => `${x.level}: ${x.name}`),
        riskLevel: high ? "high" : powers.length ? "medium" : "low",
        sources: ["RugCheck"],
        next: high
          ? cta("Authority still active: exit to USDC on SwapChan", toUsdc(chainId, address))
          : cta("Looks clean: buy it on SwapChan", buy(chainId, address)),
      };
    }
    if (vmOf(chainId) !== "evm")
      throw new BadRequest("contract_reader supports EVM chains and Solana");
    const c = evmClient(chainId, env);
    const a = getAddress(address);
    const [code, impl, admin, beacon] = await Promise.all([
      c.getCode({ address: a }),
      c.getStorageAt({ address: a, slot: SLOT_IMPL }),
      c.getStorageAt({ address: a, slot: SLOT_ADMIN }),
      c.getStorageAt({ address: a, slot: SLOT_BEACON }),
    ]);
    if (!code || code === "0x")
      return {
        chainId,
        chain: chainName(chainId),
        address: a,
        kind: "EOA (not a contract)",
        next: cta("Swap on SwapChan", SITE),
      };
    const implAddr = slotAddr(impl);
    const implCode = implAddr ? await c.getCode({ address: implAddr }).catch(() => "") : "";
    const hay = `${code}${implCode ?? ""}`.toLowerCase();
    const found = SEL.filter((p) => hay.includes(`63${p.sel}`));
    // verified source: Sourcify (all chains) then Routescan (eth/avax)
    let verified: { name: string | null; compiler: string | null; source: string } | null = null;
    let abiNames: string[] = [];
    for (const target of [implAddr, a].filter((x): x is `0x${string}` => !!x)) {
      try {
        const s = await json<{
          compilation?: { name?: string; compilerVersion?: string };
          abi?: { type: string; name?: string }[];
        }>(
          f,
          `https://sourcify.dev/server/v2/contract/${chainId}/${target}?fields=compilation,abi`,
        );
        if (s.compilation) {
          verified = {
            name: s.compilation.name ?? null,
            compiler: s.compilation.compilerVersion ?? null,
            source: "Sourcify",
          };
          abiNames = (s.abi ?? [])
            .filter((x) => x.type === "function" && x.name)
            .map((x) => x.name!);
          break;
        }
      } catch {}
      if ([1, 43114].includes(chainId))
        try {
          const r = await json<{
            result: { ContractName: string; CompilerVersion: string; ABI: string }[];
          }>(
            f,
            `https://api.routescan.io/v2/network/mainnet/evm/${chainId}/etherscan/api?module=contract&action=getsourcecode&address=${target}`,
          );
          const x = r.result?.[0];
          if (x?.ContractName) {
            verified = {
              name: x.ContractName,
              compiler: x.CompilerVersion,
              source: "Routescan (Etherscan-compatible)",
            };
            try {
              abiNames = (JSON.parse(x.ABI) as { type: string; name?: string }[])
                .filter((y) => y.type === "function" && y.name)
                .map((y) => y.name!);
            } catch {}
            break;
          }
        } catch {}
    }
    const nameRisk = abiNames.filter((n) =>
      /mint|pause|blacklist|blocklist|freeze|setfee|settax|setmaxtx|exclude|upgrade|seize|rescue|setrouter|settrading/i.test(
        n,
      ),
    );
    const owner = await c
      .readContract({
        address: a,
        abi: [parseAbiItem("function owner() view returns (address)")],
        functionName: "owner",
      })
      .catch(() => null);
    const renounced = owner !== null && /^0x0{40}$/i.test(owner);
    const powers = [
      ...new Map(
        found.map((p) => [p.power, { power: p.power, risk: p.risk, signature: p.sig }]),
      ).values(),
    ];
    const live = powers.filter((p) => !renounced || p.power.includes("upgrade"));
    const high = live.filter((p) => p.risk === "high").length;
    const upgradeable =
      !!implAddr || !!slotAddr(beacon) || found.some((p) => p.sig.startsWith("upgrade"));
    const level =
      renounced && !upgradeable
        ? "low"
        : high >= 2 || (upgradeable && high)
          ? "high"
          : high || upgradeable
            ? "medium"
            : "low";
    const sym = await c
      .readContract({ address: a, abi: erc20Abi, functionName: "symbol" })
      .catch(() => null);
    return {
      chainId,
      chain: chainName(chainId),
      address: a,
      symbol: sym,
      verified,
      owner,
      ownershipRenounced: renounced,
      proxy: {
        implementation: implAddr,
        admin: slotAddr(admin),
        beacon: slotAddr(beacon),
        upgradeable,
      },
      ownerPowers: live,
      abiPrivilegedFunctions: nameRisk.slice(0, 30),
      riskLevel: level,
      summary: `${verified?.name ?? "Unverified contract"}${upgradeable ? ", upgradeable proxy" : ""}${renounced ? ", ownership renounced" : owner ? `, owned by ${short(owner)}` : ""}${live.length ? `; owner can ${[...new Set(live.filter((p) => p.risk !== "low").map((p) => p.power))].join(", ") || "only do low-risk admin"}` : ""}.`,
      method:
        "Bytecode selector scan (impl + proxy) + EIP-1967 slots + owner(); verified source/ABI from Sourcify or Routescan.",
      caveat:
        "Selector scans can miss renamed functions and can't see who holds roles in AccessControl contracts; 'owner can' assumes the owner key is active.",
      sources: ["public RPC", "Sourcify", ...([1, 43114].includes(chainId) ? ["Routescan"] : [])],
      next: sym
        ? level === "high"
          ? cta(`${sym} has risky owner powers: exit to USDC on SwapChan`, toUsdc(chainId, a))
          : cta(`Buy ${sym} at the best price on SwapChan`, buy(chainId, a))
        : cta("Swap on SwapChan", SITE),
    };
  });
}

const APPROVAL_CHAINS = [1, 8453, 42161, 56, 43114, 10, 137, 59144, 534352];
// ---------- 6a. forgotten money: legacy contracts, lending, Tron, Solana rent ----------
export interface Found {
  kind: "legacy" | "lending" | "tron" | "solana-rent" | "claimable" | "balance" | "lead";
  protocol: string;
  chainId: number;
  what: string;
  valueUsd: number | null;
  /** Unsigned claim/withdraw tx, only for curated contracts with known ABIs. */
  claimTx?:
    | { chainId: number; to: string; data: string; value: string; description: string }
    | { chainId: number; tronTx: unknown; description: string }
    | { chainId: number; solanaTx: unknown; description: string };
  action: string;
  link?: string;
  risk?: string | undefined;
  /** underlying token received by the recovery step (for the swap step) */
  underlying?: string;
  evidence?: Evidence[];
  confidence?: "high" | "medium" | "low";
  /** For unknown archaeology hits: recovery-looking fns with selectors. */
  recoveryHints?: { name: string; selector: string; abi?: string }[];
  verifiedSource?: string;
  verifiedAbi?: unknown;
  sweep?: import("./recover.js").Sweep;
}
const fn = (s: string) => [parseAbiItem(`function ${s}`)] as const;
// Curated legacy Ethereum contracts (addresses verified on-chain by code presence at call time).
const P3D = "0xB3775fB83F7D12A36E0475aBdD1FCA35c091efBe";
const FOMO3D = "0xA62142888ABa8370742bE823c1782D17A0389Da1";
const ETHERDELTA = "0x8d12A197cB00D4747a1fe03395095ce2A5CC6819";
const LIQUITY_SURPLUS = "0x3D32e8b97Ed5881324241Cf03b2DA5E2EBcE5521";
const LIQUITY_BORROWER_OPS = "0x24179CD81c9e782A4096035f7eC97fB8B783e007";
const LIQUITY_TROVES = "0xA39739EF8b0231DbFA0DcdA07d7e29faAbCf4bb2";
/** IronHands "Doublr" (doublr.io): FIFO doubler queue funded by new deposits + P3D dividends. */
export const IRONHANDS = "0xE58b65d1c0C8e8b2a0e3A3AcEC633271531084ED";
/** Hand-curated (contract, selector) pairs; the registry may not touch any of these. */
export const BASE_CLAIM_ALLOWLIST: Record<string, string[]> = {
  [P3D.toLowerCase()]: [btSelector("withdraw()"), btSelector("exit()")],
  [FOMO3D.toLowerCase()]: [btSelector("withdraw()")],
  [ETHERDELTA.toLowerCase()]: [btSelector("withdraw(uint256)")],
  // payout() is permissionless, zero-value; only offered when the owner is at the head of the queue
  [IRONHANDS.toLowerCase()]: [btSelector("payout()")],
  [LIQUITY_BORROWER_OPS.toLowerCase()]: [btSelector("claimCollateral()")],
};
/** Registry addresses that collide with curated allowlist entries or dedicated scanners (must be empty). */
export function registryCollisions(
  base: Record<string, string[]> = BASE_CLAIM_ALLOWLIST,
  reg: Record<string, string[]> = {
    ...REGISTRY_ALLOWLIST,
    ...Object.fromEntries(Object.keys(REGISTRY_APPROVALS).map((t) => [t, ["approve"]])),
  },
): string[] {
  const dedicated = new Set([
    ...Object.keys(base),
    ...REGISTRY.filter((e) => e.status === "covered-elsewhere").map((e) => e.address.toLowerCase()),
  ]);
  return Object.keys(reg).filter((a) => dedicated.has(a.toLowerCase()));
}
{
  const hit = registryCollisions();
  // fail at module load (and so in every test/build smoke) rather than silently overwrite a curated entry
  if (hit.length)
    throw new Error(`LegacyETH registry collides with curated claim allowlist: ${hit.join(", ")}`);
}
/** Exact (contract, selector) pairs SwapChan will ever build claim txs for. */
export const CLAIM_ALLOWLIST: Record<string, string[]> = {
  ...BASE_CLAIM_ALLOWLIST,
  // LegacyETH registry: confirmed contracts only, generated from apps/api/src/legacy/registry.json
  ...REGISTRY_ALLOWLIST,
};
export function verifyClaimTx(
  tx: { to: string; data: string; value: string },
  /** LegacyETH approvals: the owner's token balanceOf at the pinned block (the approval may not exceed it) */
  approveMax?: bigint,
  /** the sender; required for caller-argument claims (their calldata must be exactly selector + this address) */
  owner?: string,
) {
  const sel = tx.data.slice(0, 10).toLowerCase();
  const caller = CALLER_ARG_SPECS[tx.to.toLowerCase()];
  const exact = (): boolean => {
    if (!caller) return true;
    if (!owner) return false;
    try {
      return tx.data.toLowerCase() === simClaimData(caller, owner);
    } catch {
      return false;
    }
  };
  const ok =
    ((CLAIM_ALLOWLIST[tx.to.toLowerCase()] ?? []).includes(sel) &&
      BigInt(tx.value) === 0n &&
      exact()) ||
    // LegacyETH two-step redemptions: approve only the pinned redemption contract, exact finite amount
    verifyApproval(REGISTRY_APPROVALS, tx, approveMax);
  return {
    verified: ok,
    check:
      "claim-call allowlist (contract + exact selector, zero value; caller-argument claims: exact calldata with your own address; approvals only to the pinned redemption contract, never more than the token balance you hold)",
  };
}
const claim = (
  chainId: number,
  to: string,
  data: `0x${string}`,
  description: string,
  approveMax?: bigint,
) => {
  const tx = { chainId, to, data, value: "0", description };
  if (!verifyClaimTx(tx, approveMax).verified) throw new Error("claim tx failed allowlist");
  return tx;
};

/** Lowercased addresses of every scanned LegacyETH registry contract (Ethereum mainnet). */
setClaimCheck((tx, owner) => {
  try {
    return verifyClaimTx(tx, undefined, owner).verified;
  } catch {
    return false;
  }
});

export const registryAddressSet = () =>
  new Set(registryScanned().map((e) => e.address.toLowerCase()));
/** Drop chain-1 items whose claim tx targets a scanned registry contract: the registry scan already reports it,
 *  so one contract (e.g. an Hourglass clone) can never appear twice or be counted twice. */
export function dropRegistryDupes<T extends { chainId?: number; claimTx?: unknown }>(
  items: T[],
  regAddrs: Set<string>,
): T[] {
  return items.filter(
    (x) =>
      !(
        x.chainId === 1 &&
        regAddrs.has(String((x.claimTx as { to?: string } | undefined)?.to ?? "").toLowerCase())
      ),
  );
}
/** Fomo3D withdraw() pays only if the contract holds the ETH and the call succeeds. */
export function fomoClaimable(tot: bigint, held: bigint | null, simOk: boolean) {
  // fail closed: a failed balance read is not proof the contract can pay
  return tot > 0n && simOk && held !== null && held >= tot;
}
/** IronHands payout(): half the balance goes to the queue head, capped at what the head is owed. */
export function ironHandsPayNow(
  owner: string,
  head: readonly [string, bigint] | null,
  held: bigint,
) {
  if (!head || head[0].toLowerCase() !== owner.toLowerCase() || held <= 1n) return 0n;
  const half = held - held / 2n;
  return half < head[1] ? half : head[1];
}
/**
 * LegacyETH registry scan (legacy/registry.ts): every confirmed contract (DEXes, Fomo3D forks, Hourglass clones,
 * ETH wrappers, refunds, redemptions) from
 * legacyeth.com/contracts, Multicall3-batched and pinned to one block. Unconfirmed entries come back in
 * notChecked, never as a zero.
 */
export async function legacyRegistry(
  env: NodeJS.ProcessEnv,
  owner: `0x${string}`,
  ethPx: number | null,
  blockNumber?: bigint,
): Promise<{ items: Found[]; notChecked: string[] }> {
  const c0 = evmClient(1, env);
  const block = blockNumber ?? (await c0.getBlockNumber().catch(() => undefined));
  const { hits, notChecked } = await scanRegistry(c0, owner, block);
  const items: Found[] = hits.map((h) => {
    const eth = Number(formatUnits(h.owedWei, 18));
    const step1 = h.step === 1;
    const why = !h.simOk
      ? `${step1 ? `approve + ${h.entry.claim}` : h.entry.claim} reverts for you`
      : h.heldWei === null
        ? "the contract balance read failed, so payment could not be confirmed"
        : "the contract holds less ETH than it owes";
    return {
      kind: "legacy",
      protocol: h.entry.name,
      chainId: 1,
      what: h.claimable
        ? step1
          ? `${eth} ETH redeemable in two steps (approve, then ${h.entry.claim})`
          : `${eth} ETH withdrawable`
        : `Shown but not claimable now: the contract shows ${eth} ETH for you but ${h.entry.claim} would pay nothing (${why})`,
      valueUsd: h.claimable && ethPx ? r2(eth * ethPx) : null,
      ...(h.tx ? { claimTx: claim(1, h.tx.to, h.tx.data, h.tx.description, h.tx.approveMax) } : {}),
      action: h.claimable
        ? step1
          ? `Sign the approval; find_money then builds ${h.entry.claim}`
          : `Withdraw your ETH from ${h.entry.name}, then swap on SwapChan`
        : "Nothing to sign: the balance view counts ETH the contract cannot pay out",
      link: h.claimable
        ? swapUrl(1, NATIVE_TOKEN, 1, usdcOf(1)!, String(eth))
        : `https://etherscan.io/address/${h.entry.address}`,
      risk: ["Legacy unaudited contract.", ...h.labels].join(" "),
      evidence: h.evidence,
      confidence: h.claimable ? "high" : "low",
    };
  });
  return { items, notChecked };
}
export const LEGACY_REGISTRY_SIZE = REGISTRY.length;
export async function legacyEth(
  env: NodeJS.ProcessEnv,
  owner: `0x${string}`,
  ethPx: number | null,
  blockNumber?: bigint,
): Promise<Found[]> {
  const c0 = evmClient(1, env);
  // blockNumber pins every probe to historical state (regression fixtures use the block before a real recovery)
  const block = blockNumber ?? (await c0.getBlockNumber().catch(() => undefined));
  // every read is recorded as machine-readable evidence (call, args, raw return, block) so agents can re-verify
  const reads: Evidence[] = [];
  const c = {
    readContract: async (a: Parameters<typeof c0.readContract>[0]) => {
      const raw = await c0.readContract({
        ...a,
        ...(block ? { blockNumber: block } : {}),
      } as never);
      const f = (
        a.abi as readonly {
          name?: string;
          inputs?: { type: string }[];
          outputs?: { type: string }[];
        }[]
      ).find((x) => x.name === a.functionName);
      reads.push({
        chainId: 1,
        address: a.address ?? "",
        call: `${a.functionName}(${(f?.inputs ?? []).map((i) => i.type).join(",")})`,
        abi: f
          ? `function ${a.functionName}(${(f.inputs ?? []).map((i) => i.type).join(",")}) view returns (${(f.outputs ?? []).map((o) => o.type).join(",")})`
          : undefined,
        args: (a.args ?? []).map(String),
        raw: Array.isArray(raw) ? raw.map(String) : String(raw),
        block: block?.toString(),
      });
      return raw;
    },
  } as unknown as typeof c0;
  const out: Found[] = [];
  const usd = (eth: number) => (ethPx ? r2(eth * ethPx) : null);
  const [p3dDiv, p3dBal, pid, edEth, ihOwed] = await Promise.all([
    c
      .readContract({
        address: P3D,
        abi: fn("dividendsOf(address) view returns (uint256)"),
        functionName: "dividendsOf",
        args: [owner],
      })
      .catch(() => 0n),
    c
      .readContract({
        address: P3D,
        abi: fn("balanceOf(address) view returns (uint256)"),
        functionName: "balanceOf",
        args: [owner],
      })
      .catch(() => 0n),
    c
      .readContract({
        address: FOMO3D,
        abi: fn("pIDxAddr_(address) view returns (uint256)"),
        functionName: "pIDxAddr_",
        args: [owner],
      })
      .catch(() => 0n),
    c
      .readContract({
        address: ETHERDELTA,
        abi: fn("balanceOf(address,address) view returns (uint256)"),
        functionName: "balanceOf",
        args: ["0x0000000000000000000000000000000000000000", owner],
      })
      .catch(() => 0n),
    c
      .readContract({
        address: IRONHANDS,
        abi: fn("creditRemaining(address) view returns (uint256)"),
        functionName: "creditRemaining",
        args: [owner],
      })
      .catch(() => 0n),
  ]);
  if (p3dDiv > 0n || p3dBal > 0n) {
    const sellValue0 =
      p3dBal > 0n
        ? await c
            .readContract({
              address: P3D,
              abi: fn("calculateEthereumReceived(uint256) view returns (uint256)"),
              functionName: "calculateEthereumReceived",
              args: [p3dBal],
            })
            .catch(() => 0n)
        : 0n;
    const sellValue = sellValue0 as bigint;
    // dust P3D with no dividends (worth < 0.0001 ETH) is not money: skip it
    const eth = Number(formatUnits(p3dDiv + sellValue, 18));
    if (p3dDiv > 0n || sellValue > 10n ** 14n)
      out.push({
        kind: "legacy",
        protocol: "PoWH3D (P3D)",
        chainId: 1,
        what: `${formatUnits(p3dBal, 18)} P3D (≈${formatUnits(sellValue, 18)} ETH if sold) + ${formatUnits(p3dDiv, 18)} ETH dividends`,
        valueUsd: usd(eth),
        // exit() only when the tokens are worth selling; dust balances (e.g. 1e-14 P3D) just withdraw dividends
        claimTx:
          sellValue > 10n ** 14n
            ? claim(
                1,
                P3D,
                encodeFunctionData({ abi: fn("exit()"), functionName: "exit" }),
                "exit(): sell all P3D and withdraw dividends",
              )
            : claim(
                1,
                P3D,
                encodeFunctionData({ abi: fn("withdraw()"), functionName: "withdraw" }),
                "withdraw(): claim P3D dividends",
              ),
        action: "Withdraw from PoWH3D, then swap the ETH on SwapChan",
        link: swapUrl(1, NATIVE_TOKEN, 1, usdcOf(1)!, String(eth)),
        risk: "Legacy unaudited contract. P3D exit pays a 10% exit fee to other holders.",
      });
  }
  if (pid > 0n) {
    const v = await c
      .readContract({
        address: FOMO3D,
        abi: fn("getPlayerVaults(uint256) view returns (uint256,uint256,uint256)"),
        functionName: "getPlayerVaults",
        args: [pid],
      })
      .catch(() => null);
    const tot: bigint = v ? (v as readonly bigint[]).reduce((a, b) => a + b, 0n) : 0n;
    if (tot > 0n) {
      const eth = Number(formatUnits(tot, 18));
      // withdraw() pays from the contract's own ETH: if the contract can't cover the vaults, or an
      // eth_call of withdraw() from the owner reverts, signing would pay nothing.
      const [held, sim] = await Promise.all([
        c0
          .getBalance({ address: FOMO3D, ...(block ? { blockNumber: block } : {}) })
          .catch(() => null),
        c0
          .call({
            account: owner,
            to: FOMO3D,
            data: encodeFunctionData({ abi: fn("withdraw()"), functionName: "withdraw" }),
            ...(block ? { blockNumber: block } : {}),
          })
          .then(() => true)
          .catch(() => false),
      ]);
      const payable = fomoClaimable(tot, held, sim);
      out.push({
        kind: "legacy",
        protocol: "Fomo3D Long",
        chainId: 1,
        what: payable
          ? `${eth} ETH in win/gen/aff vaults`
          : `Shown but not claimable now: vaults show ${eth} ETH but withdraw() would pay nothing (${!sim ? "withdraw() reverts for you" : held === null ? "contract balance read failed, so payment could not be confirmed" : "contract holds less ETH than the vaults"})`,
        valueUsd: payable ? usd(eth) : null,
        ...(payable
          ? {
              claimTx: claim(
                1,
                FOMO3D,
                encodeFunctionData({ abi: fn("withdraw()"), functionName: "withdraw" }),
                "withdraw(): claim Fomo3D vaults",
              ),
            }
          : {}),
        action: payable
          ? "Withdraw your Fomo3D vaults, then swap on SwapChan"
          : "Nothing to sign: the vault view counts ETH the contract cannot pay out",
        link: payable
          ? swapUrl(1, NATIVE_TOKEN, 1, usdcOf(1)!, String(eth))
          : `https://etherscan.io/address/${FOMO3D}`,
        risk: "Legacy unaudited contract.",
      });
    }
  }
  if (ihOwed > 0n) {
    const [head, held] = await Promise.all([
      c
        .readContract({
          address: IRONHANDS,
          abi: fn("payoutOrder() view returns (uint256)"),
          functionName: "payoutOrder",
        })
        .then((i) =>
          c.readContract({
            address: IRONHANDS,
            abi: fn("participants(uint256) view returns (address,uint256)"),
            functionName: "participants",
            args: [i as bigint],
          }),
        )
        .catch(() => null),
      c0
        .getBalance({ address: IRONHANDS, ...(block ? { blockNumber: block } : {}) })
        .catch(() => 0n),
    ]);
    const h = head as readonly [string, bigint] | null;
    const now = ironHandsPayNow(owner, h, held);
    const owed = Number(formatUnits(ihOwed, 18));
    const nowEth = Number(formatUnits(now, 18));
    out.push({
      kind: "legacy",
      protocol: "IronHands (Doublr)",
      chainId: 1,
      what:
        now > 0n
          ? `${owed} ETH owed in the IronHands queue; you are first in line and payout() sends you ${nowEth} ETH now`
          : `Not claimable now: ${owed} ETH owed in the IronHands queue, paid only in queue order as new deposits/dividends arrive`,
      valueUsd: now > 0n ? usd(nowEth) : null,
      ...(now > 0n
        ? {
            claimTx: claim(
              1,
              IRONHANDS,
              encodeFunctionData({ abi: fn("payout()"), functionName: "payout" }),
              "payout(): pay the queue head (you)",
            ),
          }
        : {}),
      action:
        now > 0n
          ? "Call payout() (pays the head of the queue, which is you), then swap on SwapChan"
          : "Nothing to sign: you are not at the head of the queue",
      link: `https://etherscan.io/address/${IRONHANDS}`,
      risk: "Legacy doubler queue; half of each payout() is reinvested in P3D.",
    });
  }
  if (edEth > 0n) {
    const eth = Number(formatUnits(edEth, 18));
    out.push({
      kind: "legacy",
      protocol: "EtherDelta",
      chainId: 1,
      what: `${eth} ETH deposited in EtherDelta`,
      valueUsd: usd(eth),
      claimTx: claim(
        1,
        ETHERDELTA,
        encodeFunctionData({
          abi: fn("withdraw(uint256)"),
          functionName: "withdraw",
          args: [edEth],
        }),
        "withdraw(amount): pull ETH from EtherDelta",
      ),
      action: "Withdraw ETH from EtherDelta, then swap on SwapChan",
      link: swapUrl(1, NATIVE_TOKEN, 1, usdcOf(1)!, String(eth)),
      risk: "Legacy exchange contract (ETH balance only checked; ERC-20 balances in EtherDelta not scanned).",
    });
  }
  // Liquity v1: collateral surplus after liquidation/redemption + open trove
  const [surplus, trove] = await Promise.all([
    c
      .readContract({
        address: LIQUITY_SURPLUS,
        abi: fn("getCollateral(address) view returns (uint256)"),
        functionName: "getCollateral",
        args: [owner],
      })
      .catch(() => 0n),
    c
      .readContract({
        address: LIQUITY_TROVES,
        abi: fn("getEntireDebtAndColl(address) view returns (uint256,uint256,uint256,uint256)"),
        functionName: "getEntireDebtAndColl",
        args: [owner],
      })
      .catch(() => null),
  ]);
  if (surplus > 0n) {
    const eth = Number(formatUnits(surplus, 18));
    out.push({
      kind: "lending",
      protocol: "Liquity v1 surplus",
      chainId: 1,
      what: `${eth} ETH collateral surplus left after your trove was closed`,
      valueUsd: usd(eth),
      claimTx: claim(
        1,
        LIQUITY_BORROWER_OPS,
        encodeFunctionData({ abi: fn("claimCollateral()"), functionName: "claimCollateral" }),
        "claimCollateral(): Liquity surplus",
      ),
      action: "Claim your Liquity surplus ETH, then swap on SwapChan",
      link: swapUrl(1, NATIVE_TOKEN, 1, usdcOf(1)!, String(eth)),
    });
  }
  if (trove && trove[1] > 0n) {
    const debt = Number(formatUnits(trove[0], 18));
    const coll = Number(formatUnits(trove[1], 18));
    const cr = ethPx && debt ? (coll * ethPx) / debt : null;
    out.push({
      kind: "lending",
      protocol: "Liquity v1 trove",
      chainId: 1,
      what: `Open trove: ${coll.toFixed(4)} ETH collateral, ${debt.toFixed(2)} LUSD debt${cr ? `, CR ${(cr * 100).toFixed(0)}%` : ""}`,
      valueUsd: usd(coll) !== null ? r2(usd(coll)! - debt) : null,
      action:
        cr && cr < 1.5
          ? "At risk: add collateral or repay (liquidation below 110%)"
          : "Excess collateral may be withdrawable on liquity.org",
      link: swapUrl(1, NATIVE_TOKEN, 1, "0x5f98805A4E8be255a32880FDeC7F6728C6568bA0"),
      risk: cr && cr < 1.5 ? "low collateral ratio" : undefined,
    });
  }
  for (const o of out) {
    const to = (o.claimTx as { to?: string } | undefined)?.to?.toLowerCase();
    o.evidence = reads.filter((r) => r.address.toLowerCase() === to);
  }
  return out;
}

const AAVE_V3: Record<number, `0x${string}`> = {
  1: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  8453: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  42161: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  10: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  137: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  43114: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  56: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB",
  534352: "0x11fCfe756c05AD438e312a7fd934381537D3cFfa",
  59144: "0xc47b8C00b0f69a36fa203Ffeac0334874574a8Ac",
};
const AAVE_V2_ETH = "0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9";
const COMPTROLLERS: {
  chainId: number;
  name: string;
  addr: `0x${string}`;
  accrued: string;
  rewardSym: string;
  rewardToken: string;
}[] = [
  {
    chainId: 1,
    name: "Compound v2",
    addr: "0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B",
    accrued: "compAccrued",
    rewardSym: "COMP",
    rewardToken: "0xc00e94Cb662C3520282E6f5717214004A7f26888",
  },
  {
    chainId: 56,
    name: "Venus",
    addr: "0xfD36E2c2a6789Db23113685031d7F16329158384",
    accrued: "venusAccrued",
    rewardSym: "XVS",
    rewardToken: "0xcF6BB5389c92Bdda8a3747Ddb454cB7a64626C63",
  },
];
const COMETS: { chainId: number; addr: `0x${string}`; base: string }[] = [
  { chainId: 1, addr: "0xc3d688B66703497DAA19211EEdff47f25384cdc3", base: "USDC" },
  { chainId: 1, addr: "0xA17581A9E3356d9A858b789D68B4d866e593aE94", base: "WETH" },
  { chainId: 8453, addr: "0xb125E6687d4313864e53df431d5425969c15Eb2F", base: "USDC" },
  { chainId: 42161, addr: "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf", base: "USDC" },
];
async function lending(
  f: F,
  env: NodeJS.ProcessEnv,
  owner: `0x${string}`,
  ethPx: number | null,
): Promise<Found[]> {
  const out: Found[] = [];
  const aave = async (chainId: number, pool: `0x${string}`, ver: string) => {
    const r = await evmClient(chainId, env).readContract({
      address: pool,
      abi: fn(
        "getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
      ),
      functionName: "getUserAccountData",
      args: [owner],
    });
    // v3 reports USD with 8 decimals; v2 reports ETH with 18
    const k = ver === "v2" ? (ethPx ?? 0) / 1e18 : 1 / 1e8;
    const coll = Number(r[0]) * k;
    const debt = Number(r[1]) * k;
    const avail = Number(r[2]) * k;
    const hf = Number(r[5]) / 1e18;
    if (coll < 1 && debt < 1) return;
    const idle = debt === 0;
    out.push({
      kind: "lending",
      protocol: `Aave ${ver}`,
      chainId,
      what: `${chainName(chainId)}: $${r2(coll)} supplied, $${r2(debt)} borrowed${debt ? `, health factor ${hf.toFixed(2)}` : ""}`,
      valueUsd: r2(coll - debt),
      action:
        hf < 1.2 && debt
          ? "At risk of liquidation: repay or add collateral now"
          : idle
            ? "Collateral earning supply APY only; compare yields or swap out"
            : `Up to $${r2(avail)} more borrowable; check refinancing rates`,
      link: `https://app.aave.com/`,
      risk: hf < 1.2 && debt ? `health factor ${hf.toFixed(2)}` : undefined,
    });
  };
  const tasks: Promise<unknown>[] = Object.entries(AAVE_V3).map(([id, p]) =>
    aave(Number(id), p, "v3").catch(() => {}),
  );
  tasks.push(aave(1, AAVE_V2_ETH, "v2").catch(() => {}));
  for (const cm of COMETS)
    tasks.push(
      (async () => {
        const c = evmClient(cm.chainId, env);
        const [sup, bor, dec] = await Promise.all([
          c.readContract({
            address: cm.addr,
            abi: fn("balanceOf(address) view returns (uint256)"),
            functionName: "balanceOf",
            args: [owner],
          }),
          c.readContract({
            address: cm.addr,
            abi: fn("borrowBalanceOf(address) view returns (uint256)"),
            functionName: "borrowBalanceOf",
            args: [owner],
          }),
          c.readContract({
            address: cm.addr,
            abi: fn("decimals() view returns (uint8)"),
            functionName: "decimals",
          }),
        ]);
        const s = Number(formatUnits(sup, dec));
        const b = Number(formatUnits(bor, dec));
        if (!s && !b) return;
        const px = cm.base === "USDC" ? 1 : (ethPx ?? 0);
        out.push({
          kind: "lending",
          protocol: `Compound v3 (${cm.base})`,
          chainId: cm.chainId,
          what: `${s} ${cm.base} supplied, ${b} ${cm.base} borrowed`,
          valueUsd: r2((s - b) * px),
          action: "Review on app.compound.finance",
          link: "https://app.compound.finance/",
        });
      })().catch(() => {}),
    );
  for (const ct of COMPTROLLERS)
    tasks.push(
      (async () => {
        const c = evmClient(ct.chainId, env);
        const markets = (await c.readContract({
          address: ct.addr,
          abi: fn("getAllMarkets() view returns (address[])"),
          functionName: "getAllMarkets",
        })) as `0x${string}`[];
        const snaps = await Promise.all(
          markets.slice(0, 60).map(async (m) => {
            const s = await c
              .readContract({
                address: m,
                abi: fn(
                  "getAccountSnapshot(address) view returns (uint256,uint256,uint256,uint256)",
                ),
                functionName: "getAccountSnapshot",
                args: [owner],
              })
              .catch(() => null);
            if (!s || (s[1] === 0n && s[2] === 0n)) return null;
            const sym = await c
              .readContract({ address: m, abi: erc20Abi, functionName: "symbol" })
              .catch(() => "?");
            const und = await c
              .readContract({
                address: m,
                abi: fn("underlying() view returns (address)"),
                functionName: "underlying",
              })
              .catch(() => NATIVE_TOKEN);
            const ud =
              und === NATIVE_TOKEN
                ? 18
                : Number(
                    await c
                      .readContract({
                        address: und as `0x${string}`,
                        abi: erc20Abi,
                        functionName: "decimals",
                      })
                      .catch(() => 18),
                  );
            return {
              sym: String(sym),
              und,
              supplied: (Number(s[1]) * Number(s[3])) / 1e18 / 10 ** ud,
              borrowed: Number(s[2]) / 10 ** ud,
            };
          }),
        );
        const pos = snaps.filter((x): x is NonNullable<typeof x> => !!x);
        const accrued = (await c
          .readContract({
            address: ct.addr,
            abi: fn(`${ct.accrued}(address) view returns (uint256)`),
            functionName: ct.accrued as never,
            args: [owner] as never,
          })
          .catch(() => 0n)) as bigint;
        if (!pos.length && accrued === 0n) return;
        const px = await prices(f, [
          ...pos.map((p) => ({ chainId: ct.chainId, address: p.und as string })),
          { chainId: ct.chainId, address: ct.rewardToken },
        ]);
        let net = 0;
        for (const p of pos)
          net += (p.supplied - p.borrowed) * (pxOf(px, ct.chainId, p.und as string)?.price ?? 0);
        if (pos.length)
          out.push({
            kind: "lending",
            protocol: ct.name,
            chainId: ct.chainId,
            what: pos
              .map(
                (p) =>
                  `${p.sym}: ${p.supplied.toPrecision(4)} supplied${p.borrowed ? `, ${p.borrowed.toPrecision(4)} borrowed` : ""}`,
              )
              .join("; "),
            valueUsd: r2(net),
            action: `Old ${ct.name} position: withdraw idle supply or repay`,
            link: ct.chainId === 1 ? "https://app.compound.finance/" : "https://app.venus.io/",
          });
        if (accrued > 0n) {
          const amt = Number(formatUnits(accrued, 18));
          out.push({
            kind: "claimable",
            protocol: `${ct.name} ${ct.rewardSym} rewards`,
            chainId: ct.chainId,
            what: `${amt.toPrecision(4)} ${ct.rewardSym} accrued (unclaimed)`,
            valueUsd: r2(amt * (pxOf(px, ct.chainId, ct.rewardToken)?.price ?? 0)),
            action: `Claim ${ct.rewardSym} (step 1), then swap it on SwapChan`,
            claimTx: {
              chainId: ct.chainId,
              to: ct.addr,
              data: encodeFunctionData({
                abi: fn(`${ct.accrued === "compAccrued" ? "claimComp" : "claimVenus"}(address)`),
                functionName: ct.accrued === "compAccrued" ? "claimComp" : "claimVenus",
                args: [owner],
              }),
              value: "0",
              description: `${ct.accrued === "compAccrued" ? "claimComp" : "claimVenus"}(you): claim ${ct.rewardSym}`,
            },
            link: toUsdc(ct.chainId, ct.rewardToken),
          });
        }
      })().catch(() => {}),
    );
  await Promise.all(tasks);
  return out;
}

const TG = "https://api.trongrid.io";
type TronAcct = {
  unfrozenV2?: { unfreeze_amount: number; unfreeze_expire_time: number }[];
  frozen?: { frozen_balance: number; expire_time: number }[];
};
export async function tronMoney(
  f: F,
  owner: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Found[]> {
  const out: Found[] = [];
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.TRONGRID_API_KEY) headers["TRON-PRO-API-KEY"] = env.TRONGRID_API_KEY;
  const post = async <T>(path: string, b: unknown, attempt = 0): Promise<T> => {
    try {
      return await json<T>(f, `${TG}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(b),
      });
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((ok) => setTimeout(ok, 800 * (attempt + 1) * (attempt + 1)));
      return post(path, b, attempt + 1);
    }
  };
  const px = await prices(f, [{ chainId: TRON, address: nativeOf(TRON) }]);
  const trxPx = pxOf(px, TRON, nativeOf(TRON))?.price ?? null;
  type Acct = TronAcct & {
    balance?: number;
    votes?: { vote_address: string; vote_count: number }[];
    frozenV2?: { type?: string; amount?: number }[];
    delegated_frozenV2_balance_for_bandwidth?: number;
    delegated_frozenV2_balance_for_energy?: number;
    account_resource?: {
      delegated_frozenV2_balance_for_bandwidth?: number;
      delegated_frozenV2_balance_for_energy?: number;
    };
    assetV2?: { key: string; value: number }[];
    trc20?: Record<string, string>[];
  };
  const [rew, acct] = await Promise.all([
    post<{ reward?: number }>("/wallet/getReward", { address: owner, visible: true }).catch(() => ({
      reward: 0,
    })),
    post<Acct>("/wallet/getaccount", { address: owner, visible: true }).catch((): Acct => ({})),
  ]);
  const reward = (rew.reward ?? 0) / 1e6;
  if (reward > 0) {
    const tx = await post<unknown>("/wallet/withdrawbalance", {
      owner_address: owner,
      visible: true,
    }).catch(() => null);
    out.push({
      kind: "tron",
      protocol: "Tron voting rewards",
      chainId: TRON,
      what: `${reward} TRX unclaimed voting/SR rewards`,
      valueUsd: trxPx ? r2(reward * trxPx) : null,
      confidence: "high",
      ...(tx && !(tx as { Error?: string }).Error
        ? {
            claimTx: {
              chainId: TRON,
              tronTx: tx,
              description: "WithdrawBalance (unsigned TronGrid tx)",
            },
          }
        : {}),
      action: "Claim TRX voting rewards, then swap on SwapChan",
      link: toUsdc(TRON, nativeOf(TRON), String(reward)),
      evidence: [
        {
          chainId: TRON,
          address: owner,
          call: "getReward",
          args: [owner],
          raw: String(rew.reward ?? 0),
        },
      ],
    });
  }
  const now = Date.now();
  const ready =
    (acct.unfrozenV2 ?? [])
      .filter((u) => u.unfreeze_expire_time <= now)
      .reduce((s, u) => s + u.unfreeze_amount, 0) / 1e6;
  if (ready > 0) {
    const tx = await post<unknown>("/wallet/withdrawexpireunfreeze", {
      owner_address: owner,
      visible: true,
    }).catch(() => null);
    out.push({
      kind: "tron",
      protocol: "Tron Stake 2.0 unfreeze",
      chainId: TRON,
      what: `${ready} TRX unstaked and ready to withdraw (withdrawExpireUnfreeze)`,
      valueUsd: trxPx ? r2(ready * trxPx) : null,
      confidence: "high",
      ...(tx && !(tx as { Error?: string }).Error
        ? {
            claimTx: {
              chainId: TRON,
              tronTx: tx,
              description: "WithdrawExpireUnfreeze (unsigned TronGrid tx)",
            },
          }
        : {}),
      action: "Withdraw your expired unfreeze",
      link: toUsdc(TRON, nativeOf(TRON), String(ready)),
      evidence: [
        {
          chainId: TRON,
          address: owner,
          call: "getaccount.unfrozenV2",
          args: [],
          raw: JSON.stringify(acct.unfrozenV2 ?? []),
        },
      ],
    });
  }
  out.push(
    ...((await tronExtras(f, env, owner, acct as never, trxPx, async (a) =>
      pxOf(await prices(f, [{ chainId: TRON, address: a }]), TRON, a),
    ).catch((e) => {
      if (process.env.DEBUG_TRON) console.error("tronExtras", e);
      return [];
    })) as Found[]),
  );
  const v1Locked =
    (acct.frozen ?? [])
      .filter((x) => x.expire_time > now)
      .reduce((s, x) => s + x.frozen_balance, 0) / 1e6;
  if (v1Locked > 0)
    out.push({
      kind: "tron",
      protocol: "Tron Stake 1.0 (still locked)",
      chainId: TRON,
      what: `${v1Locked} TRX still in Stake 1.0 freeze (not yet expired)`,
      valueUsd: trxPx ? r2(v1Locked * trxPx) : null,
      confidence: "high",
      action: "Wait for expire_time, then UnfreezeBalance",
      link: toUsdc(TRON, nativeOf(TRON)),
    });
  // Known Tron tokens: WTRX, JST, USDJ, sTRX, stUSDT, SUN
  const KNOWN: {
    addr: string;
    name: string;
    dec: number;
    kind: "unwrap" | "stable" | "stake" | "farm" | "token" | "legacy";
  }[] = [
    { addr: "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR", name: "WTRX", dec: 6, kind: "unwrap" },
    { addr: "TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9", name: "JST", dec: 18, kind: "farm" },
    { addr: "TMwFHYXLJaRUPeW6421aqXL4ZEzPRFGkGT", name: "USDJ", dec: 18, kind: "stable" },
    { addr: "TThzxDN6Yy1RoeQkTdBBqNqDcMfKzS6x6s", name: "stUSDT", dec: 18, kind: "stake" },
    { addr: "TSSMHYeV2uE9qYH95DqyoKmUkGSsCGWHz2", name: "SUN", dec: 18, kind: "farm" },
    { addr: "TKkeiboTkxXKJpbmVFbv4a8ov5rAfRDMf9", name: "SUNOLD", dec: 18, kind: "legacy" },
    { addr: "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7", name: "WIN", dec: 6, kind: "token" },
    { addr: "TAFjULxiVgT4qWk6UZwjqwZXTSaGaqnVp4", name: "BTT", dec: 18, kind: "token" },
  ];
  const knownPx = await prices(
    f,
    KNOWN.filter((k) => k.kind === "token" || k.kind === "farm").map((k) => ({
      chainId: TRON,
      address: k.addr,
    })),
  ).catch(() => new Map());
  const hex = (await import("./onchain.js")).b58decode(owner);
  const me = Buffer.from(hex.slice(1, 21)).toString("hex").padStart(64, "0");
  const v1 = await tronV1Account(
    f,
    owner,
    env.TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": env.TRONGRID_API_KEY } : {},
  );
  const tb = new Map<string, bigint>();
  for (const o of v1.data?.[0]?.trc20 ?? [])
    for (const [a, v] of Object.entries(o)) tb.set(a, BigInt(v));
  void me;
  for (const k of KNOWN) {
    try {
      const bal = tb.get(k.addr) ?? 0n;
      if (bal <= 0n) continue;
      const amt = Number(bal) / 10 ** k.dec;
      if (amt < 0.01) continue;
      out.push({
        kind: "tron",
        protocol: k.name,
        chainId: TRON,
        what: `${amt.toPrecision(5)} ${k.name} ${
          k.kind === "unwrap"
            ? "(unwrap to TRX)"
            : k.kind === "stake"
              ? "(check unstake queue on JustLend/SUN)"
              : k.kind === "stable"
                ? "(JustStables / USDJ)"
                : k.kind === "token"
                  ? "(sellable TRC-20)"
                  : k.kind === "legacy"
                    ? "(pre-2021 SUN; SUN.io converts old SUN to new SUN)"
                    : "(SUN.io / farm — check claim)"
        }`,
        valueUsd:
          k.name === "WTRX" && trxPx
            ? r2(amt * trxPx)
            : (() => {
                const p = pxOf(knownPx, TRON, k.addr)?.price;
                return p ? r2(amt * p) : null;
              })(),
        confidence: "high",
        action:
          k.kind === "unwrap"
            ? "Call WTRX.withdraw(amount), then swap TRX on SwapChan"
            : k.kind === "token"
              ? `Swap ${k.name} on SwapChan`
              : k.kind === "legacy"
                ? "Old SUN must be converted on SUN.io first; SwapChan cannot build that conversion"
                : `Open the ${k.name} dApp to unstake/claim, then swap on SwapChan`,
        link: toUsdc(TRON, k.addr, String(amt)),
        evidence: [
          {
            chainId: TRON,
            address: k.addr,
            call: "balanceOf(address)",
            abi: "balanceOf(address) view returns (uint256)",
            args: [owner],
            raw: `0x${bal.toString(16)}`,
          },
        ],
        ...(await (async () => {
          if (k.kind !== "unwrap") return {};
          const tronTx = await post("/wallet/triggersmartcontract", {
            owner_address: owner,
            contract_address: k.addr,
            function_selector: "withdraw(uint256)",
            parameter: bal.toString(16).padStart(64, "0"),
            fee_limit: 100_000_000,
            call_value: 0,
            visible: true,
          }).catch(() => null);
          if (!tronTx || (tronTx as { Error?: string }).Error) return {};
          return {
            claimTx: {
              chainId: TRON,
              tronTx,
              description: `WTRX.withdraw(${amt})`,
            },
          };
        })()),
      });
    } catch {}
  }

  // TRC-10 leftovers
  for (const a of acct.assetV2 ?? []) {
    if (!a.value || a.value <= 0) continue;
    out.push({
      kind: "tron",
      protocol: `TRC-10 ${a.key}`,
      chainId: TRON,
      what: `${a.value} units of TRC-10 asset ${a.key}`,
      valueUsd: null,
      confidence: "low",
      action: "Check Tronscan for the asset; swap or transfer if still listed",
      link: `https://tronscan.org/#/token/${a.key}`,
      evidence: [
        { chainId: TRON, address: owner, call: "assetV2", args: [a.key], raw: String(a.value) },
      ],
    });
  }

  // Archaeology: history contracts + recovery selectors + promote
  try {
    const tx = await json<{
      data: {
        raw_data: {
          contract: { type: string; parameter: { value: { contract_address?: string } } }[];
        };
      }[];
    }>(f, `${TG}/v1/accounts/${owner}/transactions?only_from=true&limit=200`, {
      headers: env.TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": env.TRONGRID_API_KEY } : {},
    });
    const contracts = [
      ...new Set(
        tx.data
          .flatMap((t) =>
            t.raw_data.contract
              .filter((c) => c.type === "TriggerSmartContract")
              .map((c) => c.parameter.value.contract_address!),
          )
          .filter(Boolean),
      ),
    ].slice(0, 30);
    const VIEWS = [
      "dividendsOf(address)",
      "myDividends(bool)",
      "earned(address)",
      "pendingReward(address)",
      "claimable(address)",
      "withdrawable(address)",
      "getReward(address)",
      "balanceOf(address)",
    ];
    const RECOVERY = ["withdraw()", "claim()", "exit()", "getReward()", "unstake()", "redeem()"];
    const param = me;
    for (const c of contracts) {
      await new Promise((ok) => setTimeout(ok, 150));
      let hitView: string | null = null;
      let hitVal = 0n;
      for (const v of VIEWS) {
        const r = await post<{ constant_result?: string[] }>("/wallet/triggerconstantcontract", {
          owner_address: owner,
          contract_address: c,
          function_selector: v,
          parameter: v.includes("bool") ? "1".padStart(64, "0") : param,
          visible: true,
        }).catch(() => null);
        const val = r?.constant_result?.[0]
          ? BigInt(`0x${r.constant_result[0].slice(0, 64) || "0"}`)
          : 0n;
        if (val > 0n && val < 10n ** 30n) {
          hitView = v;
          hitVal = val;
          break;
        }
      }
      if (!hitView) continue;
      const hints: { name: string; selector: string; abi?: string; source?: string }[] = [];
      for (const sig of RECOVERY) {
        const r = await post<{ constant_result?: string[]; result?: { result?: boolean } }>(
          "/wallet/triggerconstantcontract",
          {
            owner_address: owner,
            contract_address: c,
            function_selector: sig,
            parameter: "",
            visible: true,
          },
        ).catch(() => null);
        if (r && (r.constant_result || r.result)) {
          hints.push({ name: sig, selector: sig, abi: `function ${sig}` });
        }
      }
      const trx = Number(hitVal) / 1e6;
      logPromoteCandidate(env, {
        chainId: TRON,
        address: c,
        what: `${hitView}=${hitVal}`,
        valueUsd: null,
        selectors: hints.map((h) => h.name),
      });
      out.push({
        kind: "legacy",
        protocol: `Tron contract ${short(c)}`,
        chainId: TRON,
        what: `${hitView.split("(")[0]} returns ${hitVal} (≈${trx} TRX if sun-denominated)${hints.length ? `; recovery: ${hints.map((h) => h.name).join(", ")}` : ""}`,
        valueUsd: null,
        confidence: hints.length ? "medium" : "low",
        recoveryHints: hints,
        action: hints.length
          ? `Build ${hints[0]!.name} against ${c} on Tronscan / TronLink, then swap on SwapChan`
          : `Open ${c} on Tronscan and claim/withdraw from its dApp`,
        link: `https://tronscan.org/#/contract/${c}`,
        evidence: [
          {
            chainId: TRON,
            address: c,
            call: hitView,
            args: [owner],
            raw: `0x${hitVal.toString(16)}`,
          },
        ],
        verifiedSource: `https://tronscan.org/#/contract/${c}/code`,
      });
    }
  } catch {}
  return out;
}

async function solanaRent(f: F, env: NodeJS.ProcessEnv, owner: string): Promise<Found[]> {
  const progs = [
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ];
  let empty = 0;
  let lamports = 0;
  for (const p of progs) {
    const r = await solRpc<{
      value: {
        account: {
          lamports: number;
          data: { parsed: { info: { tokenAmount: { amount: string } } } };
        };
      }[];
    }>(f, env, "getTokenAccountsByOwner", [
      owner,
      { programId: p },
      { encoding: "jsonParsed" },
    ]).catch(() => ({ value: [] }));
    for (const a of r.value)
      if (a.account.data.parsed.info.tokenAmount.amount === "0") {
        empty++;
        lamports += a.account.lamports;
      }
  }
  if (!empty) return [];
  const sol = lamports / 1e9;
  const px = await prices(f, [{ chainId: SOLANA, address: nativeOf(SOLANA) }]);
  const p = pxOf(px, SOLANA, nativeOf(SOLANA))?.price ?? null;
  return [
    {
      kind: "solana-rent",
      protocol: "Solana rent",
      chainId: SOLANA,
      what: `${empty} empty token accounts holding ${sol.toFixed(5)} SOL of rent`,
      valueUsd: p ? r2(sol * p) : null,
      action:
        "Close the empty token accounts in your wallet (Phantom/Solflare 'close empty accounts') to reclaim the SOL, then swap it on SwapChan",
      link: toUsdc(SOLANA, nativeOf(SOLANA), sol.toFixed(5)),
    },
  ];
}

// ---------- 6b. contract archaeology: every contract the wallet ever touched, probed generically ----------
const IDEX_V1 = "0x2a0c0DBEcC7E4D658f48E01e3fA353F44050c208";
const UNI_V3_NPM = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const MAX_U128 = 2n ** 128n - 1n;
const REWARD_VIEWS = [
  "earned(address)",
  "dividendsOf(address)",
  "claimable(address)",
  "withdrawableDividendOf(address)",
  "pendingRewards(address)",
  "claimableReward(address)",
] as const;
/** Discover every contract a wallet interacted with (full explorer history) and probe it with balance-like views. */

/** Solana archaeology: programs/accounts the wallet owns or staked with; surface withdrawable stake + token accounts with large balances. */
export async function solanaArchaeology(
  f: F,
  env: NodeJS.ProcessEnv,
  owner: string,
): Promise<Found[]> {
  const out: Found[] = [];
  // Token accounts owned (already partially covered by solanaRent) — also probe stake + vote
  const parsed = await solRpc<
    {
      pubkey: string;
      account: {
        lamports: number;
        data: { program: string; parsed?: { type: string; info: Record<string, unknown> } };
        owner: string;
      };
    }[]
  >(f, env, "getTokenAccountsByOwner", [
    owner,
    { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
    { encoding: "jsonParsed" },
  ])
    // RPC returns { value: [...] }, not a bare array
    .then((r) => ((r as unknown as { value?: unknown }).value ?? r) as typeof r)
    .catch(() => []);
  const px = await prices(f, [
    { chainId: SOLANA, address: "11111111111111111111111111111111" },
  ]).catch(() => new Map());
  const solP = pxOf(px, SOLANA, "11111111111111111111111111111111")?.price ?? null;
  for (const a of parsed.slice(0, 40)) {
    const info = a.account.data.parsed?.info as
      | {
          tokenAmount?: { uiAmount: number | null; decimals: number; amount: string };
          mint?: string;
        }
      | undefined;
    const ui = info?.tokenAmount?.uiAmount ?? 0;
    if (!ui || ui < 0.01) continue;
    const mint = info?.mint ?? "?";
    out.push({
      kind: "claimable",
      protocol: `SPL token ${mint}`,
      chainId: SOLANA,
      what: `${ui} tokens (mint ${mint}) in ATA ${a.pubkey}`,
      valueUsd: null,
      confidence: "medium",
      action: "Swap the SPL token on SwapChan (or close empty ATAs to reclaim rent)",
      link: toUsdc(SOLANA, mint, String(ui)),
      evidence: [
        {
          chainId: SOLANA,
          address: a.pubkey,
          call: "getTokenAccountsByOwner",
          args: [owner, mint],
          raw: info?.tokenAmount?.amount ?? String(ui),
        },
      ],
    });
    if (ui > 1000) {
      logPromoteCandidate(env, {
        chainId: SOLANA,
        address: mint,
        what: `SPL balance ${ui}`,
        valueUsd: null,
      });
    }
  }
  // Programs the wallet is authority for: scan recent signatures → unique program ids
  try {
    const sigs = await solRpc<{ signature: string }[]>(f, env, "getSignaturesForAddress", [
      owner,
      { limit: 50 },
    ]).catch(() => []);
    const programs = new Set<string>();
    for (const s of sigs.slice(0, 25)) {
      const tx = await solRpc<{
        transaction: {
          message: {
            accountKeys: (string | { pubkey: string })[];
            instructions: { programIdIndex: number }[];
          };
        };
      } | null>(f, env, "getTransaction", [
        s.signature,
        { encoding: "json", maxSupportedTransactionVersion: 0 },
      ]).catch(() => null);
      if (!tx) continue;
      const keys = tx.transaction.message.accountKeys.map((k) =>
        typeof k === "string" ? k : k.pubkey,
      );
      for (const ix of tx.transaction.message.instructions)
        if (keys[ix.programIdIndex]) programs.add(keys[ix.programIdIndex]!);
    }
    for (const prog of [...programs].slice(0, 15)) {
      if (prog === "11111111111111111111111111111111") continue;
      if (prog === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") continue;
      if (prog === "Stake11111111111111111111111111111111111111") continue;
      out.push({
        kind: "legacy",
        protocol: `Solana program ${prog}`,
        chainId: SOLANA,
        what: `Wallet history includes program ${prog} — check its dApp for claimable/unstake`,
        valueUsd: null,
        confidence: "low",
        action:
          "Open the program's dApp / explorer; claim or close accounts, then swap on SwapChan",
        link: `https://solscan.io/account/${prog}`,
        evidence: [
          { chainId: SOLANA, address: prog, call: "history", args: [owner], raw: "interacted" },
        ],
        recoveryHints: [],
      });
      logPromoteCandidate(env, {
        chainId: SOLANA,
        address: prog,
        what: "history program",
        valueUsd: null,
      });
    }
  } catch {}
  void solP;
  return out;
}

/** Archaeology vault gate: the wallet called the contract itself, or it is a registry vault. */
export function isVaultCandidate(
  addr: string,
  called: Set<string>,
  registry: Set<string>,
): boolean {
  const a = addr.toLowerCase();
  return called.has(a) || registry.has(a);
}

const vaultRedeemData = (shares: bigint, owner: `0x${string}`) =>
  encodeFunctionData({
    abi: fn("redeem(uint256,address,address)"),
    functionName: "redeem",
    args: [shares, owner, owner],
  });

export async function evmArchaeology(
  f: F,
  env: NodeJS.ProcessEnv,
  chainId: number,
  owner: `0x${string}`,
): Promise<{ items: Found[]; stats: Record<string, number | string> }> {
  const me = owner.toLowerCase();
  const c = evmClient(chainId, env);
  const items: Found[] = [];
  const stats: Record<string, number | string> = {};
  let explorerFallbacks = 0;
  let failedBatches = 0;
  const tArch = Date.now();
  // 1. discovery
  let called: string[] = [];
  let tokens: string[] = [];
  let nfts: { contract: string; id: string; name: string }[] = [];
  for (const ex of explorerApi(chainId, env)) {
    try {
      const get = async (action: string, n = 1000) => {
        for (let a = 0; ; a++) {
          const r: { result: ExRow[] | string | null; message?: string } = await json<{
            result: ExRow[] | string | null;
          }>(
            f,
            ex.url(`module=account&action=${action}&address=${owner}&sort=desc&page=1&offset=${n}`),
            undefined,
            20_000,
          ).catch((e: Error) => {
            if (a < 3 && /429/.test(e.message)) return { result: "rate limit" };
            throw e;
          });
          if (Array.isArray(r.result))
            return r.result as (ExRow & { tokenID?: string; tokenName?: string })[];
          if (/rate limit/i.test(String(r.result)) && a < 3) {
            await new Promise((ok) => setTimeout(ok, 1500 * (a + 1)));
            continue;
          }
          explorerFallbacks++;
          return [];
        }
      };
      // the three lists are independent: fetched together (each keeps its own rate-limit retry) instead of one after
      // another
      const [txs, tt, nt] = await Promise.all([
        get("txlist", 2000),
        get("tokentx", 2000),
        get("tokennfttx", 1000),
      ]);
      called = [
        ...new Set(
          txs
            .filter((t) => t.from.toLowerCase() === me && t.to && t.isError !== "1")
            .map((t) => t.to.toLowerCase()),
        ),
      ];
      tokens = [...new Set(tt.map((t) => (t.contractAddress ?? "").toLowerCase()).filter(Boolean))];
      const held = new Map<string, { contract: string; id: string; name: string }>();
      for (const t of [...nt].reverse()) {
        const k = `${t.contractAddress}:${t.tokenID}`.toLowerCase();
        if (t.to.toLowerCase() === me)
          held.set(k, { contract: t.contractAddress!, id: t.tokenID!, name: t.tokenName || "?" });
        else held.delete(k);
      }
      nfts = [...held.values()];
      stats.explorer = ex.name;
      break;
    } catch {}
  }
  if (explorerFallbacks) stats.explorerFallbacks = explorerFallbacks;
  stats.contractsCalled = called.length;
  stats.tokensSeen = tokens.length;
  stats.discoverMs = Date.now() - tArch;
  if (!stats.explorer) {
    // No keyless explorer (Base, Arbitrum): discover via Alchemy getAssetTransfers — the interaction
    // trail (tokens received/sent + contracts called). A position the user just created is found here.
    const alch = await alchemyDiscover(f, env, chainId, owner).catch(() => null);
    if (!alch || (alch.tokens.length === 0 && alch.called.length === 0))
      return {
        items,
        stats: {
          ...stats,
          note: alch ? "no activity found" : "no keyless explorer for this chain",
        },
      };
    tokens = alch.tokens;
    called = alch.called;
    stats.explorer = "alchemy getAssetTransfers";
    stats.alchemy = 1;
    stats.contractsCalled = called.length;
    stats.tokensSeen = tokens.length;
  }
  const cands = [...new Set([...called, ...tokens])].slice(0, 400) as `0x${string}`[];
  stats.probed = cands.length;
  const mc = async <T>(
    calls: { address: `0x${string}`; abi: unknown; functionName: string; args?: unknown[] }[],
  ) => {
    const out: (T | null)[] = [];
    for (let i = 0; i < calls.length; i += 300) {
      const r = await c
        .multicall({ allowFailure: true, contracts: calls.slice(i, i + 300) as never })
        .catch(() => {
          failedBatches++;
          stats.failedBatches = failedBatches;
          return calls.slice(i, i + 300).map(() => ({ status: "failure" as const }));
        });
      for (const x of r as { status: string; result?: unknown }[])
        out.push(x.status === "success" ? (x.result as T) : null);
    }
    return out;
  };
  const one = (s: string) => fn(`${s} view returns (uint256)`);
  // 2. balance-like probes on every discovered contract
  const bals = await mc<bigint>(
    cands.map((a) => ({
      address: a,
      abi: one("balanceOf(address)"),
      functionName: "balanceOf",
      args: [owner],
    })),
  );
  const curated = new Set(
    [P3D, FOMO3D, ETHERDELTA, IDEX_V1, LIQUITY_TROVES, LIQUITY_SURPLUS].map((a) => a.toLowerCase()),
  );
  called = called.filter((a) => !curated.has(a));
  const probe = (who: `0x${string}`) =>
    Promise.all(
      REWARD_VIEWS.map((v) =>
        mc<bigint>(
          called.slice(0, 300).map((a) => ({
            address: a as `0x${string}`,
            abi: one(v),
            functionName: v.split("(")[0]!,
            args: [who],
          })),
        ),
      ),
    );
  // a view that returns the same nonzero value for a random address is a fallback/garbage, not your balance
  const [rewards, control] = await Promise.all([
    probe(owner),
    probe("0x000000000000000000000000000000000000dEaD"),
  ]);
  const withBal = cands
    .map((a, i) => ({ a, bal: bals[i] ?? 0n }))
    .filter((x) => typeof x.bal === "bigint" && x.bal > 0n);
  stats.nonzeroBalances = withBal.length;
  stats.probeMs = Date.now() - tArch;
  // 3. classify contracts with a balance: ERC-4626 / Yearn vault, Uniswap-v2-style LP, staking/receipt token
  const meta = async (
    fnSig: string,
    name: string,
    args?: (x: { a: `0x${string}`; bal: bigint }) => unknown[],
  ) =>
    mc<unknown>(
      withBal.map((x) => ({
        address: x.a,
        abi: fn(fnSig),
        functionName: name,
        ...(args ? { args: args(x) } : {}),
      })),
    );
  const [dec, sym, asset, conv, token, pps, r0, t0, t1, ts] = await Promise.all([
    meta("decimals() view returns (uint8)", "decimals"),
    meta("symbol() view returns (string)", "symbol"),
    meta("asset() view returns (address)", "asset"),
    meta("convertToAssets(uint256) view returns (uint256)", "convertToAssets", (x) => [x.bal]),
    meta("token() view returns (address)", "token"),
    meta("pricePerShare() view returns (uint256)", "pricePerShare"),
    meta("getReserves() view returns (uint112,uint112,uint32)", "getReserves"),
    meta("token0() view returns (address)", "token0"),
    meta("token1() view returns (address)", "token1"),
    meta("totalSupply() view returns (uint256)", "totalSupply"),
  ]);
  // a token the wallet merely received is not a vault just because it answers asset()/convertToAssets():
  // only contracts the wallet called itself, or ones in the vault registry, are classified as vaults
  const registry = new Set(
    (await vaultList(f).catch(() => []))
      .filter((v) => v.chainId === chainId)
      .map((v) => v.address.toLowerCase()),
  );
  const calledSet = new Set(called.map((a) => a.toLowerCase()));
  const vaultOk = withBal.map((x) => isVaultCandidate(x.a, calledSet, registry));
  // simulate redeem(all shares, you, you) from the wallet before offering it as a step to sign
  const redeemOk = await Promise.all(
    withBal.map((x, i) =>
      vaultOk[i] && asset[i] && typeof conv[i] === "bigint"
        ? c
            .call({ account: owner, to: x.a, data: vaultRedeemData(x.bal, owner) })
            .then(() => true)
            .catch(() => false)
        : Promise.resolve(false),
    ),
  );
  type Pend = { amt: [string, bigint][]; build: (usd: number | null, amts: string) => Found };
  const pend: Pend[] = [];
  const decOf = new Map<string, number>();
  const symOf = new Map<string, string>();
  const underlyings = new Set<string>();
  withBal.forEach((x, i) => {
    const d = Number(dec[i] ?? 18);
    const s = String(sym[i] ?? "?");
    const sh = Number(formatUnits(x.bal, d));
    if (r0[i] && t0[i] && t1[i] && ts[i]) {
      const [a, b] = r0[i] as [bigint, bigint];
      const tot = ts[i] as bigint;
      if (!tot) return;
      const u0 = (a * x.bal) / tot;
      const u1 = (b * x.bal) / tot;
      underlyings.add(String(t0[i])).add(String(t1[i]));
      pend.push({
        amt: [
          [String(t0[i]), u0],
          [String(t1[i]), u1],
        ],
        build: (usd) => {
          const t0a = getAddress(String(t0[i])) as `0x${string}`;
          const t1a = getAddress(String(t1[i])) as `0x${string}`;
          // claimTx built sync via encode — router removeLiquidity (approve pair→router first)
          const ROUTER: Record<number, `0x${string}`> = {
            1: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
            8453: "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24",
            10: "0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2",
            42161: "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24",
            137: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
            56: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
          };
          const router = ROUTER[chainId];
          // mins from the live reserves read this scan (u0/u1 = pro-rata share) minus 1%, 20-minute deadline
          const deadline = exitDeadline();
          const quoted = u0 > 0n || u1 > 0n;
          const claimTx =
            router && quoted
              ? {
                  chainId,
                  to: router,
                  data: encodeFunctionData({
                    abi: fn(
                      "removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)",
                    ),
                    functionName: "removeLiquidity",
                    args: [t0a, t1a, x.bal, minOut(u0), minOut(u1), owner, deadline],
                  }),
                  value: "0",
                  description: `removeLiquidity: burn ${sh.toPrecision(5)} LP (approve ${short(x.a)}→router first)`,
                }
              : undefined;
          return {
            kind: "legacy" as const,
            protocol: `LP ${s} ${short(x.a)}`,
            chainId,
            what: `${sh.toPrecision(5)} LP tokens of ${x.a} (Uniswap-v2-style pool)`,
            valueUsd: usd,
            ...(claimTx ? { claimTx } : {}),
            action: claimTx
              ? `Approve the router to spend LP, sign removeLiquidity, then swap both tokens on SwapChan. ${PRIVATE_SUBMISSION_NOTE}`
              : router && !quoted
                ? NO_QUOTE_NOTE
                : "Remove liquidity on the pool's app, then swap the two tokens on SwapChan",
            link: `${EXPLORER[chainId] ?? "https://etherscan.io"}/address/${x.a}`,
            evidence: [
              {
                chainId,
                address: x.a,
                call: "balanceOf(address)",
                abi: "balanceOf(address) view returns (uint256)",
                args: [owner],
                raw: `0x${x.bal.toString(16)}`,
              },
              {
                chainId,
                address: x.a,
                call: "getReserves()",
                abi: "getReserves() view returns (uint112,uint112,uint32)",
                args: [],
                raw: [String(a), String(b)],
              },
              { chainId, address: x.a, call: "token0()/token1()", args: [], raw: [t0a, t1a] },
            ],
            underlying: t0a,
          };
        },
      });
      return;
    }
    if (!vaultOk[i]) return;
    const und = (asset[i] ?? token[i]) as string | null;
    let amt: bigint | null = null;
    if (asset[i] && typeof conv[i] === "bigint") amt = conv[i] as bigint;
    else if (token[i] && typeof pps[i] === "bigint")
      amt = ((pps[i] as bigint) * x.bal) / 10n ** BigInt(d);
    if (und && amt !== null && amt > 0n) {
      underlyings.add(und);
      pend.push({
        amt: [[und, amt]],
        build: (usd) => ({
          kind: "legacy",
          protocol: `Vault ${s}`,
          chainId,
          what: `${sh.toPrecision(5)} ${s} vault shares (${asset[i] ? "ERC-4626" : "Yearn-v2 pricePerShare"}) at ${x.a}`,
          valueUsd: usd,
          action:
            asset[i] && !redeemOk[i]
              ? `redeem() did not simulate from your wallet; withdraw on the ${s} vault's own app, then swap the underlying on SwapChan`
              : `Withdraw from the ${s} vault, then swap the underlying on SwapChan`,
          link: `${EXPLORER[chainId] ?? "https://etherscan.io"}/address/${x.a}`,
          ...(asset[i] && !redeemOk[i]
            ? {}
            : {
                claimTx: {
                  chainId,
                  to: x.a,
                  data: asset[i]
                    ? vaultRedeemData(x.bal, owner)
                    : encodeFunctionData({ abi: fn("withdraw()"), functionName: "withdraw" }),
                  value: "0",
                  description: asset[i]
                    ? `redeem(all shares, you, you): withdraw from ${s}`
                    : `withdraw(): exit the ${s} Yearn vault`,
                },
              }),
          underlying: und,
          evidence: [
            {
              chainId,
              address: x.a,
              call: "balanceOf(address)",
              abi: "balanceOf(address) view returns (uint256)",
              args: [owner],
              raw: `0x${x.bal.toString(16)}`,
            },
            ...(asset[i]
              ? [
                  {
                    chainId,
                    address: x.a,
                    call: "convertToAssets(uint256)",
                    abi: "convertToAssets(uint256) view returns (uint256)",
                    args: [x.bal.toString()],
                    raw: `0x${(amt as bigint).toString(16)}`,
                  },
                ]
              : [
                  {
                    chainId,
                    address: x.a,
                    call: "pricePerShare()",
                    abi: "pricePerShare() view returns (uint256)",
                    args: [],
                    raw: String(pps[i]),
                  },
                ]),
          ],
          confidence: "high" as const,
        }),
      });
    }
  });
  // reward views with a balance — unknown contracts: surface ABI/selectors so agents can build recovery
  const RECOVERY_FNS = [
    "withdraw()",
    "exit()",
    "getReward()",
    "getReward(address)",
    "claim()",
    "claimRewards()",
    "unstake()",
    "redeem(uint256)",
    "redeem(uint256,address,address)",
  ] as const;
  const unknownHits: { a: string; view: string; raw: bigint }[] = [];
  called.slice(0, 300).forEach((a, i) => {
    for (let k = 0; k < REWARD_VIEWS.length; k++) {
      const v = rewards[k]![i];
      if (typeof v === "bigint" && v > 0n && v < 10n ** 33n && control[k]![i] !== v) {
        unknownHits.push({ a, view: REWARD_VIEWS[k]!, raw: v });
        break;
      }
    }
  });
  // Probe recovery-looking selectors + optional Sourcify ABI for each positive hit
  for (const hit of unknownHits.slice(0, 40)) {
    const addr = hit.a as `0x${string}`;
    const hints: { name: string; selector: string; abi?: string }[] = [];
    for (const sig of RECOVERY_FNS) {
      try {
        const sel = btSelector(sig);
        // eth_call with empty/owner args — success without revert means selector exists
        const name = sig.split("(")[0]!;
        const abi = fn(
          sig.includes("address,address")
            ? `${sig} returns (uint256)`
            : sig.includes("uint256,address")
              ? sig
              : sig.includes("address")
                ? `${sig}`
                : sig.includes("uint256")
                  ? `${sig}`
                  : `${sig}`,
        );
        const args =
          sig === "getReward(address)"
            ? [owner]
            : sig === "redeem(uint256,address,address)"
              ? [0n, owner, owner]
              : sig === "redeem(uint256)"
                ? [0n]
                : [];
        await c
          .call({
            account: owner,
            to: addr,
            data: encodeFunctionData({
              abi: [parseAbiItem(`function ${sig}`)] as const,
              functionName: name as never,
              args: args as never,
            }),
          })
          .then(() => {
            hints.push({ name: sig, selector: sel, abi: `function ${sig}` });
          })
          .catch(() => {});
      } catch {}
    }
    let verifiedSource: string | undefined;
    let verifiedAbi: unknown;
    try {
      const ch = {
        1: "1",
        8453: "8453",
        10: "10",
        42161: "42161",
        137: "137",
        56: "56",
        43114: "43114",
      }[chainId];
      if (ch) {
        const s = await json<{ status?: string; files?: { name: string; content: string }[] }>(
          f,
          `https://sourcify.dev/server/files/any/${ch}/${addr}`,
          undefined,
          8_000,
        ).catch(() => null);
        if (s && (s.status === "perfect" || s.status === "partial" || s.files?.length)) {
          verifiedSource = `https://sourcify.dev/#/lookup/${addr}`;
          const meta = s.files?.find((x) => /metadata\.json$/i.test(x.name));
          if (meta) {
            try {
              verifiedAbi = JSON.parse(meta.content)?.output?.abi;
            } catch {}
          }
        }
      }
    } catch {}
    // Blockscout verified ABI, else bytecode selectors via openchain/4byte (names are guesses)
    let guessed = false;
    if (!verifiedAbi) {
      const bs = await blockscoutAbi(f, chainId, addr);
      if (bs) {
        verifiedAbi = bs;
        verifiedSource ??= `blockscout:${chainId}:${addr}`;
      }
    }
    try {
      let names: string[] = [];
      if (!verifiedAbi) {
        const code = await c.getCode({ address: addr }).catch(() => undefined);
        const sels = code ? bytecodeSelectors(code) : [];
        const res = await resolveSelectors(f, sels);
        names = Object.values(res).flat();
        guessed = true;
      }
      const have = new Set(hints.map((h) => h.name));
      for (const sig of recoveryCandidates(names, verifiedAbi as unknown[] | undefined)
        .filter((x) => !have.has(x))
        .slice(0, 8)) {
        try {
          const it = parseAbiItem(`function ${sig}`) as never;
          await c.call({
            account: owner,
            to: addr,
            data: encodeFunctionData({
              abi: [it],
              args: sig.includes("address") ? [owner] : [],
            } as never),
          });
          hints.push({
            name: sig,
            selector: btSelector(sig),
            abi: `function ${sig}`,
            ...(guessed
              ? { source: "signature database guess (openchain/4byte), simulated OK" }
              : { source: "verified ABI, simulated OK" }),
          } as (typeof hints)[number]);
        } catch {}
      }
    } catch {}
    // Prefer building a standard recovery tx when a safe selector answered
    const prefer =
      hints.find((h) =>
        ["withdraw()", "exit()", "getReward()", "claim()", "claimRewards()"].includes(h.name),
      ) ??
      hints.find((h) => h.name === "getReward(address)") ??
      (guessed ? undefined : hints[0]);
    const claimTx = prefer
      ? {
          chainId,
          to: addr,
          data: encodeFunctionData({
            abi: [parseAbiItem(`function ${prefer.name}`)] as const,
            functionName: prefer.name.split("(")[0] as never,
            args: (prefer.name.includes("address") ? [owner] : []) as never,
          }),
          value: "0",
          description: `${prefer.name}: archaeology-suggested recovery on ${short(addr)}`,
        }
      : undefined;
    if (hit.raw > 10n ** 15n || hints.length) {
      logPromoteCandidate(env, {
        chainId,
        address: addr,
        what: `${hit.view}=${hit.raw}`,
        valueUsd: null,
        selectors: hints.map((h) => h.selector),
      });
    }
    // P3D clones (PoWH/GREED/etc.): dividends are paid in the chain's native coin out of the
    // contract's own balance. Detect generically: dividends view + buyPrice()/sellPrice() answers
    // + contract holds at least the owed amount natively → value exactly in native & USD.
    let p3d: { amount: number; usd: number | null; sym: string } | null = null;
    if (/^(dividendsOf|myDividends)/.test(hit.view)) {
      try {
        const [bal, okPrice] = await Promise.all([
          c.getBalance({ address: addr }),
          c
            .call({
              to: addr,
              data: encodeFunctionData({
                abi: [parseAbiItem("function sellPrice() view returns (uint256)")] as const,
                functionName: "sellPrice",
              }),
            })
            .then(() => true)
            .catch(() => false),
        ]);
        if (okPrice && bal >= hit.raw) {
          const cg: Record<number, [string, string]> = {
            1: ["ethereum", "ETH"],
            10: ["ethereum", "ETH"],
            42161: ["ethereum", "ETH"],
            8453: ["ethereum", "ETH"],
            56: ["binancecoin", "BNB"],
            137: ["matic-network", "POL"],
            43114: ["avalanche-2", "AVAX"],
          };
          const [id, sym] = cg[chainId] ?? ["ethereum", "ETH"];
          const px = await json<{ coins?: Record<string, { price: number }> }>(
            f,
            `https://coins.llama.fi/prices/current/coingecko:${id}`,
            undefined,
            8_000,
          )
            .then((r) => r.coins?.[`coingecko:${id}`]?.price ?? null)
            .catch(() => null);
          // clone tokens are also redeemable via the bonding curve: price them with calculateEthereumReceived
          const tokEth = await c
            .readContract({
              address: addr,
              abi: fn("balanceOf(address) view returns (uint256)"),
              functionName: "balanceOf",
              args: [owner],
            })
            .then((tb) =>
              (tb as bigint) > 0n
                ? c.readContract({
                    address: addr,
                    abi: fn("calculateEthereumReceived(uint256) view returns (uint256)"),
                    functionName: "calculateEthereumReceived",
                    args: [tb as bigint],
                  })
                : 0n,
            )
            .then((x) => x as bigint)
            .catch(() => 0n);
          const sellable = bal >= hit.raw + tokEth ? tokEth : 0n;
          const amount = Number(hit.raw + sellable) / 1e18;
          p3d = { amount, usd: px === null ? null : Math.round(amount * px * 100) / 100, sym };
        }
      } catch {}
    }
    items.push({
      // only exact (P3D-style native dividends) is claimable; raw reward views are leads
      kind: p3d ? "claimable" : "lead",
      protocol: `Contract ${short(addr)}`,
      chainId,
      ...(p3d ? { estimateKind: "exact" } : {}),
      what: p3d
        ? `${p3d.amount.toFixed(9).replace(/0+$/, "")} ${p3d.sym} in P3D-style dividends (${hit.view.split("(")[0]}; paid in native ${p3d.sym} from the contract's balance)${hints.length ? `; recovery: ${hints.map((h) => h.name).join(", ")}` : ""}`
        : `${hit.view.split("(")[0]}(you) = ${hit.raw} (raw units; reward token unknown)${hints.length ? `; recovery selectors: ${hints.map((h) => h.name).join(", ")}` : ""}`,
      valueUsd: p3d?.usd ?? null,
      ...(claimTx ? { claimTx } : {}),
      action: claimTx
        ? "Sign the suggested recovery call (funds pinned to your wallet), then swap on SwapChan"
        : "Open the contract's dApp / use recoveryHints selectors to build a claim, then swap on SwapChan",
      link: `${EXPLORER[chainId] ?? "https://etherscan.io"}/address/${addr}`,
      evidence: [
        {
          chainId,
          address: addr,
          call: hit.view,
          abi: `${hit.view} view returns (uint256)`,
          args: [owner],
          raw: `0x${hit.raw.toString(16)}`,
        },
      ],
      risk: verifiedSource ? undefined : "Unverified / unknown contract — simulate before signing",
      ...(verifiedSource || hints.length
        ? {
            // extra fields for agents (Found is open enough via structural typing at push sites)
          }
        : {}),
    } as Found & {
      confidence?: string;
      recoveryHints?: typeof hints;
      verifiedSource?: string;
      verifiedAbi?: unknown;
    });
    const last = items[items.length - 1] as Found & {
      confidence?: string;
      recoveryHints?: typeof hints;
      verifiedSource?: string;
      verifiedAbi?: unknown;
    };
    last.confidence = claimTx ? "medium" : hints.length ? "low" : "low";
    if (hints.length) last.recoveryHints = hints;
    if (verifiedSource) last.verifiedSource = verifiedSource;
    if (verifiedAbi) last.verifiedAbi = verifiedAbi;
  }
  // 4. legacy exchanges: ERC-20 + ETH balances left in EtherDelta / IDEX v1
  if (chainId === 1) {
    const toks = ["0x0000000000000000000000000000000000000000", ...tokens.slice(0, 300)];
    const exch = [
      { name: "EtherDelta", addr: ETHERDELTA },
      { name: "IDEX v1", addr: IDEX_V1 },
    ] as const;
    for (const e of exch) {
      const r = await mc<bigint>(
        toks.map((t) => ({
          address: e.addr as `0x${string}`,
          abi: fn("balanceOf(address,address) view returns (uint256)"),
          functionName: "balanceOf",
          args: [t, owner],
        })),
      );
      toks.forEach((t, i) => {
        const v = r[i];
        if (typeof v !== "bigint" || v === 0n || (e.name === "EtherDelta" && i === 0)) return; // ED ETH handled in legacyEth
        const tok = i === 0 ? NATIVE_TOKEN : getAddress(t);
        underlyings.add(tok);
        pend.push({
          amt: [[tok, v]],
          build: (usd, amts) => ({
            kind: "legacy",
            protocol: e.name,
            chainId: 1,
            what: `${amts} deposited in ${e.name}`,
            valueUsd: usd,
            action: `Withdraw from ${e.name} (${e.addr}) with withdrawToken/withdraw, then swap on SwapChan`,
            ...(e.name === "EtherDelta" && i > 0
              ? {
                  claimTx: {
                    chainId: 1,
                    to: e.addr,
                    data: encodeFunctionData({
                      abi: fn("withdrawToken(address,uint256)"),
                      functionName: "withdrawToken",
                      args: [tok as `0x${string}`, v],
                    }),
                    value: "0",
                    description: "withdrawToken(token, amount): pull it out of EtherDelta",
                  },
                  underlying: tok,
                }
              : {}),
            link: `https://etherscan.io/address/${e.addr}#readContract`,
            risk: "Legacy exchange contract; withdraw directly via Etherscan write-contract.",
          }),
        });
      });
    }
  }
  // 5. Uniswap v3 positions + uncollected fees (collect() simulated as the owner)
  const npm = UNI_V3_NPM;
  const nPos = await c
    .readContract({
      address: npm as `0x${string}`,
      abi: one("balanceOf(address)"),
      functionName: "balanceOf",
      args: [owner],
    })
    .catch(() => 0n);
  stats.uniV3Positions = Number(nPos);
  if (nPos > 0n && (chainId === 1 || chainId === 10 || chainId === 42161 || chainId === 137)) {
    const n = Number(nPos > 300n ? 300n : nPos);
    const ids = (
      await mc<bigint>(
        Array.from({ length: n }, (_, k) => ({
          address: npm as `0x${string}`,
          abi: fn("tokenOfOwnerByIndex(address,uint256) view returns (uint256)"),
          functionName: "tokenOfOwnerByIndex",
          args: [owner, BigInt(k)],
        })),
      )
    ).filter((x): x is bigint => typeof x === "bigint");
    const ps = await mc<readonly unknown[]>(
      ids.map((id) => ({
        address: npm as `0x${string}`,
        abi: fn(
          "positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
        ),
        functionName: "positions",
        args: [id],
      })),
    );
    const live = ids
      .map((id, i) => ({ id, pos: ps[i] }))
      .filter(
        (x) =>
          x.pos &&
          ((x.pos[7] as bigint) > 0n || (x.pos[10] as bigint) > 0n || (x.pos[11] as bigint) > 0n),
      )
      .slice(0, 30);
    stats.uniV3Active = live.length;
    await Promise.all(
      live.map(async ({ id, pos }) => {
        const p = pos!;
        const [a0, a1] = await c
          .simulateContract({
            account: owner,
            address: npm as `0x${string}`,
            abi: fn(
              "collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) returns (uint256,uint256)",
            ),
            functionName: "collect",
            args: [{ tokenId: id, recipient: owner, amount0Max: MAX_U128, amount1Max: MAX_U128 }],
          } as never)
          .then((r) => (r as { result: [bigint, bigint] }).result)
          .catch(() => [p[10] as bigint, p[11] as bigint] as [bigint, bigint]);
        if (a0 === 0n && a1 === 0n) return;
        const liq = p[7] as bigint;
        underlyings.add(String(p[2])).add(String(p[3]));
        pend.push({
          amt: [
            [String(p[2]), a0],
            [String(p[3]), a1],
          ],
          build: (usd, amts) => ({
            kind: "claimable",
            protocol: "Uniswap v3 fees",
            chainId,
            what: `Position #${id} (${liq > 0n ? "active liquidity" : "liquidity withdrawn"}): uncollected fees ${amts}`,
            valueUsd: usd,
            action: "Collect the fees (step 1), then swap on SwapChan",
            claimTx: {
              chainId,
              to: npm,
              data: encodeFunctionData({
                abi: fn(
                  "collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) returns (uint256,uint256)",
                ),
                functionName: "collect",
                args: [
                  { tokenId: id, recipient: owner, amount0Max: MAX_U128, amount1Max: MAX_U128 },
                ],
              }),
              value: "0",
              description: `collect(#${id}): send uncollected fees to you`,
            },
            underlying: String(p[2]),
            link: `https://app.uniswap.org/positions/v3/${chainName(chainId).toLowerCase()}/${id}`,
          }),
        });
      }),
    );
  }
  // 6. price everything pending
  if (pend.length) {
    const list = [...underlyings].map((a) => ({ chainId, address: a }));
    const nonNative = [...underlyings].filter((a) => a !== NATIVE_TOKEN);
    const syms = await mc<string>(
      nonNative.map((a) => ({
        address: a as `0x${string}`,
        abi: fn("symbol() view returns (string)"),
        functionName: "symbol",
      })),
    );
    nonNative.forEach((a, i) => syms[i] && symOf.set(a.toLowerCase(), String(syms[i])));
    const [px, decs] = await Promise.all([
      prices(f, list).catch(() => new Map()),
      mc<number>(
        [...underlyings]
          .filter((a) => a !== NATIVE_TOKEN)
          .map((a) => ({
            address: a as `0x${string}`,
            abi: fn("decimals() view returns (uint8)"),
            functionName: "decimals",
          })),
      ),
    ]);
    [...underlyings]
      .filter((a) => a !== NATIVE_TOKEN)
      .forEach((a, i) => decOf.set(a.toLowerCase(), Number(decs[i] ?? 18)));
    for (const p of pend) {
      let usd: number | null = 0;
      for (const [a, v] of p.amt) {
        const pr = pxOf(px, chainId, a)?.price;
        if (v === 0n) continue;
        if (!pr) {
          usd = null;
          break;
        }
        usd += Number(formatUnits(v, decOf.get(a.toLowerCase()) ?? 18)) * pr;
      }
      const amts = p.amt
        .map(([a, v]) => {
          const n = Number(formatUnits(v, decOf.get(a.toLowerCase()) ?? 18));
          return `${n.toPrecision(5)} ${a === NATIVE_TOKEN ? (NATIVE_SYMBOL[chainId] ?? "ETH") : (symOf.get(a.toLowerCase()) ?? short(a))}`;
        })
        .join(" + ");
      if (usd !== null && usd < 1) continue; // sub-$1 dust shares/fees
      items.push(p.build(usd === null ? null : r2(usd), amts));
    }
  }
  // 7. NFTs still held (unpriced: no free floor-price source)
  if (nfts.length) {
    const own = await mc<string>(
      nfts.slice(0, 200).map((n) => ({
        address: n.contract as `0x${string}`,
        abi: fn("ownerOf(uint256) view returns (address)"),
        functionName: "ownerOf",
        args: [BigInt(n.id)],
      })),
    );
    const byCol = new Map<string, { name: string; ids: string[] }>();
    nfts.slice(0, 200).forEach((n, i) => {
      if (
        String(own[i] ?? "").toLowerCase() !== me ||
        n.contract.toLowerCase() === UNI_V3_NPM.toLowerCase()
      )
        return;
      const e = byCol.get(n.contract) ?? { name: n.name, ids: [] };
      e.ids.push(n.id);
      byCol.set(n.contract, e);
    });
    stats.nftsHeld = [...byCol.values()].reduce((s, e) => s + e.ids.length, 0);
    for (const [col, e] of [...byCol.entries()].slice(0, 15))
      items.push({
        kind: "legacy",
        protocol: `NFT ${e.name}`,
        chainId,
        what: `${e.ids.length} NFT(s) still held (ids ${e.ids.slice(0, 5).join(", ")}${e.ids.length > 5 ? "…" : ""})`,
        valueUsd: null,
        action:
          "Check the collection's floor on a marketplace; sell what you don't want, then swap the proceeds on SwapChan",
        link: `https://opensea.io/assets/${chainName(chainId).toLowerCase()}/${col}`,
      });
  }
  return { items, stats };
}

/** JustLend (Tron Compound fork): supplied jTokens valued via exchangeRateStored. */
const JUSTLEND_COMPTROLLER = "TGjYzgCyPobsNS9n6WcbdLVR9dH7mWqFx7";
export async function justLend(f: F, owner: string): Promise<Found[]> {
  const call = async (contract: string, sel: string, param = ""): Promise<string> => {
    for (let i = 0; ; i++) {
      try {
        const v = await call1(contract, sel, param);
        if (v || i >= 2) return v;
      } catch (e) {
        if (i >= 2) throw e;
      }
      await new Promise((ok) => setTimeout(ok, 1200 * (i + 1)));
    }
  };
  const call1 = async (contract: string, sel: string, param = "") => {
    const r = await json<{ constant_result?: string[] }>(
      f,
      `${TG}/wallet/triggerconstantcontract`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owner_address: owner,
          contract_address: contract,
          function_selector: sel,
          parameter: param,
          visible: true,
        }),
      },
    );
    return r.constant_result?.[0] ?? "";
  };
  const hex = (await import("./onchain.js")).b58decode(owner);
  const me = Buffer.from(hex.slice(1, 21)).toString("hex").padStart(64, "0");
  const all = await call(JUSTLEND_COMPTROLLER, "getAllMarkets()");
  const n = Number(BigInt(`0x${all.slice(64, 128) || "0"}`));
  const markets = Array.from({ length: n }, (_, i) =>
    tronAddr(`41${all.slice(128 + i * 64 + 24, 128 + (i + 1) * 64)}`),
  );
  const out: Found[] = [];
  // keyless TronGrid rate-limits bursts: go sequentially, retry once
  const rows: ({ m: string; u: string; d: number; amt: bigint; s: string } | null)[] = [];
  for (const m of markets.slice(0, 40)) {
    await new Promise((ok) => setTimeout(ok, 250));
    rows.push(
      await (async () => {
        const raw = await call(m, "balanceOf(address)", me).catch(async () => {
          await new Promise((ok) => setTimeout(ok, 1500));
          return call(m, "balanceOf(address)", me).catch(() => "");
        });
        const bal = BigInt(`0x${raw.slice(0, 64) || "0"}`);
        if (!bal) return null;
        // sequential on purpose (keyless TronGrid throttles parallel calls)
        const rate = await call(m, "exchangeRateStored()").catch(() => "");
        const und = await call(m, "underlying()").catch(() => "");
        const sym = await call(m, "symbol()").catch(() => "");
        const u = und && BigInt(`0x${und}`) ? tronAddr(`41${und.slice(24, 64)}`) : nativeOf(TRON);
        const d =
          u === nativeOf(TRON)
            ? 6
            : Number(
                BigInt(`0x${(await call(u, "decimals()").catch(() => "")).slice(0, 64) || "12"}`),
              );
        if (!rate) return null;
        const amt = (bal * BigInt(`0x${rate.slice(0, 64)}`)) / 10n ** 18n;
        const s = Buffer.from(sym.slice(128), "hex").toString().replace(/\0/g, "") || short(m);
        return { m, u, d, amt, s };
      })(),
    );
  }
  const ok = rows.filter(Boolean) as { m: string; u: string; d: number; amt: bigint; s: string }[];
  if (!ok.length) return out;
  const px = await prices(
    f,
    ok.map((r) => ({ chainId: TRON, address: r.u })),
  ).catch(() => new Map());
  for (const r of ok) {
    const a = Number(formatUnits(r.amt, r.d));
    const pp = pxOf(px, TRON, r.u);
    const p = pp?.price;
    if (r.s.includes("…")) r.s = r.u === nativeOf(TRON) ? "jTRX" : `j${pp?.symbol ?? "?"}`;
    out.push({
      kind: "lending",
      protocol: `JustLend ${r.s}`,
      chainId: TRON,
      what: `${a.toPrecision(6)} ${r.s.replace(/^j/, "")} supplied (via ${r.s} at ${r.m})`,
      valueUsd: p ? r2(a * p) : null,
      action: "Withdraw on app.justlend.org, then swap on SwapChan",
      link: toUsdc(TRON, r.u, String(a)),
    });
  }
  return out;
}

// ---------- not-claimable-now split ----------
/** True for findings whose text says they are owed but cannot be claimed right now. */
export function isNotClaimableNow(what: string | undefined): boolean {
  return (
    /^\s*(?:Shown but )?Not claimable\b/i.test(what ?? "") ||
    /:\s*(?:Shown but )?Not claimable\b/i.test(what ?? "")
  );
}
/** True for "shown but not claimable now" findings: a balance view shows ETH the contract would not pay. */
export function isShownOnly(what: string | undefined): boolean {
  return /(?:^|:)\s*Shown but not claimable\b/i.test(what ?? "");
}
/** Shape of one "owed but not claimable now" entry: what is owed and why it cannot be claimed now. */
export function owedLater(i: {
  protocol?: string;
  what?: string;
  title?: string;
  chainId?: number;
  link?: string;
  protocolUrl?: string;
}) {
  const text = i.what ?? i.title?.replace(/^[^:]*:\s*/, "") ?? "";
  const body = text.replace(/^\s*(?:Shown but )?Not claimable(?: now)?:\s*/i, "");
  const amount = /(\d[\d,]*(?:\.\d+)?)\s*([A-Z][A-Za-z0-9]{1,9})\b/.exec(body);
  const cut = /,\s+|\s+but\s+/.exec(body);
  const reason = cut ? body.slice(cut.index + cut[0].length) : body;
  return {
    protocol: i.protocol ?? i.title?.split(":")[0] ?? "",
    ...(i.chainId !== undefined ? { chainId: i.chainId } : {}),
    owed: amount ? `${amount[1]} ${amount[2]}` : null,
    reason,
    detail: text,
    ...(i.protocolUrl || i.link ? { link: i.protocolUrl ?? i.link } : {}),
  };
}

/**
 * A find_money stage threw. Timeouts become a notChecked line; other failures go to errors AND (unless the stage was
 * only cancelled because the scan already finished) to notChecked as "results may be incomplete", so they count
 * toward partial / incompleteSources.
 */
export function recordStageFailure(n: string, e: unknown, notChecked: string[], errors: string[]) {
  const msg = safeReason(e);
  if (msg.startsWith("timed out")) {
    notChecked.push(`${n}: not checked (${msg})`);
    return;
  }
  errors.push(`${n}: ${msg}`);
  // tidyNotChecked collapses reasons that look raw (e.g. the word RPC), which would drop the INCOMPLETE marker
  const why = /\bRPC\b/.test(msg) ? "data source request failed" : msg;
  if (msg !== "scan finished") notChecked.push(`${n}: not checked (${why}, ${INCOMPLETE})`);
}

/** A notChecked line that means the scan's totals may be missing something (a timeout or a dropped read). */
export const INCOMPLETE_RE = /timed out|results may be incomplete/i;
export const incompleteCount = (notChecked: readonly string[]) =>
  notChecked.filter((n) => INCOMPLETE_RE.test(n)).length;
/** How many incomplete notChecked lines are real timeouts (the rest are failed reads / errors). */
export const timeoutCount = (notChecked: readonly string[]) =>
  notChecked.filter((n) => INCOMPLETE_RE.test(n) && /timed out/i.test(n)).length;
/** n = all incomplete sources; timedOut = how many of them actually timed out (defaults to all, for old callers). */
export const partialPrefix = (n: number, timedOut = n) => {
  const t = Math.max(0, Math.min(n, timedOut));
  const other = n - t;
  const src = (k: number) => `${k} source${k === 1 ? "" : "s"}`;
  const parts = [
    t ? `${src(t)} timed out` : "",
    other ? (t ? `${other} could not be checked` : `${src(other)} could not be checked`) : "",
  ].filter(Boolean);
  return `Partial scan: ${parts.join(" and ")}; totals are a lower bound.`;
};

/** One honest sentence: what is claimable now, and what is owed but not claimable now. */
export function findMoneyHeadline(
  found: number,
  totalUsd: number,
  notNow: number,
  shownOnly = 0,
): string {
  const usdS = `$${totalUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const head =
    found === 0
      ? "Nothing claimable right now."
      : totalUsd > 0
        ? `Found ${found} thing${found === 1 ? "" : "s"} worth about ${usdS} you can act on now.`
        : `Found ${found} thing${found === 1 ? "" : "s"} to look at, but none with a dollar value claimable now.`;
  // "owed" only for real queue debts; balance views the contract would not pay are "shown", not owed
  const owed = Math.max(0, notNow - shownOnly);
  const parts = [
    owed ? `${owed} item${owed === 1 ? " is" : "s are"} owed to you but not claimable now` : "",
    shownOnly
      ? `${shownOnly} item${shownOnly === 1 ? " is" : "s are"} shown but not claimable now`
      : "",
  ].filter(Boolean);
  return parts.length ? `${head} ${parts.join("; ")} (see owedNotClaimableNow).` : head;
}

/** Archaeology reads that were silently dropped (explorer gave no list, a multicall batch failed) become notChecked lines. */
export function archaeologyDropLines(
  per: readonly (readonly [string, Record<string, number | string> | undefined])[],
): string[] {
  const out: string[] = [];
  for (const [chain, s] of per) {
    const ex = Number(s?.explorerFallbacks ?? 0);
    const mb = Number(s?.failedBatches ?? 0);
    if (ex)
      out.push(
        `history ${chain}: not checked (explorer history list unavailable for ${ex} quer${ex === 1 ? "y" : "ies"}; results may be incomplete)`,
      );
    if (mb)
      out.push(
        `history ${chain}: not checked (${mb} contract read batch${mb === 1 ? "" : "es"} failed; results may be incomplete)`,
      );
  }
  return out;
}

/** find_money tail deadline: a timeout or a failure becomes a notChecked line, never a silent empty. */
export function makeCap(notChecked: string[], fmMs: Record<string, number>) {
  return async <T>(n: string, p: Promise<T>, empty: T, ms: number): Promise<T> => {
    const t0 = Date.now();
    let to: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<T>((res) => {
          to = setTimeout(() => {
            notChecked.push(`${n}: not checked (timed out after ${ms / 1000}s)`);
            res(empty);
          }, ms);
        }),
      ]);
    } catch (e) {
      notChecked.push(`${n}: not checked (${safeReason(e)}; results may be incomplete)`);
      return empty;
    } finally {
      clearTimeout(to);
      fmMs[n] = Date.now() - t0;
    }
  };
}

// ---------- 6. airdrop_check ----------
export async function airdropCheck(f: F, env: NodeJS.ProcessEnv, input: string) {
  const { address, name } = await resolveAddr(f, env, input);
  return cached(`air:${address}`, 300_000, async () => {
    const vm = vmOfAddr(address);
    const items: Found[] = [];
    const sources: string[] = [];
    let archaeology: Record<string, unknown> | undefined;
    const timings: Record<string, number> = {};
    const notChecked: string[] = [];
    const SOURCE_MS = Number(env.FIND_SOURCE_TIMEOUT_MS ?? 12_000);
    // every source runs in parallel under its own deadline; a slow one becomes a "not checked" line instead of blocking
    const timed = <T>(n: string, p: Promise<T>, empty: T, ms = SOURCE_MS): Promise<T> => {
      const t0 = Date.now();
      let to: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        p.then(
          (v) => ((timings[n] = Date.now() - t0), v),
          (e) => {
            timings[n] = Date.now() - t0;
            notChecked.push(`${n}: not checked (${safeReason(e)})`);
            return empty;
          },
        ),
        new Promise<T>((res) => {
          to = setTimeout(() => {
            timings[n] = ms;
            notChecked.push(`${n}: not checked (timed out after ${ms / 1000}s)`);
            res(empty);
          }, ms);
        }),
      ]).finally(() => clearTimeout(to));
    };
    if (vm === "evm") {
      const own = getAddress(address);
      const merklP = (async () => {
        const mi: Found[] = [];
        const ids = [1, 8453, 42161, 10, 137, 56, 43114, 59144, 534352];
        const rs = await Promise.all(
          ids.map((id) =>
            json<
              {
                chain: { id: number; name: string };
                rewards: {
                  token: { address: string; symbol: string; decimals: number; price?: number };
                  amount: string;
                  claimed: string;
                  pending?: string;
                }[];
              }[]
            >(
              f,
              `https://api.merkl.xyz/v4/users/${address}/rewards?chainId=${id}`,
              undefined,
              12_000,
            ).catch(() => []),
          ),
        );
        for (const r of rs.flat())
          for (const w of r.rewards ?? []) {
            const un = BigInt(w.amount) - BigInt(w.claimed);
            if (un <= 0n) continue;
            const amt = Number(formatUnits(un, w.token.decimals));
            mi.push({
              kind: "claimable",
              protocol: "Merkl rewards",
              chainId: r.chain.id,
              what: `${amt.toPrecision(5)} ${w.token.symbol} unclaimed on ${r.chain.name}`,
              valueUsd: w.token.price ? r2(amt * w.token.price) : null,
              action: `Claim on merkl.xyz, then swap ${w.token.symbol} on SwapChan`,
              link: toUsdc(r.chain.id, getAddress(w.token.address), String(amt)),
            });
          }
        return mi;
      })();
      const ethPxP = prices(f, [{ chainId: 1, address: NATIVE_TOKEN }]).then(
        (eth) => pxOf(eth, 1, NATIVE_TOKEN)?.price ?? null,
      );
      const legacyP = ethPxP.then((px) => legacyEth(env, own, px));
      const registryP = timed(
        "LegacyETH registry",
        ethPxP
          .then((px) => legacyRegistry(env, own, px))
          .then((r) => (notChecked.push(...r.notChecked), r.items)),
        [] as Found[],
        Number(env.FIND_LEGACY_REGISTRY_TIMEOUT_MS ?? 12_000),
      );
      // keyless explorers: Ethereum, Optimism, Scroll, Avalanche, Linea; the free Etherscan key adds Arbitrum and Polygon
      // Base (8453) / Arbitrum (42161) have no free explorer, but Alchemy getAssetTransfers covers
      // them — so with an Alchemy key, archaeology's interaction-native scan runs there too.
      const archSet = new Set([1, 10, 534352, 43114, 59144]);
      if (env.ETHERSCAN_API_KEY) {
        archSet.add(42161);
        archSet.add(137);
      }
      if (env.ALCHEMY_API_KEY) {
        archSet.add(8453);
        archSet.add(42161);
      }
      const archChains = [...archSet];
      const noArch = {
        items: [] as Found[],
        stats: { error: "not checked (timeout)" } as Record<string, number | string>,
      };
      const [
        merklR,
        legacyR,
        wn,
        lido,
        safes,
        vaults,
        aaveS,
        eigen,
        beacon,
        lstQ,
        lp,
        gaugeR,
        chefR,
        v4R,
        pendleR,
        ensR,
        forkR,
        xevmR,
        stuck,
        sablierR,
        hedgeyR,
        teamR,
        uncxR,
        sfR,
        daoR,
        brR,
        perpR,
        ...arch
      ] = await Promise.all([
        timed("Merkl", merklP, [] as Found[]),
        timed("legacy contracts", legacyP, [] as Found[]),
        timed("wrapped native", wrappedNative(f, env, own), []),
        timed("Lido queue", lidoWithdrawals(f, env, own), []),
        timed("Safes", ownedSafes(f, env, own), []),
        timed("vaults", vaultPositions(f, env, own), []),
        timed("Aave/Spark", aaveSupplied(f, env, own), []),
        timed("EigenLayer", eigenLayer(f, env, own), []),
        timed("beacon validators", beaconValidators(f, own), []),
        timed("LST queues", lstQueues(f, env, own), []),
        timed("LP positions", clPositions(f, env, own), []),
        timed("Curve/Convex/Aura staked LP", stakedLp(f, env, own), []),
        timed("SushiSwap MasterChef", sushiChef(f, env, own), []),
        timed("Uniswap v4 positions", v4Positions(f, env, own), []),
        timed("matured Pendle", maturedPendle(f, env, own), []),
        timed("ENS old-registrar deeds", ensDeeds(f, env, own), []),
        timed(
          "ETH fork chains (ETC, ETHW, EtherFair)",
          ethForkScan(f, own).then((r) => (notChecked.push(...r.notChecked), r.items)),
          [],
        ),
        timed(
          "extra EVM chains",
          extraEvmScan(f, own).then((r) => (notChecked.push(...r.notChecked), r.items)),
          [],
        ),
        timed("contract registry", stuckMoneyRegistry(f, env, own), []),
        timed("Sablier vesting streams", sablierStreams(f, env, own), [] as Found[]),
        timed(
          "Hedgey vesting/lockup plans",
          hedgeyPlans(f, env, own).then((r) => (notChecked.push(...r.notChecked), r.items)),
          [] as Found[],
        ),
        timed("Team Finance locks", teamFinanceLocks(f, env, own), [] as Found[]),
        timed("UNCX LP locks", uncxLocks(f, env, own), [] as Found[]),
        timed("TheDAO refund", daoRefunds(f, env, own), [] as Found[]),
        timed(
          "Superfluid balances",
          superfluidBalances(f, env, own).then((r) => (notChecked.push(...r.notChecked), r.items)),
          [] as Found[],
        ),
        timed(
          "canonical bridge withdrawals",
          bridgeWithdrawals(f, env, own).then((r) => (notChecked.push(...r.notChecked), r.items)),
          [] as Found[],
          14_000,
        ),
        timed(
          "perps balances",
          perpsBalances(f, env, own).then((r) => (notChecked.push(...r.notChecked), r.items)),
          [] as Found[],
          11_000,
        ),
        ...archChains.map((id) =>
          timed(
            `history ${chainName(id)}`,
            evmArchaeology(f, env, id, own),
            noArch,
            Number(env.FIND_ARCH_TIMEOUT_MS ?? 15_000),
          ),
        ),
      ]);
      items.push(...(merklR as Found[]), ...(legacyR as Found[]), ...(await registryP));
      sources.push("Merkl API (incentive rewards on 9 EVM chains)");
      sources.push("legacy contract reads (PoWH3D, Fomo3D, EtherDelta, Liquity surplus)");
      sources.push(
        `LegacyETH registry (${LEGACY_REGISTRY_SIZE} listed legacy contracts; confirmed DEXes, Fomo3D forks, Hourglass clones, old ETH wrappers, ICO/presale refunds, NFT-market pull payments, burn-token redemptions, Ethfinex wrappers and simulated-claim refunds/pools read on-chain, the rest reported as not checked yet)`,
      );
      items.push(
        ...(wn as Found[]),
        ...(lido as Found[]),
        ...(safes as Found[]),
        ...(vaults as Found[]),
        ...(aaveS as Found[]),
        ...(eigen as Found[]),
        ...(beacon as Found[]),
        ...(lstQ as Found[]),
        ...(lp as Found[]),
        ...(gaugeR as Found[]),
        ...(chefR as Found[]),
        ...(v4R as Found[]),
        ...(pendleR as Found[]),
        ...(ensR as Found[]),
        ...(forkR as Found[]),
        ...(xevmR as Found[]),
      );
      sources.push(
        "staked LP: every Curve gauge on 7 chains (Curve gauge list), every Convex and Aura pool, SushiSwap MasterChef v1/v2",
      );
      sources.push(
        "concentrated-liquidity positions (principal + fees, exact): Uniswap v3 on 7 chains, Sushi v3, PancakeSwap v3",
      );
      sources.push(
        "withdrawal queues: ether.fi, Frax, Swell, Stader; EigenLayer; beacon validators; Aave/Spark supplied; vault registry: Yearn v2/v3, Beefy, Morpho, sDAI/sUSDS/sfrxETH/scrvUSD/sUSDe on 7 EVM chains",
      );
      sources.push(
        "unwrapped WETH/WBNB/WPOL/WAVAX on 7 chains, Lido withdrawal queue (finalized unstakes), Gnosis Safes you own on 6 chains",
      );
      items.push(
        ...(stuck as Found[]),
        ...(sablierR as Found[]),
        ...(hedgeyR as Found[]),
        ...(teamR as Found[]),
        ...(uncxR as Found[]),
        ...(sfR as Found[]),
        ...(daoR as Found[]),
        ...(brR as Found[]),
        ...(perpR as Found[]),
      );
      sources.push(
        "vesting/locks: Hedgey plans (8 chains), Team Finance, UNCX v2 LP locker, Superfluid Super Tokens (7 chains)",
      );
      sources.push(
        "bridges: Arbitrum Outbox (unexecuted L2→L1), Optimism Portal (prove/finalize); Base not checked",
      );
      sources.push(
        "perps: Hyperliquid perp+spot (note only), GMX v2 funding fees + open positions (Arbitrum)",
      );
      sources.push(
        "known-contract registry: Curve/Convex, Synthetix, Sablier, Pendle, GMX, Rocket Pool rETH, OP/Base/Arb L2 withdrawals, Polygon PoS exits, Multichain/Celer (detect), merkle airdrops (UNI/ENS/1INCH/OP/ARB)",
      );
      // a vault already reported by the vault registry is not repeated by the history scan
      const vaultKeys = new Set(
        (vaults as Found[]).map(
          (v) =>
            `${v.chainId}:${String((v.claimTx as { to?: string } | undefined)?.to ?? "").toLowerCase()}`,
        ),
      );
      // a position already reported with principal+fees is not repeated as "fees only"
      const lpKeys = new Set(
        (lp as Found[]).map((x) => `${x.chainId}:${/#(\d+)/.exec(x.what)?.[1]}`),
      );
      // a LegacyETH registry contract is reported once, by the registry scan, never again by archaeology
      const regAddrs = registryAddressSet();
      for (const a of arch)
        items.push(
          ...dropRegistryDupes(a.items, regAddrs).filter(
            (x) =>
              !(
                x.protocol === "Uniswap v3 fees" &&
                lpKeys.has(`${x.chainId}:${/#(\d+)/.exec(x.what)?.[1]}`)
              ) &&
              !(
                x.protocol.startsWith("Vault ") &&
                vaultKeys.has(
                  `${x.chainId}:${String((x.claimTx as { to?: string } | undefined)?.to ?? "").toLowerCase()}`,
                )
              ),
          ),
        );
      archaeology = Object.fromEntries(arch.map((a, i) => [chainName(archChains[i]!), a.stats]));
      notChecked.push(
        ...archaeologyDropLines(arch.map((a, i) => [chainName(archChains[i]!), a.stats])),
      );
      sources.push(
        "contract archaeology: full explorer history → every contract called/token received, probed with balanceOf/earned/dividendsOf/claimable/pendingRewards, ERC-4626 & Yearn vault shares, Uniswap-v2 LP shares, Uniswap v3 positions + simulated collect() fees, EtherDelta/IDEX ERC-20 balances, NFTs still held",
      );
    } else if (coinOf(address)) {
      // one timed source per candidate coin (version bytes collide, e.g. DGB/DOGE, VIA/VTC)
      const u = utxoSources(f, address, env);
      notChecked.push(...u.notChecked);
      const rs = await Promise.all(
        u.sources.map((s) => timed(s.name, s.run(), [] as unknown[], s.ms)),
      );
      for (const r of rs) items.push(...(r as Found[]));
      sources.push(
        `public explorers (Blockbook/Insight/qtum.info/WhatsOnChain/cryptoid) for ${u.sources.map((s) => COINS[s.coin].sym).join(", ")}`,
      );
    } else if (isXrpAddress(address)) {
      const r = await timed("XRP Ledger", xrpScan(f, address), { items: [], notChecked: [] });
      items.push(...(r.items as Found[]));
      notChecked.push(...r.notChecked);
      sources.push(
        "XRP Ledger public nodes (xrplcluster.com, ripple.com): balance, reserve, AccountDelete eligibility",
      );
    } else if (isXlmAddress(address)) {
      const r = await timed("Stellar", xlmScan(f, address), { items: [], notChecked: [] });
      items.push(...(r.items as Found[]));
      notChecked.push(...r.notChecked);
      sources.push(
        "Stellar Horizon (horizon.stellar.org): XLM balance minus base reserve, other assets as leads",
      );
    } else if (recognisedOnly(address).length) {
      // every candidate is checked (never just the first), each as its own timed stage
      const cands = recognisedOnly(address);
      const SCAN: Record<
        string,
        { run: () => Promise<{ items: unknown[]; notChecked: string[] }>; src: string }
      > = {
        algo: {
          run: () => algoScan(f, address),
          src: "Algorand algod (algonode.cloud, nodely.dev): ALGO balance minus minimum balance",
        },
        atom: {
          run: () => atomScan(f, address),
          src: "Cosmos Hub LCD (publicnode, cosmos.directory, polkachu, keplr): liquid ATOM, staking rewards, staked, unbonding",
        },
        ton: {
          run: () => tonScan(f, address),
          src: "TON toncenter getAddressBalance (fallback tonapi.io): TON balance",
        },
        ada: {
          run: () => adaScan(f, address),
          src: "Cardano Koios (api.koios.rest) address_info + account_info: ADA balance, stake rewards, same-stake-key addresses, key deposit",
        },
        dot: {
          run: () => dotScan(f, address),
          src: "Polkadot Asset Hub + relay chain: Parity public sidecar balance-info, fallback public RPC System.Account (free/reserved/frozen)",
        },
      };
      const rs = await Promise.all(
        cands.map((k) =>
          SCAN[k]
            ? timed(RECOGNISED_ONLY[k]!, SCAN[k].run(), { items: [], notChecked: [] })
            : Promise.resolve({
                items: [],
                notChecked: [
                  k === "xmr"
                    ? `${RECOGNISED_ONLY[k]}: address recognised (blocktools), balance not checked: a Monero balance needs the private view key, which SwapChan never takes`
                    : `${RECOGNISED_ONLY[k]}: address recognised (blocktools), balance not checked (no source wired yet)`,
                ],
              }),
        ),
      );
      for (const r of rs) {
        items.push(...(r.items as Found[]));
        notChecked.push(...r.notChecked);
      }
      sources.push(
        ...cands.map((k) => SCAN[k]?.src ?? `blocktools detectAddress: ${RECOGNISED_ONLY[k]}`),
      );
    } else if (signumAddress(address)) {
      const r = await timed("Signum", signumScan(f, address), { items: [], notChecked: [] });
      items.push(...(r.items as Found[]));
      notChecked.push(...r.notChecked);
      sources.push("Signum public nodes (europe/brazil/us-east.signum.network)");
    } else if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) {
      // JustLend supply is covered (with a redeem tx) by tronExtras inside tronMoney
      items.push(...(await tronMoney(f, address, env)));
      sources.push("TronGrid (rewards, unfreezes, contract probes, JustLend supplied jTokens)");
    } else if (
      /^(xpub|ypub|zpub|xprv)/i.test(address) ||
      (/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(address) && !!decodeAny(address)) ||
      /^bc1p[02-9ac-hj-np-z]{58}$/.test(address) // taproot (bech32m): decodeAny only knows witness v0
    ) {
      const isXpub = /^(xpub|ypub|zpub|xprv)/i.test(address);
      const [bx, fork, cp] = await Promise.all([
        btcXpubScan(f, address).catch(() => []),
        isXpub
          ? {
              items: [] as unknown[],
              notChecked: [
                "fork coins and same-key old coins: checked for single addresses only, not xpubs",
              ],
            }
          : (() => {
              // every same-key coin is its own timed source, all in parallel with the BTC scan
              const u = utxoSources(f, address, env);
              return Promise.all(
                u.sources.map((s) => timed(s.name, s.run(), [] as unknown[], s.ms)),
              ).then((rs) => ({ items: rs.flat(), notChecked: u.notChecked }));
            })(),
        // Counterparty assets (XCP + tokens) via the xchain.io indexer — invisible to BTC explorers.
        isXpub
          ? Promise.resolve([] as Found[])
          : timed("Counterparty (xchain.io)", counterpartyScan(f, address), [] as Found[], 12_000),
      ]);
      items.push(...(bx as Found[]), ...(fork.items as Found[]), ...(cp as Found[]));
      notChecked.push(...fork.notChecked);
      sources.push("Bitcoin xpub/address UTXO scan (blockchain.info multiaddr + mempool.space)");
      sources.push(
        "same key on fork coins (BCH, BTG, BSV) and old Bitcoin-family coins (LTC, DOGE, DASH, DGB, RVN, ZEC, QTUM, MONA, PPC, RDD, VTC, VIA, TRC, XPM, AUR, ...) via public explorers, each its own timed source",
      );
      sources.push(
        "Counterparty indexer (xchain.io): XCP + token/asset balances on the Bitcoin address",
      );
    } else if (vm === "svm") {
      // Tron base58 also matches the Solana pattern, so Tron is tested first.
      // every Solana source in parallel, each under its own deadline (was serial: rent -> stake -> archaeology)
      const SOL_MS = Number(env.FIND_SOLANA_SOURCE_MS ?? 10_000);
      const sr = await Promise.all([
        timed("Solana rent", solanaRent(f, env, address), [] as Found[], SOL_MS),
        timed(
          "Solana stake accounts",
          solanaStake(f, env, address) as Promise<Found[]>,
          [] as Found[],
          SOL_MS,
        ),
        timed(
          "Solana program archaeology",
          solanaArchaeology(f, env, address) as Promise<Found[]>,
          [] as Found[],
          SOL_MS,
        ),
        timed("Marinade unstake tickets", marinadeTickets(f, env, address), [] as Found[], SOL_MS),
        timed("Kamino Lend", kaminoObligations(f, address), [] as Found[], SOL_MS),
      ]);
      items.push(...sr.flat());
      sources.push(
        "Solana RPC token accounts (rent reclaim), stake accounts (deactivated = withdrawable + withdraw ix), program archaeology (owned accounts + stake/vote programs), Marinade delayed-unstake tickets (claim ix), Kamino Lend main-market obligations (no tx yet). mSOL/JitoSOL show as balances (swap to exit).",
      );
    } else
      throw new BadRequest("airdrop_check supports EVM, Solana, Tron and Bitcoin (address/xpub)");
    items.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
    if (Object.keys(timings).length)
      console.log(JSON.stringify({ evt: "find_money_timings", ms: timings }));
    // owed-but-not-claimable-now items (e.g. a doubler queue position) are reported separately, never counted as found
    const later = items.filter((i) => isNotClaimableNow(i.what));
    for (const l of later) items.splice(items.indexOf(l), 1);
    const top = items[0];
    const nc = tidyNotChecked(notChecked);
    const incomplete = incompleteCount(nc);
    return {
      address,
      ...(name ? { name } : {}),
      // set when a source timed out or was dropped: cached only briefly (see PARTIAL_TTL_MS)
      partial: incomplete > 0,
      ...(incomplete ? { incompleteSources: incomplete } : {}),
      found: items.length,
      totalUsd: r2(items.reduce((s, i) => s + (i.valueUsd ?? 0), 0)),
      items,
      ...(later.length ? { owedNotClaimableNow: later.map(owedLater) } : {}),
      sources,
      ...(archaeology ? { archaeology } : {}),
      ...(nc.length ? { notChecked: nc } : {}),
      ...(Object.keys(timings).length ? { timingsMs: timings } : {}),
      coverage:
        "Covered: Merkl incentive rewards (EVM); legacy Ethereum contracts (PoWH3D, Fomo3D, EtherDelta ETH+ERC-20, IDEX v1, Liquity surplus); contract archaeology over the wallet's full history on Ethereum/Optimism/Scroll/Avalanche (all 8 EVM chains with ETHERSCAN_API_KEY): generic reward views, ERC-4626/Yearn vaults, v2 LPs, Uniswap v3 fees, NFTs held; Tron voting rewards/unfreezes/dividend contracts/JustLend; Solana rent in empty token accounts. NOT covered: one-off project airdrops (Jupiter, ENS, UNI, LayerZero, etc.) because no free unified source exists.",
      next: top?.link
        ? cta(`Claim ${top.protocol} and swap it on SwapChan`, top.link)
        : cta("Nothing unclaimed found. Swap at the best price on SwapChan", SITE),
    };
  });
}

// ---------- 7. market_context ----------
const TVL_CHAINS: Record<number, string> = {
  1: "Ethereum",
  8453: "Base",
  42161: "Arbitrum",
  10: "OP Mainnet",
  137: "Polygon",
  56: "BSC",
  43114: "Avalanche",
  59144: "Linea",
  534352: "Scroll",
  [SOLANA]: "Solana",
  [TRON]: "Tron",
  [BITCOIN]: "Bitcoin",
};
export async function marketContext(f: F) {
  return cached("market", 300_000, async () => {
    const errors: string[] = [];
    const safe = <T>(p: Promise<T>, n: string) =>
      p.catch((e) => {
        errors.push(`${n}: ${(e as Error).message}`);
        return null;
      });
    const [fng, hl, okx, st, tvl] = await Promise.all([
      safe(
        json<{ data: { value: string; value_classification: string; timestamp: string }[] }>(
          f,
          "https://api.alternative.me/fng/?limit=30",
        ),
        "fear&greed",
      ),
      safe(
        json<
          [
            { universe: { name: string }[] },
            { funding: string; openInterest: string; markPx: string }[],
          ]
        >(f, "https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "metaAndAssetCtxs" }),
        }),
        "hyperliquid",
      ),
      safe(
        Promise.all(
          ["BTC", "ETH", "SOL"].map((s) =>
            json<{ data: { fundingRate: string }[] }>(
              f,
              `https://www.okx.com/api/v5/public/funding-rate?instId=${s}-USDT-SWAP`,
            ).then((r) => [s, Number(r.data[0]?.fundingRate)] as const),
          ),
        ),
        "okx",
      ),
      safe(
        json<{
          peggedAssets: {
            symbol: string;
            circulating: { peggedUSD?: number };
            circulatingPrevDay: { peggedUSD?: number };
            circulatingPrevWeek: { peggedUSD?: number };
            chainCirculating: Record<
              string,
              {
                current: { peggedUSD?: number };
                circulatingPrevDay: { peggedUSD?: number };
                circulatingPrevWeek: { peggedUSD?: number };
              }
            >;
          }[];
        }>(f, "https://stablecoins.llama.fi/stablecoins?includePrices=false", undefined, 20_000),
        "stablecoins",
      ),
      safe(
        Promise.all(
          Object.entries(TVL_CHAINS).map(async ([id, n]) => {
            const h = await json<{ date: number; tvl: number }[]>(
              f,
              `https://api.llama.fi/v2/historicalChainTvl/${encodeURIComponent(n)}`,
              undefined,
              15_000,
            ).catch(() => []);
            const last = h.at(-1)?.tvl ?? null;
            const d1 = h.at(-2)?.tvl ?? null;
            const d7 = h.at(-8)?.tvl ?? null;
            return {
              chainId: Number(id),
              chain: n,
              tvlUsd: last,
              change1dPct: last && d1 ? r2((last / d1 - 1) * 100) : null,
              change7dPct: last && d7 ? r2((last / d7 - 1) * 100) : null,
            };
          }),
        ),
        "tvl",
      ),
    ]);
    const funding: Record<string, { hyperliquidHourlyPct?: number; okx8hPct?: number }> = {};
    if (hl)
      hl[0].universe.forEach((u, i) => {
        if (["BTC", "ETH", "SOL"].includes(u.name))
          funding[u.name] = { hyperliquidHourlyPct: Number(hl[1][i]!.funding) * 100 };
      });
    for (const [s, v] of okx ?? []) funding[s] = { ...funding[s], okx8hPct: v * 100 };
    let stable: unknown = null;
    if (st) {
      const sum = (k: "circulating" | "circulatingPrevDay" | "circulatingPrevWeek") =>
        st.peggedAssets.reduce((s, a) => s + (a[k]?.peggedUSD ?? 0), 0);
      const byChain = Object.values(TVL_CHAINS)
        .map((n) => {
          const keys = n === "OP Mainnet" ? ["OP Mainnet", "Optimism"] : [n];
          const g = (k: "current" | "circulatingPrevDay" | "circulatingPrevWeek") =>
            st.peggedAssets.reduce(
              (s, a) =>
                s + keys.reduce((t, kk) => t + (a.chainCirculating?.[kk]?.[k]?.peggedUSD ?? 0), 0),
              0,
            );
          return {
            chain: n,
            supplyUsd: r2(g("current")),
            flow1dUsd: r2(g("current") - g("circulatingPrevDay")),
            flow7dUsd: r2(g("current") - g("circulatingPrevWeek")),
          };
        })
        .sort((a, b) => b.flow7dUsd - a.flow7dUsd);
      stable = {
        totalUsd: r2(sum("circulating")),
        change1dUsd: r2(sum("circulating") - sum("circulatingPrevDay")),
        change7dUsd: r2(sum("circulating") - sum("circulatingPrevWeek")),
        byChain,
      };
    }
    const now = fng?.data[0];
    const tv = (tvl ?? [])
      .filter((x) => x.tvlUsd)
      .sort((a, b) => (b.change7dPct ?? -999) - (a.change7dPct ?? -999));
    const hot = tv[0];
    const v = Number(now?.value ?? 50);
    return {
      fearGreed: now
        ? {
            value: v,
            label: now.value_classification,
            history30d: fng!.data.map((d) => ({
              date: new Date(Number(d.timestamp) * 1000).toISOString().slice(0, 10),
              value: Number(d.value),
            })),
          }
        : null,
      funding,
      stablecoins: stable,
      chainTvl: tv,
      read: `${now ? `Sentiment: ${now.value_classification} (${v}/100).` : ""} ${funding.BTC?.okx8hPct !== undefined ? `BTC funding ${funding.BTC.okx8hPct.toFixed(4)}%/8h (${funding.BTC.okx8hPct > 0.02 ? "longs paying up, crowded" : funding.BTC.okx8hPct < 0 ? "shorts paying, fearful" : "neutral"}).` : ""} ${hot ? `Fastest-growing TVL this week: ${hot.chain} (${hot.change7dPct}%).` : ""}`.trim(),
      errors,
      sources: [
        "alternative.me Fear & Greed",
        "Hyperliquid funding",
        "OKX funding",
        "DefiLlama stablecoins",
        "DefiLlama chain TVL",
      ],
      disclaimer: "Market data, not financial advice.",
      next:
        v <= 25
          ? cta(
              "Extreme fear: buy ETH with USDC at the best price on SwapChan",
              swapUrl(1, usdcOf(1)!, 1, NATIVE_TOKEN),
            )
          : v >= 75
            ? cta(
                "Extreme greed: take profit to USDC on SwapChan",
                swapUrl(1, NATIVE_TOKEN, 1, usdcOf(1)!),
              )
            : hot && hot.chainId !== 1
              ? cta(
                  `Bridge to ${hot.chain}, where TVL is growing fastest`,
                  swapUrl(1, NATIVE_TOKEN, hot.chainId, nativeOf(hot.chainId)),
                )
              : cta("Swap at the best price on SwapChan", SITE),
    };
  });
}

// ---------- 8. rebalance_plan ----------
export const RebalanceBody = z.object({
  address: z.string(),
  targets: z
    .array(
      z.object({
        chainId: z.union([z.number(), z.string()]),
        token: z.string(),
        weight: z.number().positive(),
      }),
    )
    .min(1)
    .max(10),
  minTradeUsd: z.number().nonnegative().default(10),
});
export async function rebalancePlan(
  f: F,
  env: NodeJS.ProcessEnv,
  body: z.infer<typeof RebalanceBody>,
  quote: QuoteFn,
) {
  const { address } = await resolveAddr(f, env, body.address);
  const bal = (await walletBalances(f, env, address)) as {
    totalUsd: number;
    holdings: {
      chainId: number;
      address: string;
      symbol: string;
      balance: string;
      priceUsd: number | null;
      valueUsd: number | null;
    }[];
  };
  const wsum = body.targets.reduce((s, t) => s + t.weight, 0);
  const tgt = body.targets.map((t) => {
    const chainId = chainOf(t.chainId);
    const tk =
      /^(0x|[1-9A-HJ-NP-Za-km-z]{32,})/.test(t.token) && t.token.length > 20
        ? t.token
        : t.token.toUpperCase() === NATIVE_SYMBOL[chainId]
          ? nativeOf(chainId)
          : listed(chainId).find((x) => x.symbol.toUpperCase() === t.token.toUpperCase())?.address;
    if (!tk) throw new BadRequest(`unknown token ${t.token} on ${chainName(chainId)}`);
    return {
      chainId,
      address: tk,
      symbol:
        listed(chainId).find((x) => x.address.toLowerCase() === tk.toLowerCase())?.symbol ??
        (isNative(chainId, tk) ? NATIVE_SYMBOL[chainId]! : t.token),
      weight: t.weight / wsum,
    };
  });
  const k = (c: number, a: string) => `${c}:${a.toLowerCase()}`;
  const total = bal.totalUsd;
  const cur = new Map(
    bal.holdings.filter((h) => h.valueUsd).map((h) => [k(h.chainId, h.address), h]),
  );
  const diffs = new Map<
    string,
    { chainId: number; address: string; symbol: string; usd: number; priceUsd: number | null }
  >();
  for (const h of cur.values())
    diffs.set(k(h.chainId, h.address), {
      chainId: h.chainId,
      address: h.address,
      symbol: h.symbol,
      usd: -(h.valueUsd ?? 0),
      priceUsd: h.priceUsd,
    });
  for (const t of tgt) {
    const key = k(t.chainId, t.address);
    const d = diffs.get(key) ?? {
      chainId: t.chainId,
      address: t.address,
      symbol: t.symbol,
      usd: 0,
      priceUsd: null,
    };
    d.usd += t.weight * total;
    diffs.set(key, d);
  }
  const sells = [...diffs.values()]
    .filter((d) => d.usd < -body.minTradeUsd && d.priceUsd)
    .map((d) => ({ ...d, usd: -d.usd }))
    .sort((a, b) => b.usd - a.usd);
  const buys = [...diffs.values()]
    .filter((d) => d.usd > body.minTradeUsd)
    .sort((a, b) => b.usd - a.usd);
  const legs: { from: (typeof sells)[0]; to: (typeof buys)[0]; usd: number }[] = [];
  for (const b of buys) {
    let need = b.usd;
    for (const s of [...sells].sort(
      (x, y) => Number(y.chainId === b.chainId) - Number(x.chainId === b.chainId),
    )) {
      if (need < body.minTradeUsd) break;
      if (s.usd < body.minTradeUsd) continue;
      const amt = Math.min(need, s.usd);
      legs.push({ from: s, to: b, usd: amt });
      s.usd -= amt;
      need -= amt;
    }
  }
  const decOf = async (chainId: number, a: string) =>
    isNative(chainId, a)
      ? chainId === SOLANA
        ? 9
        : chainId === TRON
          ? 6
          : 18
      : (listed(chainId).find((x) => x.address.toLowerCase() === a.toLowerCase())?.decimals ??
        (vmOf(chainId) === "evm"
          ? Number(
              await evmClient(chainId, env).readContract({
                address: getAddress(a),
                abi: erc20Abi,
                functionName: "decimals",
              }),
            )
          : 6));
  const plan = await Promise.all(
    legs.slice(0, 8).map(async (l) => {
      const qty = l.usd / l.from.priceUsd!;
      const dec = await decOf(l.from.chainId, l.from.address);
      const amount =
        BigInt(Math.floor(qty * 10 ** Math.min(dec, 15))) * 10n ** BigInt(Math.max(0, dec - 15));
      const q = await quote({
        fromChainId: l.from.chainId,
        fromToken: l.from.address,
        toChainId: l.to.chainId,
        toToken: l.to.address,
        amount: amount.toString(),
      }).catch(() => null);
      const toDec = await decOf(l.to.chainId, l.to.address).catch(() => 18);
      return {
        sell: {
          chain: chainName(l.from.chainId),
          symbol: l.from.symbol,
          amount: qty,
          usd: r2(l.usd),
        },
        buy: {
          chain: chainName(l.to.chainId),
          symbol: l.to.symbol,
          expectedAmount: q ? Number(formatUnits(BigInt(q.toAmount), toDec)) : null,
        },
        quote: q ? { quoteId: q.id, provider: q.provider, netUsd: q.netUsd ?? null } : null,
        swapUrl: swapUrl(l.from.chainId, l.from.address, l.to.chainId, l.to.address, String(qty)),
      };
    }),
  );
  return {
    address,
    totalUsd: total,
    current: [...cur.values()].map((h) => ({
      chain: chainName(h.chainId),
      symbol: h.symbol,
      usd: h.valueUsd,
      weightPct: r2(((h.valueUsd ?? 0) / (total || 1)) * 100),
    })),
    target: tgt.map((t) => ({
      chain: chainName(t.chainId),
      symbol: t.symbol,
      weightPct: r2(t.weight * 100),
    })),
    swaps: plan,
    note: "Each leg has a live SwapChan quote (quoteId → build_swap_tx). Unpriced/unlisted holdings are left alone. EVM balances only cover SwapChan-listed tokens.",
    next: plan[0]
      ? cta(
          `Execute ${plan.length} rebalance swap(s) on SwapChan, starting with ${plan[0].sell.symbol} → ${plan[0].buy.symbol}`,
          plan[0].swapUrl,
        )
      : cta("Already on target. Nothing to swap", SITE),
  };
}

// ---------- 9. bridge_doctor ----------
type Norm = "done" | "pending" | "failed" | "refunded" | "not_found";
const THOR_NODES = [
  "https://gateway.liquify.com/chain/thorchain_api",
  "https://thornode.ninerealms.com",
  "https://thornode.thorchain.network",
];
type ThorStatus = {
  tx?: { memo?: string };
  stages?: {
    inbound_observed?: { completed: boolean };
    swap_status?: { pending: boolean };
    outbound_signed?: { completed: boolean };
    swap_finalised?: { completed: boolean };
  };
  out_txs?: { id: string }[];
};
async function thorStatus(f: F, h: string): Promise<ThorStatus | null> {
  const id = h.replace(/^0x/, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(id)) return null;
  for (const n of THOR_NODES) {
    try {
      return await json<ThorStatus>(f, `${n}/thorchain/tx/status/${id}`);
    } catch {}
  }
  return null;
}
export async function bridgeDoctor(f: F, env: NodeJS.ProcessEnv, hash: string, fromChain?: string) {
  const h = hash.trim();
  return cached(`bridge:${h}`, 20_000, async () => {
    const probes: { provider: string; status: Norm; detail: Record<string, unknown> }[] = [];
    let origin: { chainId: number; status: string } | null = null;
    let originChecked = 0;
    const add = (provider: string, status: Norm, detail: Record<string, unknown>) =>
      probes.push({ provider, status, detail });
    const evmHash = /^0x[0-9a-fA-F]{64}$/.test(h);
    await Promise.all([
      json<{
        status?: string;
        substatus?: string;
        substatusMessage?: string;
        sending?: { chainId: number; amount: string; txHash?: string; token?: { symbol: string } };
        receiving?: {
          chainId: number;
          txHash?: string;
          amount?: string;
          token?: { symbol: string; address: string };
        };
        tool?: string;
        message?: string;
      }>(f, `https://li.quest/v1/status?txHash=${h}`)
        .then((r) => {
          if (!r.status || r.status === "NOT_FOUND") return;
          // LI.FI also matches on its own transactionId; only accept a record whose origin/dest tx IS this hash.
          const hit = [r.sending?.txHash, r.receiving?.txHash].some(
            (x) => x && x.toLowerCase() === h.toLowerCase(),
          );
          if (!hit) return;
          add(
            `LI.FI${r.tool ? ` (${r.tool})` : ""}`,
            r.status === "DONE"
              ? r.substatus === "REFUNDED"
                ? "refunded"
                : "done"
              : r.status === "FAILED"
                ? "failed"
                : "pending",
            {
              substatus: r.substatus,
              message: r.substatusMessage,
              from: r.sending?.chainId,
              to: r.receiving?.chainId,
              destTx: r.receiving?.txHash,
              received:
                r.receiving?.amount && r.receiving.token
                  ? `${r.receiving.amount} ${r.receiving.token.symbol}`
                  : undefined,
            },
          );
        })
        .catch(() => {}),
      evmHash && fromChain
        ? json<{ status?: string; fillTx?: string; destinationChainId?: number }>(
            f,
            `https://app.across.to/api/deposit/status?originChainId=${chainOf(fromChain)}&depositTxHash=${h}`,
          )
            .then((r) => {
              if (
                !r.status ||
                !/^(filled|pending|refunded|expired|slowFillRequested)$/.test(r.status)
              )
                return;
              add(
                "Across",
                r.status === "filled"
                  ? "done"
                  : r.status === "refunded"
                    ? "refunded"
                    : r.status === "expired"
                      ? "failed"
                      : "pending",
                { status: r.status, fillTx: r.fillTx, to: r.destinationChainId },
              );
            })
            .catch(() => {})
        : Promise.resolve(),
      json<{
        requests?: {
          status: string;
          data?: {
            inTxs?: { hash?: string; txHash?: string; chainId: number }[];
            outTxs?: { hash?: string; txHash?: string; chainId: number }[];
            failReason?: string;
          };
        }[];
      }>(
        f,
        `https://api.relay.link/requests/v3?term=${h}`,
        env.RELAY_API_KEY ? { headers: { "x-api-key": env.RELAY_API_KEY } } : undefined,
      )
        .catch(() => ({ requests: [] }) as { requests?: never[] })
        .then(async (r) =>
          // v3 only shows our integrator's + keyless requests; v2 (sunset 2026-11-24) still sees all.
          r.requests?.length
            ? r
            : await json<typeof r>(f, `https://api.relay.link/requests/v2?hash=${h}`).catch(
                () => r,
              ),
        )
        .then((r) => {
          const q = r.requests?.find((x) =>
            [...(x.data?.inTxs ?? []), ...(x.data?.outTxs ?? [])].some(
              (t) => (t.txHash ?? t.hash)?.toLowerCase() === h.toLowerCase(),
            ),
          );
          if (!q) return;
          add(
            "Relay",
            q.status === "success"
              ? "done"
              : q.status === "refund"
                ? "refunded"
                : q.status === "failure"
                  ? "failed"
                  : "pending",
            {
              status: q.status,
              originChainId: q.data?.inTxs?.find(
                (t) => (t.txHash ?? t.hash)?.toLowerCase() === h.toLowerCase(),
              )?.chainId,
              destTx: q.data?.outTxs?.[0]?.txHash ?? q.data?.outTxs?.[0]?.hash,
              failReason: q.data?.failReason,
            },
          );
        })
        .catch(() => {}),
      json<{ orderIds?: { stringValue: string }[] }>(
        f,
        `https://stats-api.dln.trade/api/Transaction/${h}/orderIds`,
      )
        .then(async (r) => {
          const id = r.orderIds?.[0]?.stringValue;
          if (!id) return;
          const o = await json<{
            state?: string;
            fulfilledDstEventMetadata?: { transactionHash?: { stringValue: string } };
          }>(f, `https://stats-api.dln.trade/api/Orders/${id}`);
          const s = o.state ?? "";
          add(
            "deBridge DLN",
            /Fulfilled|SentUnlock|ClaimedUnlock/.test(s)
              ? "done"
              : /Cancel/.test(s)
                ? "refunded"
                : "pending",
            {
              orderId: id,
              state: s,
              destTx: o.fulfilledDstEventMetadata?.transactionHash?.stringValue,
            },
          );
        })
        .catch(() => {}),
      thorStatus(f, h)
        .then((r) => {
          if (!r?.stages?.inbound_observed?.completed) return;
          const refund = /^REFUND/i.test(r.tx?.memo ?? "");
          add(
            "THORChain",
            r.stages.outbound_signed?.completed ||
              // No outbound stage (e.g. swap to native RUNE / THOR-side): finalised swap = delivered.
              (!r.stages.outbound_signed && r.stages.swap_finalised?.completed)
              ? refund
                ? "refunded"
                : "done"
              : "pending",
            { stages: r.stages, outTxs: r.out_txs?.map((x) => x.id) },
          );
        })
        .catch(() => {}),
      (async () => {
        if (!evmHash) return;
        // Verify the tx exists on a source chain before trusting any provider.
        const ids = fromChain ? [chainOf(fromChain)] : EVM_IDS;
        const found = await Promise.all(
          ids.map((id) =>
            Promise.race([
              evmClient(id, env)
                .getTransactionReceipt({ hash: h as `0x${string}` })
                .then((rc) => ({ chainId: id, status: rc.status as string }))
                .catch(() => null),
              new Promise<null>((res) => setTimeout(() => res(null), 6000)),
            ]),
          ),
        );
        origin =
          found.find((x) => x) ??
          (fromChain ? { chainId: ids[0] as number, status: "not found on this chain" } : null);
        originChecked = ids.length;
      })(),
    ]);
    // EVM hash: if no source chain has this tx, nothing is confirmed — whatever providers say.
    const o = origin as { chainId: number; status: string } | null;
    const originMissing = evmHash && (!o || o.status === "not found on this chain");
    // Exception: an exact-hash provider record whose origin is a chain we have no RPC for (e.g. Relay's
    // own chains) can't be checked here — keep it, but flag originVerified=false.
    const unverifiable = (p: (typeof probes)[number]) => {
      const oc = Number(p.detail.originChainId);
      return Number.isFinite(oc) && oc > 0 && !EVM_IDS.includes(oc);
    };
    let originUncheckable = false;
    if (originMissing && originChecked > 0) {
      const keep = fromChain ? [] : probes.filter(unverifiable);
      probes.length = 0;
      probes.push(...keep);
      originUncheckable = keep.length > 0;
    }
    const best =
      probes.find((p) => p.status === "done") ??
      probes.find((p) => p.status === "refunded") ??
      probes.find((p) => p.status === "failed") ??
      probes[0];
    const advice: Record<Norm, string> = {
      done: "Delivered. Check the destination tx; if the wallet doesn't show it, add the token manually.",
      pending:
        "In flight. Most routes finish in 1–20 min; if it's over an hour, contact the provider with this hash (filling relayers can be slow when liquidity is thin).",
      failed:
        "Failed. Funds usually auto-refund on the origin chain; if not refunded within an hour, open a ticket with the provider and include this hash.",
      refunded:
        "Refunded to the sender on the origin chain (sometimes as a different token, e.g. WETH). Retry with a fresh SwapChan quote.",
      not_found:
        "No confirmed record for this exact tx. If it's an EVM hash we couldn't find it on any supported chain, so nothing is confirmed. No bridge provider recognizes this hash yet. If the origin tx just confirmed, wait 1–2 minutes; check the hash and origin chain; if the origin tx reverted, nothing left your wallet.",
    };
    const st: Norm = best?.status ?? "not_found";
    return {
      hash: h,
      origin: o,
      originVerified: evmHash ? !originMissing : null,
      ...(originUncheckable
        ? {
            originNote: `Origin chain ${probes[0]?.detail.originChainId} has no SwapChan RPC, so the tx couldn't be independently verified; status is the provider's record for this exact hash.`,
          }
        : {}),
      status: st,
      provider: best?.provider ?? null,
      probes,
      advice:
        o?.status === "reverted"
          ? "Origin tx reverted: nothing was bridged and only gas was spent. Retry with a fresh quote."
          : advice[st],
      checked: [
        "LI.FI (covers its bridges)",
        ...(fromChain ? ["Across"] : ["Across (needs fromChain)"]),
        "Relay",
        "deBridge DLN",
        "THORChain",
      ],
      next:
        st === "done"
          ? cta("Arrived. Swap it into something else on SwapChan", SITE)
          : st === "pending"
            ? cta("Still pending. Track it on SwapChan", `${SITE}/status`)
            : cta("Retry with the best route on SwapChan", SITE),
    };
  });
}

// ---------- 10. gas history / best time ----------
export function initGasDb(db: DatabaseSync) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS gas_samples (chain_id INTEGER, at INTEGER, gwei REAL, PRIMARY KEY (chain_id, at))",
  );
}
export async function sampleGas(env: NodeJS.ProcessEnv, db: DatabaseSync) {
  const at = Math.floor(Date.now() / 60_000);
  await Promise.all(
    EVM_IDS.map(async (id) => {
      const g = await evmClient(id, env)
        .getGasPrice()
        .catch(() => null);
      if (g !== null)
        db.prepare("INSERT OR IGNORE INTO gas_samples VALUES (?,?,?)").run(id, at, Number(g) / 1e9);
    }),
  );
  db.prepare("DELETE FROM gas_samples WHERE at < ?").run(at - 60 * 24 * 30);
}
export async function gasHistory(
  f: F,
  env: NodeJS.ProcessEnv,
  db: DatabaseSync | null,
  chainIdIn: string | number = 1,
) {
  const chainId = chainOf(chainIdIn);
  if (vmOf(chainId) !== "evm")
    throw new BadRequest("gas history covers EVM chains (use get_gas for Solana/Bitcoin/Tron)");
  return cached(`gash:${chainId}`, 60_000, async () => {
    const fh = await evmClient(chainId, env).getFeeHistory({
      blockCount: 1024,
      rewardPercentiles: [50],
      blockTag: "latest",
    });
    const base = fh.baseFeePerGas.map((x) => Number(x) / 1e9);
    const tips = (fh.reward ?? []).map((r) => Number(r[0] ?? 0n) / 1e9);
    const tip = [...tips].sort((a, b) => a - b)[Math.floor(tips.length / 2)] ?? 0;
    const s = [...base].sort((a, b) => a - b);
    const pct = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
    const now = base.at(-1) ?? 0;
    const rank = s.findIndex((x) => x >= now) / s.length;
    const signal = rank <= 0.25 ? "cheap" : rank >= 0.75 ? "expensive" : "normal";
    let byHour: { hourUtc: number; avgGwei: number; samples: number }[] = [];
    let days = 0;
    if (db) {
      byHour = (
        db
          .prepare(
            "SELECT ((at/60)%24) AS hourUtc, AVG(gwei) AS avgGwei, COUNT(*) AS samples FROM gas_samples WHERE chain_id=? GROUP BY hourUtc ORDER BY hourUtc",
          )
          .all(chainId) as { hourUtc: number; avgGwei: number; samples: number }[]
      ).map((r) => ({ ...r, avgGwei: Number(r.avgGwei.toPrecision(4)) }));
      const span = db
        .prepare("SELECT MIN(at) AS a, MAX(at) AS b FROM gas_samples WHERE chain_id=?")
        .get(chainId) as { a: number | null; b: number | null };
      days = span.a && span.b ? r2((span.b - span.a) / 1440) : 0;
    }
    const cheapestHour =
      byHour.length >= 12 ? [...byHour].sort((a, b) => a.avgGwei - b.avgGwei)[0] : null;
    const g = (await gas(f, env, [chainId])) as { chains: { swapCostUsd?: number | null }[] };
    return {
      chainId,
      chain: chainName(chainId),
      nowBaseFeeGwei: Number(now.toPrecision(4)),
      medianTipGwei: Number(tip.toPrecision(4)),
      window: {
        blocks: base.length,
        p10: Number(pct(0.1).toPrecision(4)),
        median: Number(pct(0.5).toPrecision(4)),
        p90: Number(pct(0.9).toPrecision(4)),
      },
      series: base.filter((_, i) => i % 16 === 0).map((x) => Number(x.toPrecision(4))),
      signal,
      swapCostUsdNow: g.chains[0]?.swapCostUsd ?? null,
      bestHourUtc: cheapestHour ? cheapestHour.hourUtc : null,
      byHourUtc: byHour,
      historyDays: days,
      recommendation:
        signal === "cheap"
          ? "Gas is in the cheapest quarter of the last ~1024 blocks. Swap now."
          : signal === "expensive"
            ? `Gas is in the top quarter of recent blocks.${cheapestHour ? ` Historically cheapest around ${cheapestHour.hourUtc}:00 UTC.` : ""} Wait, or use an L2.`
            : "Gas is normal for recent blocks.",
      sources: [
        "eth_feeHistory (1024 blocks, public RPC)",
        "SwapChan gas sampler (every 10 min since deploy)",
      ],
      next:
        signal === "expensive" && chainId === 1
          ? cta(
              "Mainnet gas is high: bridge to Base and swap there for cents",
              swapUrl(1, NATIVE_TOKEN, 8453, NATIVE_TOKEN),
            )
          : cta(
              `Gas is ${signal} on ${chainName(chainId)}: swap now on SwapChan`,
              swapUrl(chainId, NATIVE_TOKEN, chainId, usdcOf(chainId) ?? NATIVE_TOKEN),
            ),
    };
  });
}

// ---------- links: deep-link builder + permanent shortener ----------
const B62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** Unguessable short id: 12 base62 chars from crypto.getRandomValues (rejection-sampled, ~71 bits). */
export const SHORT_ID_LEN = 12;
export function randomShortId(len = SHORT_ID_LEN) {
  let s = "";
  while (s.length < len) {
    const buf = new Uint8Array(len * 2);
    globalThis.crypto.getRandomValues(buf);
    for (const b of buf) if (b < 248 && s.length < len) s += B62[b % 62];
  }
  return s;
}
/** Ids issued before 2026-10-24 were sequential (b62(n+3843), <=4 chars) and can be walked. */
export const isLegacyShortId = (id: string) => id.length < 10;
const WALLET_PATHS = /^\/(recover|money|dashboard|wallet|portfolio)(\/|$)/i;
const WALLET_KEYS = /^(owner|recipient|to|address|wallet|account|holder|receiver|data)$/i;
/** Does this stored URL carry a wallet address or recovery calldata? */
export function linkHoldsWalletData(url: string) {
  try {
    const u = new URL(url);
    if (WALLET_PATHS.test(u.pathname)) return true;
    for (const k of u.searchParams.keys()) if (WALLET_KEYS.test(k)) return true;
    return false;
  } catch {
    return true;
  }
}
export function initLinksDb(db: DatabaseSync) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS links (n INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, url TEXT UNIQUE NOT NULL, created INTEGER NOT NULL, clicks INTEGER NOT NULL DEFAULT 0);`,
  );
  migrateLinksRetention(db);
}
const ALLOWED_HOSTS = new Set(["swapchan.com", "www.swapchan.com"]);
export function shorten(db: DatabaseSync, url: string) {
  const u = new URL(url, SITE);
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname))
    throw new BadRequest("only https://swapchan.com destinations can be shortened");
  const canon = u.toString();
  const hit = db.prepare("SELECT id FROM links WHERE url = ?").get(canon) as
    | { id: string }
    | undefined;
  if (hit && !(isLegacyShortId(hit.id) && linkHoldsWalletData(canon))) {
    db.prepare("UPDATE links SET last_click = ? WHERE id = ?").run(Date.now(), hit.id);
    return { id: hit.id, shortUrl: `${SITE}/s/${hit.id}`, url: canon };
  }
  // New ids are random, never sequential. A legacy sequential id holding wallet data is
  // retired (it stops resolving) and its row gets a fresh random id instead.
  for (let i = 0; i < 8; i++) {
    const id = randomShortId();
    if (db.prepare("SELECT 1 FROM links_retired WHERE id = ?").get(id)) continue;
    try {
      if (hit) db.prepare("UPDATE links SET id = ? WHERE url = ?").run(id, canon);
      else
        db.prepare("INSERT INTO links (id, url, created) VALUES (?, ?, ?)").run(
          id,
          canon,
          Date.now(),
        );
      return { id, shortUrl: `${SITE}/s/${id}`, url: canon };
    } catch (e) {
      if (
        !/UNIQUE/i.test(String((e as Error).message)) ||
        /links\.url/.test(String((e as Error).message))
      )
        throw e;
    }
  }
  throw new Error("could not allocate a short id");
}
export function resolveShort(db: DatabaseSync, id: string, count = true) {
  const r = db.prepare("SELECT url, clicks, created FROM links WHERE id = ?").get(id) as
    | { url: string; clicks: number; created: number }
    | undefined;
  if (!r) return null;
  // Sequential legacy ids that carry a wallet address or recovery calldata are expired.
  if (isLegacyShortId(id) && linkHoldsWalletData(r.url)) return null;
  if (count)
    db.prepare("UPDATE links SET clicks = clicks + 1, last_click = ? WHERE id = ?").run(
      Date.now(),
      id,
    );
  return {
    id,
    url: r.url,
    clicks: r.clicks + (count ? 1 : 0),
    created: new Date(r.created).toISOString(),
  };
}
const tokenFor = (chainId: number, t: string) => {
  if (!t) return undefined;
  if (
    /^(native|eth|sol|bnb|pol|avax|trx|btc)$/i.test(t) &&
    t.toUpperCase() === (NATIVE_SYMBOL[chainId] ?? "").toUpperCase()
  )
    return nativeOf(chainId);
  if (t.toLowerCase() === "native") return nativeOf(chainId);
  if (t.length >= 26) return t;
  const hit = listed(chainId).find((x) => x.symbol.toUpperCase() === t.toUpperCase());
  if (!hit)
    throw new BadRequest(`unknown token symbol ${t} on ${chainName(chainId)}; pass an address`);
  return hit.address;
};
export const LinkParams = z.object({
  fromChain: z.union([z.string(), z.number()]),
  fromToken: z.string(),
  toChain: z.union([z.string(), z.number()]).optional(),
  toToken: z.string(),
  amount: z.string().optional(),
  owner: z.string().optional(),
  recipient: z.string().optional(),
  ref: z.string().max(64).optional(),
});
export async function buildSwapLink(
  f: F,
  env: NodeJS.ProcessEnv,
  db: DatabaseSync | null,
  p: z.infer<typeof LinkParams>,
) {
  const fc = chainOf(p.fromChain);
  const tc = p.toChain === undefined ? fc : chainOf(p.toChain);
  const ft = tokenFor(fc, p.fromToken)!;
  const tt = tokenFor(tc, p.toToken)!;
  let amount = p.amount;
  if (amount?.toLowerCase() === "max") {
    if (!p.owner) throw new BadRequest("amount=max needs owner (the wallet address)");
    const b = (await walletBalances(f, env, p.owner, [fc])) as {
      holdings: { address: string; balance: string }[];
    };
    const h = b.holdings.find((x) => x.address.toLowerCase() === ft.toLowerCase());
    if (!h) throw new BadRequest("owner holds none of fromToken");
    amount = isNative(fc, ft) ? String(Math.max(0, Number(h.balance) * 0.98)) : h.balance;
  }
  if (amount !== undefined && !/^\d+(\.\d+)?$/.test(amount))
    throw new BadRequest("amount must be a decimal number or 'max'");
  const q = new URLSearchParams({
    fromChain: String(fc),
    toChain: String(tc),
    fromToken: ft,
    toToken: tt,
    ...(amount ? { amount } : {}),
    ...(p.recipient ? { recipient: p.recipient } : {}),
    ...(p.ref ? { ref: p.ref } : {}),
  });
  const url = `${SITE}/?${q}`;
  const short = db ? shorten(db, url) : null;
  return {
    url,
    shortUrl: short?.shortUrl ?? null,
    fromChainId: fc,
    toChainId: tc,
    fromToken: ft,
    toToken: tt,
    amount: amount ?? null,
    scheme: `${SITE}/swap?fromChain=<id|name>&fromToken=<address|symbol>&toChain=<id|name>&toToken=<address|symbol>&amount=<decimal>&recipient=<addr>&ref=<partnerId>`,
  };
}
export async function batchLink(
  f: F,
  env: NodeJS.ProcessEnv,
  db: DatabaseSync,
  items: z.infer<typeof LinkParams>[],
  ref?: string,
) {
  const built = await Promise.all(
    items.slice(0, 20).map((i) => buildSwapLink(f, env, null, { ...i, ...(ref ? { ref } : {}) })),
  );
  const enc = Buffer.from(
    JSON.stringify(
      built.map((b) => [b.fromChainId, b.fromToken, b.toChainId, b.toToken, b.amount ?? ""]),
    ),
  ).toString("base64url");
  const url = `${SITE}/batch?items=${enc}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`;
  const s = shorten(db, url);
  return { url, shortUrl: s.shortUrl, steps: built.map((b, i) => ({ step: i + 1, url: b.url })) };
}

// ---------- find_money ----------
/** Coin balances (fork chains, extra EVM chains, old UTXO coins) under this are not worth a transfer. */
export const DUST_USD = 0.5;
export const DUST_CATEGORY = "Dust (not worth moving)";
type DustLike = { title: string; estUsd: number | null; estimateKind: string; sweep?: unknown };
export const isSweepDust = (i: DustLike) =>
  !!i.sweep &&
  i.estUsd !== null &&
  i.estUsd < DUST_USD &&
  (i.estimateKind === "exact" || i.estimateKind === "estimate");
export function dustNote(dust: DustLike[]) {
  const amt = (t: string) => {
    const m = /^(.*?)(?: \(fork coins\)| wallet)?: (\S+ \S+) at your address/.exec(t);
    return m ? `${m[2]} (${m[1]})` : t.slice(0, 80);
  };
  const sum = Math.round(dust.reduce((s, d) => s + (d.estUsd ?? 0), 0) * 100) / 100;
  return {
    category: DUST_CATEGORY,
    title: `Dust, not worth moving: ${dust.map((d) => amt(d.title)).join(", ")}`,
    estUsd: sum,
    estimateKind: "estimate" as const,
    detail: `Each is worth under $${DUST_USD.toFixed(2)}.`,
    action: "",
    swapUrl: SITE,
  };
}

/**
 * Counterparty assets (XCP + tokens) on a Bitcoin address. Counterparty is a metadata protocol on
 * Bitcoin: assets live inside BTC txs and are tracked by the Counterparty indexer (xchain.io),
 * invisible to the Bitcoin explorers that report the BTC balance. A single address can hold valuable
 * XCP or rare tokens (e.g. Rare Pepes). This is the data source find_money was missing for Counterparty.
 */
async function counterpartyScan(f: F, address: string): Promise<Found[]> {
  if (!/^(1|3|bc1q)/.test(address)) return []; // taproot (bc1p) isn't used by Counterparty
  const r = await json<{
    data?: {
      asset: string;
      asset_longname?: string | null;
      quantity?: number;
      quantity_normalized?: string;
      estimated_value?: { usd?: string | number | null };
    }[];
  }>(f, `https://tokenscan.io/api/balances/${address}`, undefined, 12_000).catch(() => null);
  const out: Found[] = [];
  for (const b of r?.data ?? []) {
    const qty = b.quantity_normalized ?? (b.quantity != null ? String(b.quantity) : "");
    if (!qty || Number(qty) <= 0) continue;
    const name = b.asset_longname || b.asset;
    const usd = Number(b.estimated_value?.usd ?? 0) || null;
    out.push({
      kind: "balance",
      protocol: "Counterparty",
      chainId: 8253038, // Bitcoin (Counterparty rides on it)
      what: `${qty} ${name} — Counterparty asset on ${short(address)}; not shown by Bitcoin explorers`,
      valueUsd: usd,
      action:
        "Access with a Counterparty wallet (FreeWallet / Counterwallet). XCP and rare tokens can be valuable.",
      link: `https://tokenscan.io/address/${address}`,
      confidence: "high",
    });
  }
  return out;
}

export async function findMoney(
  f: F,
  env: NodeJS.ProcessEnv,
  db: DatabaseSync | null,
  input: string,
  opts: { fresh?: boolean; client?: string; gate?: ReturnType<typeof gate> } = {},
) {
  const { address, name } = await resolveAddr(f, env, input);
  // known burn/dead address: nothing there is recoverable, so skip the scan
  if (isBurnAddress(address)) return burnAddressResult(address, name);
  const STAGE_HARD_MS = Number(env.FIND_STAGE_TIMEOUT_MS ?? 17_000) + 6_000;
  const ethBlock = vmOfAddr(address) === "evm" ? () => evmClient(1, env).getBlockNumber() : null;
  // same shape as cached(): adds fresh=1, asOf/block/cached and the refresh limits
  const cachedScan = <T extends object>(key: string, ttlMs: number, scan: () => Promise<T>) =>
    moneyWithFreshness(key, ttlMs, address, !!opts.fresh, ethBlock, scan, opts.client ?? "local");
  return cachedScan(`money:${address}`, 180_000, () =>
    (opts.gate ?? scanGate).run(() =>
      withScanScope(STAGE_HARD_MS, async () => {
        const t0scan = Date.now();
        const vm = vmOfAddr(address);
        const isTron = /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
        type Item = {
          rank?: number;
          category: string;
          title: string;
          estUsd: number | null;
          estimateKind: "exact" | "estimate" | "protected" | "lead";
          detail: string;
          action: string;
          swapUrl: string;
          protocolUrl?: string;
          steps?: unknown[];
          recoverUrl?: string;
          shortUrl?: string | null;
          claimTx?: unknown;
          revokeTx?: unknown;
        };
        const items: Item[] = [];
        const errors: string[] = [];
        const notChecked: string[] = [];
        const fmMs: Record<string, number> = {};
        const STAGE_MS = Number(env.FIND_STAGE_TIMEOUT_MS ?? 17_000);
        const run = async <T>(n: string, p: () => Promise<T>) => {
          const t0 = Date.now();
          let to: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              p(),
              new Promise<never>((_, rej) => {
                to = setTimeout(
                  () => rej(new Error(`timed out after ${STAGE_MS / 1000}s`)),
                  STAGE_MS,
                );
              }),
            ]);
          } catch (e) {
            recordStageFailure(n, e, notChecked, errors);
            return null;
          } finally {
            clearTimeout(to);
            fmMs[n] = Date.now() - t0;
          }
        };
        const ledgerOnly =
          isXrpAddress(address) ||
          isXlmAddress(address) ||
          !!signumAddress(address) ||
          recognisedOnly(address).length > 0;
        const balP = ledgerOnly
          ? Promise.resolve(null)
          : run("balances", () => walletBalances(f, env, address));
        // tail work gets its own deadline too, so the total is the slowest stage, not stage + tail
        const cap = makeCap(notChecked, fmMs);
        const riskOf = (
          H: {
            chainId: number;
            address: string;
            symbol: string;
            balance: string;
            valueUsd: number | null;
          }[],
        ) =>
          Promise.all(
            H.filter(
              (h) =>
                (h.valueUsd ?? 0) >= 5 &&
                !isNative(h.chainId, h.address) &&
                !STABLES.has(h.symbol.toUpperCase()),
            )
              .slice(0, 8)
              .map(async (h) => {
                const sc = Object.entries({
                  solana: SOLANA,
                  base: 8453,
                  bnb: 56,
                  eth: 1,
                  arbitrum: 42161,
                  polygon: 137,
                  optimism: 10,
                  avalanche: 43114,
                }).find(([, v]) => v === h.chainId)?.[0] as
                  | Parameters<typeof tokenRisk>[2]
                  | undefined;
                if (!sc) return null;
                const r = await tokenRisk(f, env, sc, h.address).catch(() => null);
                return r && (r as { level: string }).level === "high"
                  ? { h, flags: (r as { flags: string[] }).flags }
                  : null;
              }),
          );
        // starts as soon as balances land, concurrent with the other stages
        const riskP = (
          balP as Promise<{
            holdings?: {
              chainId: number;
              address: string;
              symbol: string;
              balance: string;
              valueUsd: number | null;
            }[];
          } | null>
        )
          .then((b) => riskOf(b?.holdings ?? []))
          .catch(() => [] as Awaited<ReturnType<typeof riskOf>>);
        const [balR, air, lend, appr, pools, gasNow] = await Promise.all([
          balP,
          run("claimables", () => airdropCheck(f, env, address)),
          vm === "evm"
            ? run("lending", async () => {
                const eth = await prices(f, [{ chainId: 1, address: NATIVE_TOKEN }]);
                return lending(
                  f,
                  env,
                  getAddress(address),
                  pxOf(eth, 1, NATIVE_TOKEN)?.price ?? null,
                );
              })
            : Promise.resolve(null),
          vm === "evm"
            ? run("approvals", async () =>
                (
                  await Promise.all(
                    APPROVAL_CHAINS.map((id) =>
                      // per-chain deadline: one slow explorer degrades only its own chain, never the whole stage
                      Promise.race([
                        approvals(f, env, address, id).then((r) => {
                          if (r.coverage.includes("known spenders only"))
                            notChecked.push(
                              `approvals on ${chainName(id)}: checked known spenders only (unusual spenders not covered)`,
                            );
                          return r;
                        }),
                        new Promise<never>((_, rej) =>
                          setTimeout(
                            () => rej(new Error("timeout")),
                            Number(env.FIND_APPROVAL_CHAIN_MS ?? 13_000),
                          ),
                        ),
                      ]).catch((e) => {
                        notChecked.push(
                          `approvals not checked on ${chainName(id)}${(e as Error).message === "timeout" ? " (explorer too slow)" : ""}`,
                        );
                        return null;
                      }),
                    ),
                  )
                ).filter(Boolean),
              )
            : Promise.resolve(null),
          run("yields", () =>
            yields(f, { stablecoinOnly: true, minTvlUsd: 10_000_000, limit: 50 }),
          ),
          run("gas", () => gas(f, env)),
        ]);
        const bal = balR as {
          totalUsd: number;
          holdings: {
            chainId: number;
            address: string;
            symbol: string;
            balance: string;
            priceUsd: number | null;
            valueUsd: number | null;
          }[];
        } | null;
        const H = bal?.holdings ?? [];
        const airSources = [...new Set((air as { sources?: string[] } | null)?.sources ?? [])];
        for (const n of (air as { notChecked?: string[] } | null)?.notChecked ?? [])
          notChecked.push(n);
        console.log(
          JSON.stringify({
            evt: "find_money_stages",
            ms: fmMs,
            sources: (air as { timingsMs?: unknown } | null)?.timingsMs,
          }),
        );
        for (const it of (air as { items?: Found[] } | null)?.items ?? [])
          items.push({
            category:
              it.kind === "lead"
                ? "Leads (not money, not counted)"
                : it.kind === "solana-rent"
                  ? "Reclaim rent"
                  : it.kind === "lending"
                    ? "Lending position"
                    : it.kind === "legacy"
                      ? "Forgotten money in old contracts"
                      : it.kind === "tron"
                        ? "Tron rewards/unstake"
                        : it.kind === "balance"
                          ? "Spendable balance"
                          : "Unclaimed rewards",
            title: `${it.protocol}: ${it.what}`,
            estUsd: it.kind === "lead" ? null : it.valueUsd,
            estimateKind:
              it.kind === "lead"
                ? "lead"
                : it.valueUsd === null || /\bestimate\b/i.test(it.what ?? "")
                  ? "estimate"
                  : "exact",
            detail: it.risk ?? "",
            action: it.action,
            swapUrl: it.link?.startsWith(SITE)
              ? it.link
              : it.chainId === TRON || it.chainId === SOLANA || it.chainId === BITCOIN
                ? toUsdc(it.chainId, nativeOf(it.chainId))
                : toUsdc(it.chainId, it.underlying ?? nativeOf(it.chainId)),
            ...(it.link && !it.link.startsWith(SITE) && it.kind !== "lead"
              ? { protocolUrl: it.link }
              : {}),
            ...(it.claimTx ? { claimTx: it.claimTx } : {}),
            ...(it.sweep ? { sweep: it.sweep } : {}),
            ...(it.evidence?.length ? { evidence: it.evidence } : {}),
          });
        for (const it of (lend as Found[] | null) ?? [])
          items.push({
            category:
              it.kind === "claimable"
                ? "Unclaimed rewards"
                : it.risk
                  ? "At-risk lending position"
                  : "Lending position",
            title: `${it.protocol}: ${it.what}`,
            estUsd: it.valueUsd,
            estimateKind: "exact",
            detail: it.risk ?? "",
            action: it.action,
            swapUrl: it.link?.startsWith(SITE) ? it.link : toUsdc(it.chainId, nativeOf(it.chainId)),
            ...(it.link && !it.link.startsWith(SITE) ? { protocolUrl: it.link } : {}),
            ...(it.claimTx ? { claimTx: it.claimTx } : {}),
            ...(it.evidence?.length ? { evidence: it.evidence } : {}),
          });
        // risky approvals (money protected)
        for (const a of (appr as
          | {
              chainId: number;
              approvals: {
                symbol: string;
                spender: string;
                spenderName: string | null;
                risk: string;
                allowance: string;
                token: string;
                revokeTx: unknown;
              }[];
            }[]
          | null) ?? [])
          for (const x of a.approvals.filter((y) => y.risk === "high").slice(0, 5)) {
            const held = H.find(
              (h) => h.chainId === a.chainId && h.address.toLowerCase() === x.token.toLowerCase(),
            );
            items.push({
              category: "Risky approval",
              title: `Revoke ${x.symbol} approval to ${x.spenderName ?? short(x.spender)} on ${chainName(a.chainId)}`,
              estUsd: (() => {
                const v = held?.valueUsd ?? null;
                const al = Number(x.allowance);
                return v !== null && Number.isFinite(al) && held?.priceUsd
                  ? r2(Math.min(v, al * held.priceUsd))
                  : v;
              })(),
              estimateKind: "protected",
              detail: `${x.allowance} allowance, flagged high risk`,
              action: "Sign the revokeTx, then swap freely",
              swapUrl: toUsdc(a.chainId, x.token),
              revokeTx: x.revokeTx,
            });
          }
        // idle stablecoins -> best yield
        const P =
          (
            pools as {
              pools?: {
                project: string;
                chain: string;
                chainId: number;
                symbol: string;
                apy: number;
                swapIntoUnderlying: string | null;
              }[];
            } | null
          )?.pools ?? [];
        for (const h of H.filter(
          (x) => STABLES.has(x.symbol.toUpperCase()) && (x.valueUsd ?? 0) >= 50,
        )) {
          const best = P.filter((p) =>
            p.symbol.toUpperCase().includes(h.symbol.toUpperCase().replace(".E", "")),
          ).sort(
            (a, b) =>
              Number(b.chainId === h.chainId) - Number(a.chainId === h.chainId) || b.apy - a.apy,
          )[0];
          if (best)
            items.push({
              category: "Idle stablecoins",
              title: `${h.balance} ${h.symbol} on ${chainName(h.chainId)} is idle`,
              estUsd: r2(((h.valueUsd ?? 0) * best.apy) / 100),
              estimateKind: "estimate",
              detail: `≈$${r2(((h.valueUsd ?? 0) * best.apy) / 100)}/yr at ${best.apy}% APY on ${best.project} (${best.chain}); variable, not guaranteed`,
              action:
                best.chainId === h.chainId
                  ? `Deposit on ${best.project}`
                  : `Bridge to ${best.chain} with SwapChan, then deposit on ${best.project}`,
              swapUrl:
                best.chainId === h.chainId
                  ? SITE
                  : swapUrl(
                      h.chainId,
                      h.address,
                      best.chainId,
                      best.swapIntoUnderlying
                        ? (new URL(best.swapIntoUnderlying).searchParams.get("toToken") ??
                            usdcOf(best.chainId)!)
                        : usdcOf(best.chainId)!,
                      h.balance,
                    ),
            });
        }
        // dust consolidation
        const dust = H.filter(
          (x) =>
            (x.valueUsd ?? 0) > 0.5 &&
            (x.valueUsd ?? 0) < 20 &&
            !STABLES.has(x.symbol.toUpperCase()),
        );
        if (dust.length >= 2) {
          const sum = r2(dust.reduce((s, d) => s + (d.valueUsd ?? 0), 0));
          const link = db
            ? await cap(
                "dust batch link",
                batchLink(
                  f,
                  env,
                  db,
                  dust.slice(0, 10).map((d) => ({
                    fromChain: d.chainId,
                    fromToken: d.address,
                    toChain: d.chainId,
                    toToken: usdcOf(d.chainId) ?? nativeOf(d.chainId),
                    amount: d.balance,
                  })),
                ).catch(() => null),
                null,
                4_000,
              )
            : null;
          items.push({
            category: "Dust to consolidate",
            title: `${dust.length} small balances worth $${sum}`,
            estUsd: sum,
            estimateKind: "exact",
            detail: dust.map((d) => `${d.symbol} $${r2(d.valueUsd ?? 0)}`).join(", "),
            action:
              "Sweep them into USDC in one batch (check gas first: on mainnet some dust costs more to move than it's worth)",
            swapUrl: link?.url ?? toUsdc(dust[0]!.chainId, dust[0]!.address, dust[0]!.balance),
            shortUrl: link?.shortUrl ?? null,
          });
        }
        // risky tokens to exit
        const riskChecks = await cap(
          "high-risk token checks",
          riskP,
          [] as Awaited<typeof riskP>,
          Number(env.FIND_RISK_MS ?? 6_000),
        );
        for (const x of riskChecks.filter((y): y is NonNullable<typeof y> => !!y))
          items.push({
            category: "High-risk token to exit",
            title: `${x.h.symbol} on ${chainName(x.h.chainId)} is flagged high risk`,
            estUsd: x.h.valueUsd,
            estimateKind: "protected",
            detail: x.flags.slice(0, 4).join("; "),
            action:
              "Exit to USDC before it goes to zero (if it's a honeypot, the sell may fail; simulate first)",
            swapUrl: toUsdc(x.h.chainId, x.h.address, x.h.balance),
          });
        // gas window
        const cheapest = (gasNow as { cheapest?: { chain: string; swapCostUsd: number } } | null)
          ?.cheapest;
        const ethGas = (
          (gasNow as { chains?: { chainId: number; swapCostUsd?: number }[] } | null)?.chains ?? []
        ).find((c) => c.chainId === 1)?.swapCostUsd;
        const ethHeavy = H.filter((h) => h.chainId === 1).length;
        if (ethHeavy && ethGas && cheapest && ethGas > 1)
          items.push({
            category: "Cheaper gas",
            title: `Mainnet swaps cost ~$${r2(ethGas)} now vs ~$${cheapest.swapCostUsd.toFixed(3)} on ${cheapest.chain}`,
            estUsd: r2((ethGas - cheapest.swapCostUsd) * Math.min(ethHeavy, 10)),
            estimateKind: "estimate",
            detail:
              "Estimated savings if your next swaps of these holdings happen on an L2 instead of mainnet",
            action: "Bridge once to an L2 and trade there",
            swapUrl: swapUrl(1, NATIVE_TOKEN, 8453, NATIVE_TOKEN),
          });
        // coin balances worth less than moving them: one plain "dust" note, no numbered items, no instructions
        {
          const dust = items.filter((i) => isSweepDust(i));
          if (dust.length) {
            for (const d of dust) items.splice(items.indexOf(d), 1);
            items.push(dustNote(dust));
          }
        }
        // owed but not claimable now: never counted as found, never the lead or the next action; listed separately
        const later = items.filter((i) => isNotClaimableNow(i.title));
        for (const l of later) items.splice(items.indexOf(l), 1);
        const order = (i: Item) =>
          (i.category.startsWith("At-risk") ? 1e12 : 0) +
          (i.estUsd ?? 0) * (i.estimateKind === "estimate" ? 0.5 : 1);
        items.sort((a, b) => order(b) - order(a));
        // short links for the top items
        if (db)
          for (const it of items.slice(0, 10))
            if (!it.shortUrl && it.swapUrl.startsWith(SITE))
              try {
                it.shortUrl = shorten(db, it.swapUrl).shortUrl;
              } catch {}
        items.forEach((it, i) => {
          it.rank = i + 1;
        });
        // guided recovery: step 1 sign the claim/withdraw/unstake on swapchan.com/recover, step 2 swap to USDC
        for (const it of items) {
          if (
            it.estimateKind === "protected" ||
            it.estimateKind === "lead" ||
            it.category === "Cheaper gas" ||
            it.category === DUST_CATEGORY ||
            it.category === "Idle stablecoins" ||
            /: (?:Shown but )?Not claimable/i.test(it.title)
          )
            continue;
          Object.assign(it, recoveryFlow(db, shorten, address, it as never));
        }
        // "swap all of it": one batch link over every recoverable finding's swap step
        const swapAll = db
          ? await (async () => {
              const rows = items
                .filter(
                  (i) =>
                    i.estimateKind !== "protected" &&
                    i.swapUrl.startsWith(`${SITE}/?`) &&
                    (i.estUsd ?? 0) >= 1,
                )
                .map((i) => new URL(i.swapUrl).searchParams)
                .filter(
                  (q) =>
                    q.get("fromToken") &&
                    q.get("toToken") &&
                    q.get("fromToken") !== q.get("toToken"),
                )
                .slice(0, 20)
                .map((q) => ({
                  fromChain: Number(q.get("fromChain")),
                  fromToken: q.get("fromToken")!,
                  toChain: Number(q.get("toChain") ?? q.get("fromChain")),
                  toToken: q.get("toToken")!,
                  ...(q.get("amount") ? { amount: q.get("amount")! } : {}),
                }));
              return rows.length >= 2
                ? cap(
                    "swap-all batch link",
                    batchLink(f, env, db, rows as never).catch(() => null),
                    null,
                    4_000,
                  )
                : null;
            })()
          : null;
        console.log(JSON.stringify({ evt: "find_money_total", ms: fmMs }));
        {
          const srcMs = ((air as { timingsMs?: Record<string, number> } | null)?.timingsMs ??
            {}) as Record<string, number>;
          recordScan({
            ms: Date.now() - t0scan,
            checks: Object.keys(fmMs).length + Object.keys(srcMs).length,
            timeouts: notChecked.filter((n) => n.includes("timed out")).length,
          });
        }
        const total = r2(
          items
            .filter((i) => i.estimateKind !== "protected")
            .reduce((s, i) => s + (i.estUsd ?? 0), 0),
        );
        const protectedUsd = r2(
          items
            .filter((i) => i.estimateKind === "protected")
            .reduce((s, i) => s + (i.estUsd ?? 0), 0),
        );
        const ncTidy = tidyNotChecked(notChecked);
        const incompleteSources = incompleteCount(ncTidy);
        const partial = incompleteSources > 0;
        const head = findMoneyHeadline(
          items.length,
          total,
          later.length,
          later.filter((l) => isShownOnly(l.title)).length,
        );
        return {
          address,
          ...(name ? { name } : {}),
          portfolioUsd: bal?.totalUsd ?? null,
          headline: partial
            ? `${partialPrefix(incompleteSources, timeoutCount(ncTidy))} ${head}`
            : head,
          // true when any source timed out or was dropped: totals are a lower bound, cached ~20 s instead of 3 min
          partial,
          incompleteSources,
          opportunities: items.length,
          ...(swapAll
            ? {
                swapAll: {
                  label: "Swap all of it to USDC (one guided batch)",
                  url: swapAll.url,
                  shortUrl: swapAll.shortUrl,
                },
              }
            : {}),
          trust:
            "Trustless: SwapChan never signs, never holds keys or funds, and cannot move money. Every recoveryTx is unsigned; your own wallet signs it.",
          flow: "Each item has steps: [1] sign the recovery tx on swapchan.com/recover (claim/withdraw/unstake/unwrap; built only when every recipient argument is your own wallet), [2] swap to USDC. swapAll batches every swap step.",
          totalEstUsd: total,
          atRiskUsd: protectedUsd,
          totals:
            "totalEstUsd = claimable/recoverable/estimated savings; atRiskUsd = value exposed to risky approvals or high-risk tokens (protect it, not new money)",
          items,
          owedNotClaimableNow: later.map((l) =>
            owedLater({ title: l.title, ...(l.protocolUrl ? { protocolUrl: l.protocolUrl } : {}) }),
          ),
          // the per-chain scanners' sources (Stellar Horizon, XRPL nodes, explorers...); ledger-only addresses get only these
          sources: airSources,
          checked: ledgerOnly
            ? airSources
            : [
                "wallet balances",
                "unclaimed rewards (Merkl)",
                "legacy contracts (PoWH3D, Fomo3D, EtherDelta ETH+ERC-20, IDEX v1, Liquity)",
                "contract archaeology (EVM full history: reward views, vaults, LPs, Uniswap v3 fees, NFTs)",
                ...(vm === "evm"
                  ? [
                      "lending (Aave v2/v3, Compound v2/v3, Venus, Liquity)",
                      `approvals on ${APPROVAL_CHAINS.map(chainName)
                        .filter((n) => !notChecked.some((x) => x.endsWith(` ${n}`)))
                        .join("/")}`,
                    ]
                  : []),
                "idle stablecoin yields (DefiLlama)",
                "dust",
                "token risk",
                "gas",
                ...(vm === "svm" && !isTron ? ["Solana rent in empty token accounts"] : []),
                ...(isTron ? ["Tron rewards/unfreezes/dividend contracts/JustLend"] : []),
                ...airSources,
              ],
          notChecked: [
            ...ncTidy,
            "Stuck bridge transfers need a tx hash (use bridge_doctor). One-off project airdrops have no free unified source. EVM balances cover SwapChan-listed tokens only.",
          ],
          errors: errors.map(scrubText),
          disclaimer:
            "Estimates are labeled; yields are variable; nothing is financial advice. Claim/revoke txs are unsigned and only built for allowlisted contracts.",
          next: items[0]
            ? cta(`#1: ${items[0].title}`, items[0].swapUrl)
            : cta(
                later.length
                  ? "Nothing claimable right now. Swap at the best price on SwapChan"
                  : "Nothing found to recover. Swap at the best price on SwapChan",
                SITE,
              ),
        };
      }),
    ),
  );
}

// ---------- routes ----------
export function intelRoutes(
  f: F,
  env: NodeJS.ProcessEnv,
  db: DatabaseSync | null,
  quote: QuoteFn,
  linksDb: DatabaseSync | null = db,
) {
  const app = new Hono();
  if (linksDb) initLinksDb(linksDb);
  if (db) {
    initGasDb(db);
    initLinksDb(db);
    if (env.NODE_ENV !== "test" && !env.VITEST) {
      void sampleGas(env, db).catch(() => {});
      setInterval(() => void sampleGas(env, db).catch(() => {}), 600_000).unref();
    }
  }
  const run = async (
    c: { json: (b: unknown, s?: 200 | 400 | 404 | 429 | 502 | 503) => Response },
    fnc: () => Promise<unknown> | unknown,
  ) => {
    try {
      const r = await fnc();
      return r === null ? c.json({ error: "not found" }, 404) : c.json(r);
    } catch (e) {
      if (e instanceof RateLimited) return c.json({ error: e.message }, 429);
      if (e instanceof BusyError) return c.json({ error: e.message }, 503);
      const bad = e instanceof BadRequest || e instanceof z.ZodError;
      return bad
        ? c.json({ error: (e as Error).message.slice(0, 300) }, 400)
        : c.json({ error: safeReason(e) }, 502);
    }
  };
  const need = (v: string | undefined, n: string) => {
    if (!v) throw new BadRequest(`${n} is required`);
    return v;
  };
  const TxBody = z.object({
    chainId: z.union([z.number(), z.string()]),
    tx: z.union([z.string().max(200_000), z.record(z.string(), z.unknown())]),
    expected: z
      .object({
        to: z.string(),
        recipient: z.string(),
        maxValue: z.string(),
        minOut: z.string(),
        quotedOut: z.string(),
        outToken: z.string(),
      })
      .partial()
      .optional(),
    private: z.boolean().optional(),
    strict: z.boolean().optional(),
  });
  app.post("/verify-tx", (c) =>
    run(c, async () => {
      const b = TxBody.parse(await c.req.json());
      return verifyTx(f, env, chainOf(b.chainId), b.tx, (b.expected ?? {}) as never);
    }),
  );
  const bcastLimit = broadcastLimiter(Number(env.SWAPCHAN_BROADCAST_PER_MIN) || 10);
  app.post("/broadcast", async (c) => {
    const who = broadcastClientKey(
      (n) => c.req.header(n),
      (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
        ?.socket?.remoteAddress,
    );
    const lim = bcastLimit(who);
    if (!lim.ok) {
      c.header("retry-after", String(lim.retryAfter));
      return c.json({ error: "rate limit exceeded" }, 429);
    }
    return run(c, async () => {
      const b = TxBody.parse(await c.req.json());
      const where = routeBroadcast(b.chainId, chainOf);
      if ("extra" in where) return broadcastExtra(f, env, where.extra, b.tx, !!b.strict);
      return broadcastTx(f, env, {
        chainId: where.core,
        tx: b.tx as never,
        ...(b.private ? { private: true } : {}),
        ...(b.strict ? { strict: true } : {}),
      });
    });
  });
  app.get("/tx-status", (c) =>
    run(c, () =>
      txStatus(
        f,
        env,
        chainOf(need(c.req.query("chainId"), "chainId")),
        need(c.req.query("hash"), "hash"),
      ),
    ),
  );
  app.get("/signing-guide", (c) =>
    run(c, async () =>
      signingGuide(
        (["evm", "solana", "tron"].includes(c.req.query("chain") ?? "")
          ? c.req.query("chain")
          : "evm") as never,
        c.req.query("situation") ?? "full",
      ),
    ),
  );
  app.get("/recover-verify", (c) =>
    run(c, async () =>
      verifyRecovery(
        {
          to: c.req.query("to") ?? "",
          data: c.req.query("data") ?? "0x",
          value: c.req.query("value") ?? "0",
        },
        c.req.query("owner") ?? "",
      ),
    ),
  );
  app.get("/utxo-sweep", (c) =>
    run(c, async () => {
      const coin = c.req.query("coin") as Coin;
      if (!COINS[coin])
        throw new BadRequest(`coin must be one of ${Object.keys(COINS).join(", ")}`);
      const fr = c.req.query("feeRate");
      return utxoSweep(
        f,
        coin,
        c.req.query("from") ?? "",
        c.req.query("to") ?? "",
        fr ? Number(fr) : undefined,
      ).catch((e) => {
        throw new BadRequest((e as Error).message);
      });
    }),
  );
  app.get("/fork-sweep", (c) =>
    run(c, async () => {
      const k = c.req.query("chain") as EthFork;
      if (!ETH_FORKS[k])
        throw new BadRequest(`chain must be one of ${Object.keys(ETH_FORKS).join(", ")}`);
      return forkSweep(f, k, c.req.query("from") ?? "", c.req.query("to") ?? "").catch((e) => {
        throw new BadRequest((e as Error).message);
      });
    }),
  );
  app.get("/evm-sweep", (c) =>
    run(c, async () =>
      evmSweep(
        f,
        c.req.query("chain") ?? "",
        c.req.query("from") ?? "",
        c.req.query("to") ?? "",
        c.req.query("token") || undefined,
      ).catch((e) => {
        throw new BadRequest((e as Error).message);
      }),
    ),
  );
  app.get("/recovery-guide", (c) =>
    run(c, async () => recoveryGuide(c.req.query("situation") ?? "full")),
  );
  app.post("/simulate", (c) =>
    run(c, async () => simulateSwap(f, env, SimulateBody.parse(await c.req.json()))),
  );
  app.get("/history", (c) =>
    run(c, () =>
      walletHistory(f, env, need(c.req.query("address"), "address"), c.req.query("chainId")).then(
        ({ allPriced: _, ...r }) => r,
      ),
    ),
  );
  app.get("/pnl", (c) =>
    run(c, () =>
      walletPnl(f, env, need(c.req.query("address"), "address"), c.req.query("chainId")),
    ),
  );
  app.get("/pools", (c) =>
    run(c, () =>
      tokenPools(
        f,
        need(c.req.query("chainId"), "chainId"),
        need(c.req.query("address"), "address"),
      ),
    ),
  );
  app.get("/whales", (c) =>
    run(c, () =>
      whaleWatch(
        f,
        env,
        need(c.req.query("chainId"), "chainId"),
        need(c.req.query("address"), "address"),
        c.req.query("minUsd") ? Number(c.req.query("minUsd")) : undefined,
      ),
    ),
  );
  app.get("/contract", (c) =>
    run(c, () =>
      contractReader(
        f,
        env,
        need(c.req.query("chainId"), "chainId"),
        need(c.req.query("address"), "address"),
      ),
    ),
  );
  app.get("/airdrops", (c) =>
    run(c, () =>
      scanGate.run(() =>
        withScanScope(20_000, () => airdropCheck(f, env, need(c.req.query("address"), "address"))),
      ),
    ),
  );
  app.get("/market", (c) => run(c, () => marketContext(f)));
  app.post("/rebalance", (c) =>
    run(c, async () => rebalancePlan(f, env, RebalanceBody.parse(await c.req.json()), quote)),
  );
  app.get("/bridge", (c) =>
    run(c, () =>
      bridgeDoctor(f, env, need(c.req.query("hash"), "hash"), c.req.query("fromChainId")),
    ),
  );
  app.get("/gas/history", (c) => run(c, () => gasHistory(f, env, db, c.req.query("chainId") ?? 1)));
  app.post("/read-chain", (c) =>
    run(c, async () => {
      const b = z
        .object({ chainId: z.union([z.number(), z.string()]), op: z.enum(READ_OPS) })
        .passthrough()
        .parse(await c.req.json());
      return readChain(f, env, b as never, { contract: (id, a) => contractReader(f, env, id, a) });
    }),
  );
  const findOne = (a: string) => findMoney(f, env, linksDb, a, { gate: batchGate }) as never;
  const batchLimit = batchIpLimiter(Number(env.SWAPCHAN_BATCH_ADDRS_PER_HOUR) || 500);
  if (!env.VITEST) {
    const resumed = initBatchStore(
      env.SWAPCHAN_DATA_DIR ? `${env.SWAPCHAN_DATA_DIR}/batches.db` : null,
      findOne,
    );
    if (resumed)
      console.log(`find_money_batch: resumed ${resumed} interrupted job(s) from batches.db`);
  }
  app.post("/money/batch", (c) =>
    run(c, async () => {
      const b = z
        .object({
          addresses: z.union([
            z.string().max(100_000),
            z
              .array(
                z.union([
                  z.string().max(300),
                  z.object({ address: z.string().max(200), label: z.string().max(120).optional() }),
                ]),
              )
              .max(500),
          ]),
        })
        .parse(await c.req.json());
      const n = parseAddresses(b.addresses).addresses.length;
      const lim = batchLimit(
        broadcastClientKey((h) => c.req.header(h), socketAddressOf(c.env)),
        n,
      );
      if (!lim.ok) {
        c.header("retry-after", String(lim.retryAfter));
        throw new RateLimited(
          `batch limit: at most ${lim.max} addresses per hour from one client; retry in ${lim.retryAfter}s`,
        );
      }
      return startBatch(findOne, b.addresses);
    }),
  );
  app.get("/money/batch/:id", (c) => run(c, async () => batchStatus(c.req.param("id"))));
  // fast single-contract check for the /find-money/<protocol> landing pages (seconds, not a full scan)
  app.get("/money/legacy", (c) =>
    run(c, async () => {
      const address = getAddress(need(c.req.query("address"), "address"));
      const eth = await prices(f, [{ chainId: 1, address: NATIVE_TOKEN }]);
      const ethUsd = pxOf(eth, 1, NATIVE_TOKEN)?.price ?? null;
      const [base, reg] = await Promise.all([
        legacyEth(env, address, ethUsd),
        legacyRegistry(env, address, ethUsd).catch((e) => ({
          items: [] as Found[],
          notChecked: [`LegacyETH registry: not checked (${safeReason(e)})`],
        })),
      ]);
      const items = [...base, ...reg.items].map((i) => ({
        ...i,
        ...recoveryFlow(null, null, address, {
          title: `${i.protocol}: ${i.what}`,
          claimTx: i.claimTx,
          swapUrl: i.link ?? "https://swapchan.com/",
        }),
      }));
      return {
        address,
        ethUsd,
        items,
        notChecked: reg.notChecked,
        fullScan: `https://swapchan.com/find-money?address=${address}`,
      };
    }),
  );
  app.get("/playbook", (c) =>
    run(c, async () => playbook(c.req.query("workflow"), c.req.query("full") === "true")),
  );
  app.get("/money", (c) =>
    run(c, () =>
      findMoney(f, env, linksDb, need(c.req.query("address"), "address"), {
        fresh: ["1", "true"].includes(c.req.query("fresh") ?? ""),
        client: clientIpOf((n) => c.req.header(n), socketAddressOf(c.env)),
      }),
    ),
  );
  return app;
}
/**
 * find_money used to write short links into the watch DB, which /links never read.
 * Copy them into links.db keeping their ids (URLs are forever) and lift links.db's
 * AUTOINCREMENT past them so no id is ever issued twice. Ids already taken in links.db win.
 */
export function migrateStrayLinks(from: DatabaseSync, to: DatabaseSync) {
  initLinksDb(to);
  let rows: { n: number; id: string; url: string; created: number; clicks: number }[] = [];
  try {
    rows = from.prepare("SELECT n, id, url, created, clicks FROM links").all() as typeof rows;
  } catch {
    return 0;
  }
  // Ids that collided with an id already issued from links.db (2026-10-23: 100..103) are never
  // overwritten (the links.db target is the one that has been resolving); their other target is
  // kept in link_collisions so it is never silently lost.
  to.exec(
    `CREATE TABLE IF NOT EXISTS link_collisions (id TEXT NOT NULL, url TEXT NOT NULL, created INTEGER NOT NULL, source TEXT NOT NULL, recorded INTEGER NOT NULL, PRIMARY KEY (id, url));`,
  );
  const ins = to.prepare(
    "INSERT OR IGNORE INTO links (n, id, url, created, clicks) VALUES (?, ?, ?, ?, ?)",
  );
  const held = to.prepare("SELECT url FROM links WHERE id = ?");
  const col = to.prepare(
    "INSERT OR IGNORE INTO link_collisions (id, url, created, source, recorded) VALUES (?, ?, ?, 'watches.db', ?)",
  );
  let moved = 0;
  for (const r of rows) {
    const c = Number(ins.run(r.n, r.id, r.url, r.created, r.clicks).changes);
    moved += c;
    if (!c) {
      const h = held.get(r.id) as { url: string } | undefined;
      if (h && h.url !== r.url) col.run(r.id, r.url, r.created, Date.now());
    }
  }
  return moved;
}
export function linkRoutes(f: F, env: NodeJS.ProcessEnv, db: DatabaseSync) {
  const app = new Hono();
  initLinksDb(db);
  // Daily local snapshot (keep 14) so a corrupted links.db never loses ids.
  const dir = env.SWAPCHAN_DATA_DIR;
  if (dir && !env.VITEST) {
    const backup = () => {
      try {
        mkdirSync(`${dir}/backups`, { recursive: true });
        const f2 = `${dir}/backups/links-${new Date().toISOString().slice(0, 10)}.db`;
        if (!existsSync(f2)) db.exec(`VACUUM INTO '${f2}'`);
        for (const old of readdirSync(`${dir}/backups`)
          .filter((x) => x.startsWith("links-"))
          .sort()
          .slice(0, -14))
          rmSync(`${dir}/backups/${old}`);
      } catch {}
    };
    backup();
    setInterval(backup, 6 * 3_600_000).unref();
  }
  const run = async (
    c: { json: (b: unknown, s?: 200 | 400 | 404 | 502 | 503) => Response },
    fnc: () => Promise<unknown> | unknown,
  ) => {
    try {
      const r = await fnc();
      return r === null ? c.json({ error: "not found" }, 404) : c.json(r);
    } catch (e) {
      if (e instanceof BusyError) return c.json({ error: e.message }, 503);
      const bad = e instanceof BadRequest || e instanceof z.ZodError;
      return bad
        ? c.json({ error: (e as Error).message.slice(0, 300) }, 400)
        : c.json({ error: safeReason(e) }, 502);
    }
  };
  app.get("/swap", (c) => run(c, () => buildSwapLink(f, env, db, LinkParams.parse(c.req.query()))));
  app.post("/", (c) =>
    run(c, async () => {
      const b = (await c.req.json()) as { url?: string; items?: unknown[]; ref?: string };
      if (b.url) {
        // a /recover?to=&data= signing page only gets a permanent link when SwapChan signed it (fail closed)
        const u = new URL(b.url, SITE);
        if (/^\/recover\/?$/.test(u.pathname) && u.searchParams.has("to") && !recoverUrlSigned(u))
          throw new BadRequest(
            "unsigned /recover link: only SwapChan-built recovery links can be shortened",
          );
        return shorten(db, b.url);
      }
      if (Array.isArray(b.items))
        return batchLink(f, env, db, z.array(LinkParams).min(1).max(20).parse(b.items), b.ref);
      return buildSwapLink(f, env, db, LinkParams.parse(b));
    }),
  );
  app.get("/:id", (c) =>
    run(c, () => resolveShort(db, c.req.param("id"), c.req.query("count") !== "0")),
  );
  return app;
}
