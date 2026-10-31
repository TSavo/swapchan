import { encodeFunctionData } from "./blocktools.js";
/**
 * Published merkle airdrop trees → claim() calldata.
 * Trees are fetched on demand and cached under SWAPCHAN_DATA_DIR/merkle/.
 * UNI uses Uniswap's public chunked drop (mrkl-drop-data-chunks); others use
 * published claim maps when available.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodePacked, formatUnits, getAddress, keccak256, parseAbiItem } from "viem";
import { evmClient, json, prices, pxOf, swapUrl, usdcOf } from "./onchain.js";
import type { Evidence } from "./recover.js";
import type { StuckFound } from "./stuck.js";

type F = typeof fetch;
const r2 = (n: number) => Math.round(n * 100) / 100;
const fn = (s: string) => [parseAbiItem(`function ${s}`)] as const;
const ev = (
  chainId: number,
  address: string,
  call: string,
  args: string[],
  raw: string | string[],
): Evidence => ({ chainId, address, call, args, raw });

export type ClaimRow = { index: number; amount: string; proof: string[] };

type Drop = {
  name: string;
  chainId: number;
  distributor: `0x${string}`;
  token: `0x${string}`;
  decimals?: number;
  portal: string;
  /** Resolve claim row for owner: null = not in the published tree (not eligible).
   *  Throws SourceUnavailable when the tree is not published / not reachable. */
  lookup: (f: F, env: NodeJS.ProcessEnv, owner: `0x${string}`) => Promise<ClaimRow | null>;
  /** On-chain claim deadline getter (unix seconds). Past = closed, emit nothing. */
  deadlineFn?: string;
  /** When the tree is unavailable, only surface a lead if the wallet called one of these
   *  contracts on `chainId` before `beforeBlock` (the snapshot), i.e. plausibly eligible. */
  leadHint?: { chainId: number; beforeBlock: number; to: string[]; why: string };
};

export class SourceUnavailable extends Error {}
const unavailable = (name: string) => {
  throw new SourceUnavailable(`${name} claim tree is not published`);
};

function cacheDir(env: NodeJS.ProcessEnv) {
  const dir = join(env.SWAPCHAN_DATA_DIR || "/tmp/swapchan-merkle", "merkle");
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function cachedJson<T>(
  f: F,
  env: NodeJS.ProcessEnv,
  key: string,
  url: string,
  ttlMs = 7 * 24 * 3600_000,
): Promise<T> {
  const path = join(cacheDir(env), key);
  if (existsSync(path)) {
    try {
      const st = JSON.parse(readFileSync(path, "utf8")) as { t: number; data: T };
      if (Date.now() - st.t < ttlMs) return st.data;
    } catch {}
  }
  const data = await json<T>(f, url, undefined, 60_000);
  writeFileSync(path, JSON.stringify({ t: Date.now(), data }));
  return data;
}

/** UNI: mapping.json maps chunkStart → chunkEnd; chunk file is chunks/<chunkStart>.json */
async function uniLookup(
  f: F,
  env: NodeJS.ProcessEnv,
  owner: `0x${string}`,
): Promise<ClaimRow | null> {
  const base = "https://raw.githubusercontent.com/Uniswap/mrkl-drop-data-chunks/main/chunks";
  const mapping = await cachedJson<Record<string, string>>(
    f,
    env,
    "uni-mapping.json",
    `${base}/mapping.json`,
  );
  const addr = owner.toLowerCase() as `0x${string}`;
  const starts = Object.keys(mapping).sort();
  // largest start <= addr
  let lo = 0,
    hi = starts.length - 1,
    best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= addr) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (best < 0) return null;
  const start = starts[best]!;
  const end = mapping[start]!;
  if (addr > end) return null;
  const chunk = await cachedJson<Record<string, ClaimRow & { flags?: unknown }>>(
    f,
    env,
    `uni-${start}.json`,
    `${base}/${start}.json`,
  );
  const row = chunk[addr] ?? chunk[getAddress(addr)];
  if (!row) return null;
  return { index: row.index, amount: row.amount, proof: row.proof };
}

/** Generic: flat address→{index,amount,proof} JSON at a URL (optional). */
function flatLookup(url: string, cacheKey: string) {
  return async (f: F, env: NodeJS.ProcessEnv, owner: `0x${string}`): Promise<ClaimRow | null> => {
    try {
      const map = await cachedJson<Record<string, ClaimRow>>(f, env, cacheKey, url);
      const row = map[owner.toLowerCase()] ?? map[getAddress(owner)] ?? map[owner];
      return row ?? null;
    } catch (e) {
      throw new SourceUnavailable(`${cacheKey}: ${(e as Error).message}`);
    }
  };
}

/**
 * Bundled drop registry. claimsUrl / lookup pull published trees; claim() is built when a row exists.
 * ENS/OP/ARB/1INCH: optional env overrides SWAPCHAN_MERKLE_<NAME>_URL for a flat JSON map.
 */
export const PUBLISHED_DROPS: Drop[] = [
  {
    name: "Uniswap UNI",
    chainId: 1,
    distributor: "0x090D4613473dEE047c3f2706764f49E0821D256e",
    token: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    portal: "https://app.uniswap.org/claim",
    lookup: uniLookup,
  },
  {
    name: "ENS",
    chainId: 1,
    distributor: "0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72",
    token: "0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72",
    portal: "https://claim.ens.domains",
    // Claim window closed 2022-05-04; unclaimed ENS went to the DAO.
    deadlineFn: "claimPeriodEnds",
    lookup: async (f, env, owner) => {
      const url = env.SWAPCHAN_MERKLE_ENS_URL;
      if (!url) return unavailable("ENS");
      return flatLookup(url, "ens-claims.json")(f, env, owner);
    },
  },
  {
    name: "1INCH",
    chainId: 1,
    distributor: "0xE295aD71242373C37C5FdA7B57F26f9eA1088AFe",
    token: "0x111111111117dC0aa78b770fA6A738034120C302",
    portal: "https://1inch.io",
    // Dec 2020 drop: no expiry, but 1inch took the claim API/tree offline (1inch/merkle-distribution#48).
    leadHint: {
      chainId: 1,
      beforeBlock: 11_512_000,
      to: [
        "0x11111254369792b2ca5d084ab5eea397ca8fa48b",
        "0x111111125434b319222cdbf8c261674adb56f3ae",
        "0x111111254b08ceeee8ad6ca827de9952d2a46781",
        "0xc4a8b7e29e3c8ec560cd4945c1cf3461a85a148d",
      ],
      why: "used 1inch before the Dec 2020 snapshot",
    },
    lookup: async (f, env, owner) => {
      const url = env.SWAPCHAN_MERKLE_1INCH_URL;
      if (!url) return unavailable("1INCH");
      return flatLookup(url, "1inch-claims.json")(f, env, owner);
    },
  },
  {
    name: "Optimism OP",
    chainId: 10,
    distributor: "0xFeDFAF1A10335448b7FA0268F56D2B44DBD357de",
    token: "0x4200000000000000000000000000000000000042",
    portal: "https://app.optimism.io/airdrops",
    lookup: async (f, env, owner) => {
      const url = env.SWAPCHAN_MERKLE_OP_URL;
      if (!url) return unavailable("OP");
      return flatLookup(url, "op-claims.json")(f, env, owner);
    },
  },
  {
    name: "Arbitrum ARB",
    chainId: 42161,
    distributor: "0x67a24CE4321aB3aF51c2D0a4801c3E111D88C9d9",
    token: "0x912CE59144191C1204E64559FE8253a0e49E6548",
    portal: "https://arbitrum.foundation/claim",
    lookup: async (f, env, owner) => {
      const url = env.SWAPCHAN_MERKLE_ARB_URL;
      if (!url) return unavailable("ARB");
      return flatLookup(url, "arb-claims.json")(f, env, owner);
    },
  },
];

const erc20 = fn("balanceOf(address) view returns (uint256)");

/** Claim still possible on-chain: deadline not passed and distributor still holds >= 1 token. */
async function dropOpen(d: Drop, env: NodeJS.ProcessEnv): Promise<boolean> {
  const c = evmClient(d.chainId, env);
  if (d.deadlineFn) {
    const end = await c
      .readContract({
        address: d.token,
        abi: fn(`${d.deadlineFn}() view returns (uint256)`),
        functionName: d.deadlineFn,
      })
      .catch(() => null);
    if (typeof end === "bigint" && Number(end) * 1000 < Date.now()) return false;
  }
  const bal = await c
    .readContract({
      address: d.token,
      abi: erc20,
      functionName: "balanceOf",
      args: [d.distributor],
    })
    .catch(() => null);
  if (bal === null) return false;
  return bal >= 10n ** BigInt(d.decimals ?? 18);
}

type ExTx = { to?: string; from?: string; blockNumber?: string; contractAddress?: string };
async function explorerRows(
  f: F,
  env: NodeJS.ProcessEnv,
  chainId: number,
  q: string,
): Promise<ExTx[] | null> {
  const urls = [
    ...(env.ETHERSCAN_API_KEY
      ? [`https://api.etherscan.io/v2/api?chainid=${chainId}&${q}&apikey=${env.ETHERSCAN_API_KEY}`]
      : []),
    ...(chainId === 1 ? [`https://eth.blockscout.com/api?${q}`] : []),
  ];
  for (const u of urls) {
    try {
      const r = await json<{ status?: string; message?: string; result: ExTx[] | string }>(
        f,
        u,
        undefined,
        20_000,
      );
      if (Array.isArray(r.result)) return r.result;
      if (/no (token )?transactions|no token transfers/i.test(r.message ?? "")) return [];
    } catch {}
  }
  return null;
}

/** Wallet already received the drop token from the distributor (claimed). null = unknown. */
async function alreadyReceived(f: F, env: NodeJS.ProcessEnv, d: Drop, owner: string) {
  const rows = await explorerRows(
    f,
    env,
    d.chainId,
    `module=account&action=tokentx&address=${owner}&contractaddress=${d.token}&page=1&offset=1000&sort=asc`,
  );
  if (!rows) return null;
  const dist = d.distributor.toLowerCase();
  return rows.some((r) => r.from?.toLowerCase() === dist);
}

async function plausiblyEligible(f: F, env: NodeJS.ProcessEnv, d: Drop, owner: string) {
  const h = d.leadHint;
  if (!h) return false;
  const rows = await explorerRows(
    f,
    env,
    h.chainId,
    `module=account&action=txlist&address=${owner}&startblock=0&endblock=${h.beforeBlock}&page=1&offset=10000&sort=asc`,
  );
  if (!rows) return false;
  const want = new Set(h.to.map((x) => x.toLowerCase()));
  return rows.some(
    (r) => r.from?.toLowerCase() === owner.toLowerCase() && want.has((r.to ?? "").toLowerCase()),
  );
}

/**
 * Per-address merkle airdrop check:
 *  - closed window (deadline passed / distributor swept) -> nothing
 *  - published tree: not in tree or isClaimed -> nothing; eligible+unclaimed -> exact claim()
 *  - tree unpublished: lead (not money, never counted) only if the wallet plausibly qualified
 *    and never received the token from the distributor.
 */
export async function merkleClaimFromTrees(
  f: F,
  env: NodeJS.ProcessEnv,
  owner: `0x${string}`,
): Promise<StuckFound[]> {
  const res = await Promise.all(
    PUBLISHED_DROPS.map(async (d): Promise<StuckFound | null> => {
      try {
        if (!(await dropOpen(d, env))) return null;
        let row: ClaimRow | null;
        try {
          row = await d.lookup(f, env, owner);
        } catch (e) {
          if (!(e instanceof SourceUnavailable) && !(e instanceof Error)) return null;
          if (!(await plausiblyEligible(f, env, d, owner))) return null;
          if ((await alreadyReceived(f, env, d, owner)) !== false) return null;
          return {
            kind: "lead",
            protocol: `${d.name} airdrop`,
            chainId: d.chainId,
            what: `lead, not money: you ${d.leadHint?.why}; the ${d.name} claim list is not published, so eligibility can't be confirmed`,
            valueUsd: null,
            confidence: "low",
            action: `Check ${d.portal}`,
            link: d.portal,
            evidence: [],
            risk: "Lead only, not counted in the total",
          } as StuckFound;
        }
        if (!row) return null;
        const c = evmClient(d.chainId, env);
        // the row comes from upstream JSON: only trust it if it proves against the on-chain root (fail closed)
        const root = await c
          .readContract({
            address: d.distributor,
            abi: fn("merkleRoot() view returns (bytes32)"),
            functionName: "merkleRoot",
          })
          .catch(() => null);
        if (typeof root !== "string" || !verifyMerkleRow(owner, row, root as `0x${string}`))
          return null;
        const claimed = await c
          .readContract({
            address: d.distributor,
            abi: fn("isClaimed(uint256) view returns (bool)"),
            functionName: "isClaimed",
            args: [BigInt(row.index)],
          })
          .catch(() => true);
        if (claimed) return null;
        const dec = d.decimals ?? 18;
        const amt = Number(formatUnits(BigInt(row.amount), dec));
        const px = await prices(f, [{ chainId: d.chainId, address: d.token }]).catch(
          () => new Map(),
        );
        const p = pxOf(px, d.chainId, d.token)?.price ?? null;
        return {
          kind: "claimable",
          protocol: `${d.name} airdrop`,
          chainId: d.chainId,
          what: `${amt.toPrecision(5)} unclaimed ${d.name}`,
          valueUsd: p ? r2(amt * p) : null,
          confidence: "high",
          claimTx: buildMerkleClaimTx(d, owner, row),
          action: "Claim airdrop from your own wallet, then swap on SwapChan",
          link: swapUrl(d.chainId, d.token, d.chainId, usdcOf(d.chainId)!, String(amt)),
          evidence: [
            ev(d.chainId, d.distributor, "isClaimed(uint256)", [String(row.index)], "false"),
            ev(d.chainId, d.distributor, "merkleRow", [owner, String(row.index)], row.amount),
          ],
          underlying: d.token,
        };
      } catch {
        return null;
      }
    }),
  );
  return res.filter((x): x is StuckFound => !!x);
}

/** Build claim calldata for a known row without checking isClaimed (tests / dry-run). */
export function buildMerkleClaimTx(
  drop: Pick<Drop, "chainId" | "distributor" | "name">,
  owner: `0x${string}`,
  row: ClaimRow,
) {
  return {
    chainId: drop.chainId,
    to: drop.distributor,
    data: encodeFunctionData({
      abi: fn("claim(uint256,address,uint256,bytes32[])"),
      functionName: "claim",
      args: [BigInt(row.index), owner, BigInt(row.amount), row.proof as `0x${string}`[]],
    }),
    value: "0",
    description: `claim(${row.index}): ${drop.name} merkle airdrop`,
  };
}

/** MerkleDistributor leaf = keccak256(abi.encodePacked(index, account, amount)); sorted-pair hashing (OpenZeppelin MerkleProof). */
export function merkleLeaf(owner: `0x${string}`, row: ClaimRow): `0x${string}` {
  return keccak256(
    encodePacked(
      ["uint256", "address", "uint256"],
      [BigInt(row.index), getAddress(owner), BigInt(row.amount)],
    ),
  );
}

/** True only when the row's proof hashes up to `root`. Any malformed input = false. */
export function verifyMerkleRow(owner: `0x${string}`, row: ClaimRow, root: `0x${string}`): boolean {
  try {
    let h = merkleLeaf(owner, row);
    for (const p of row.proof) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(p)) return false;
      const q = p as `0x${string}`;
      const [a, b] = BigInt(h) <= BigInt(q) ? [h, q] : [q, h];
      h = keccak256(encodePacked(["bytes32", "bytes32"], [a, b]));
    }
    return h.toLowerCase() === root.toLowerCase();
  } catch {
    return false;
  }
}
