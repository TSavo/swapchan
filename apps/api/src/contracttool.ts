/**
 * Read / Write Contract (swapchan.com/tools/contract, MCP contract_abi / contract_read / contract_encode_call).
 * EVM only. Fetches a contract's ABI (Sourcify first, then Etherscan API V2 only when ETHERSCAN_API_KEY is set, else a
 * pasted ABI), follows proxies (EIP-1967, EIP-1967 beacon, OpenZeppelin legacy, EIP-1822, EIP-897), runs view/pure
 * functions through eth_call on the existing RPC layer, builds calldata for write functions and gives a pre-signing
 * verdict (contract_approve_call), and builds unsigned contract creations (contract_build_creation). All ABI parsing,
 * encoding, decoding and checking runs in blocktools (evmAbiInspect, evmAbiEncode, evmAbiDecode, buildEvmTransfer,
 * evmApproveCall, verifyTx, evmCreateAddress). Nothing here signs, sends or broadcasts: the user's own wallet does that.
 *
 * Safety: fixed hosts only (sourcify.dev, api.etherscan.io), redirects are errors, response size and time capped,
 * request bodies capped, per-client fixed-window rate limit, a small cap on concurrent reads, the API key is never
 * logged or echoed (errors carry a host and status only). Failed reads return an error, never a zero.
 */
import { Hono } from "hono";
import { fullAddress } from "./addrDisplay.js";
import { blocktools } from "./blocktools.js";
import { socketAddressOf } from "./clientip.js";
import { clientOf } from "./devtools.js";
import { chainName, chainOf, EVM_IDS, evmClient } from "./onchain.js";

type F = typeof fetch;
type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
export type AbiParam = { name?: string; type: string; components?: AbiParam[]; indexed?: boolean };
export type AbiItem = {
  type: string;
  name?: string;
  inputs?: AbiParam[];
  outputs?: AbiParam[];
  stateMutability?: string;
};
export type ContractFn = {
  name: string;
  signature: string;
  selector: string;
  stateMutability: string;
  kind: "read" | "write";
  payable: boolean;
  inputs: { name: string; type: string; components?: AbiParam[] }[];
  outputs: { name: string; type: string; components?: AbiParam[] }[];
};

export const ALLOWED_HOSTS = new Set(["sourcify.dev", "api.etherscan.io"]);
export const MAX_RESPONSE_BYTES = 2_000_000;
export const FETCH_TIMEOUT_MS = 8_000;
export const MAX_ABI_CHARS = 200_000;
export const MAX_BODY = 250_000;
export const MAX_ARGS = 32;
export const MAX_ARG_CHARS = 8_192;
export const MAX_CONCURRENT_READS = 8;
export const RATE_PER_MIN = 30;
export const CACHE_TTL_MS = 60 * 60_000;
export const MISS_TTL_MS = 5 * 60_000;
const CACHE_MAX = 1_000;
/** EIP-1967 implementation slot: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1). */
export const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
/** bytes32(uint256(keccak256("eip1967.proxy.beacon")) - 1); the beacon's implementation() is the implementation. */
export const EIP1967_BEACON_SLOT =
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
/** keccak256("org.zeppelinos.proxy.implementation"): OpenZeppelin legacy (zos) proxies, e.g. USDC FiatTokenProxy. */
export const ZEPPELINOS_IMPL_SLOT =
  "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";
/** keccak256("PROXIABLE"): EIP-1822 (UUPS) implementation slot. */
export const EIP1822_PROXIABLE_SLOT =
  "0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7";
/** implementation() selector (EIP-897 proxies, EIP-1967 beacons). */
export const IMPLEMENTATION_SELECTOR = "0x5c60da1b";
/** EIP-3860 initcode size cap. */
export const MAX_INITCODE_BYTES = 49_152;
/** Placeholders for the check-only unsigned tx; the user's wallet sets the real nonce, gas and gas price. */
export const PLACEHOLDER = {
  nonce: 0,
  gas: 1_000_000,
  createGas: 5_000_000,
  gasPrice: "1000000000",
};
export type ProxyKind =
  | "EIP-1967"
  | "EIP-1967 beacon"
  | "OpenZeppelin legacy"
  | "EIP-1822"
  | "EIP-897";
export type ProxyInfo = { kind: ProxyKind; implementation: string; beacon?: string };
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const SIG = /^[A-Za-z_$][A-Za-z0-9_$]*\([A-Za-z0-9_,()[\]]*\)$/;

export class ContractError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}
const bad = (code: string, status = 400): never => {
  throw new ContractError(code, status);
};
const w = () => blocktools() ?? bad("blocktools_unavailable", 503);

const PRESIGN_ADDR = /^0x[0-9a-fA-F]{40}$/;
const PRESIGN_DEC = /^\d{1,78}$/;
const PRESIGN_STR = [
  "expect_spender",
  "expect_amount",
  "expect_recipient",
  "expect_value",
] as const;
/**
 * Optional blocktools verifyTx pre-sign assertions (blocktools 10a1356a), passed through in its call_json next
 * to the ABI. Types are checked here with blocktools' own error codes. None given: blocktools' deny-by-default
 * checks run as before (unlimited_approval, inner_calls_not_asserted, delegatecall).
 */
export function presignOptions(i: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of PRESIGN_STR) {
    const v = i[k];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string") return bad(`${k}_must_be_string`);
    const s = v.trim();
    const re = k === "expect_spender" || k === "expect_recipient" ? PRESIGN_ADDR : PRESIGN_DEC;
    if (!re.test(s)) return bad(`bad_${k}`);
    o[k] = s;
  }
  const u = i.expect_unlimited;
  if (u !== undefined && u !== null) {
    if (typeof u !== "boolean") return bad("expect_unlimited_must_be_bool");
    if (u) {
      if (o.expect_spender === undefined) return bad("expect_unlimited_needs_expect_spender");
      if (o.expect_amount !== undefined)
        return bad("expect_unlimited_conflicts_with_expect_amount");
      o.expect_unlimited = true;
    }
  }
  const lists = [
    ["allow_inner_call", /^0x[0-9a-fA-F]{40}:0x[0-9a-fA-F]{8}$/],
    ["allow_delegatecall", PRESIGN_ADDR],
  ] as const;
  for (const [k, re] of lists) {
    const v = i[k];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v) || v.length > 64 || v.some((x) => typeof x !== "string"))
      return bad(`${k}_must_be_string_array`);
    o[k] = (v as string[]).map((x) => (re.test(x.trim()) ? x.trim() : bad(`bad_${k}`)));
  }
  return o;
}

export function evmChain(v: unknown): number {
  if (typeof v !== "string" && typeof v !== "number") return bad("missing_chainId");
  let id: number;
  try {
    id = chainOf(v);
  } catch {
    return bad("unsupported_chain");
  }
  return EVM_IDS.includes(id) ? id : bad("not_an_evm_chain");
}
export const needAddress = (v: unknown, k = "address"): string =>
  typeof v === "string" && ADDR.test(v.trim()) ? v.trim().toLowerCase() : bad(`bad_${k}`);

/**
 * GET a JSON document from a fixed host. Redirects are errors, the body is read with a byte cap, the whole call has a
 * timeout. Error text names the host and status only (the URL may carry an API key).
 */
export async function safeJson(
  f: F,
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
) {
  const u = new URL(url);
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname)) bad("host_not_allowed");
  const max = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  let r: Response;
  try {
    r = await f(url, {
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS),
    });
  } catch {
    return bad(`fetch_failed:${u.hostname}`, 502);
  }
  if (r.status === 404) return null;
  if (!r.ok) return bad(`upstream_${r.status}:${u.hostname}`, 502);
  if (Number(r.headers.get("content-length") ?? 0) > max) bad("upstream_too_large", 502);
  const reader = r.body?.getReader();
  if (!reader) return bad("upstream_empty", 502);
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return bad("upstream_too_large", 502);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(buf)) as unknown;
  } catch {
    return bad("upstream_bad_json", 502);
  }
}

/** Validates ABI JSON (array of items, or {abi:[...]}) and returns the item list. */
export function parseAbi(v: unknown): AbiItem[] {
  let x = v;
  if (typeof x === "string") {
    if (x.length > MAX_ABI_CHARS) bad("abi_too_large");
    try {
      x = JSON.parse(x);
    } catch {
      return bad("bad_abi");
    }
  }
  if (
    x &&
    typeof x === "object" &&
    !Array.isArray(x) &&
    Array.isArray((x as { abi?: unknown }).abi)
  )
    x = (x as { abi: unknown }).abi;
  if (!Array.isArray(x) || x.length > 2_000) return bad("bad_abi");
  for (const i of x) if (!i || typeof i !== "object" || typeof i.type !== "string") bad("bad_abi");
  return x as AbiItem[];
}

/** Canonical Solidity type string of one ABI parameter (tuples expanded). String formatting only, no hashing. */
export function canonicalType(p: AbiParam): string {
  if (p.type.startsWith("tuple")) {
    const suffix = p.type.slice("tuple".length);
    return `(${(p.components ?? []).map(canonicalType).join(",")})${suffix}`;
  }
  return p.type;
}
const params = (ps: AbiParam[] | undefined, pre = "arg") =>
  (ps ?? []).map((p, i) => ({
    name: p.name || `${pre}${i}`,
    type: canonicalType(p),
    ...(p.components ? { components: p.components } : {}),
  }));

/** Every function in the ABI, with blocktools' selector and signature. Overloads are distinct by signature. */
export function listFunctions(abi: AbiItem[]): ContractFn[] {
  const fns = abi.filter((i) => i.type === "function" && i.name);
  if (!fns.length) return [];
  const insp = JSON.parse(w().evmAbiInspect(JSON.stringify(fns))) as {
    status?: string;
    items?: { kind: string; signature: string; selector: string }[];
  };
  if (insp.status !== "ok") bad("bad_abi");
  const sel = new Map(
    (insp.items ?? []).filter((i) => i.kind === "function").map((i) => [i.signature, i.selector]),
  );
  const out: ContractFn[] = [];
  for (const f of fns) {
    const inputs = params(f.inputs);
    const signature = `${f.name}(${inputs.map((p) => p.type).join(",")})`;
    const selector = sel.get(signature);
    if (!selector) continue;
    const sm = f.stateMutability ?? "nonpayable";
    out.push({
      name: f.name!,
      signature,
      selector,
      stateMutability: sm,
      kind: sm === "view" || sm === "pure" ? "read" : "write",
      payable: sm === "payable",
      inputs,
      outputs: params(f.outputs, "out"),
    });
  }
  return out;
}

export type AbiSource = "sourcify" | "etherscan" | "pasted";
export type AbiInfo = {
  chainId: number;
  chain: string;
  address: string;
  isContract: boolean;
  proxy: ProxyInfo | null;
  abiSource: AbiSource | null;
  abiOf: string | null;
  verifiedName: string | null;
  warnings: string[];
  functions: ContractFn[];
  abi: AbiItem[] | null;
};

async function sourcifyAbi(f: F, chainId: number, a: string) {
  const j = (await safeJson(
    f,
    `https://sourcify.dev/server/v2/contract/${chainId}/${a}?fields=abi,compilation`,
  )) as {
    abi?: unknown;
    compilation?: { name?: string };
  } | null;
  if (!j || !Array.isArray(j.abi)) return null;
  return { abi: parseAbi(j.abi), name: j.compilation?.name ?? null };
}
async function etherscanAbi(f: F, env: NodeJS.ProcessEnv, chainId: number, a: string) {
  const key = env.ETHERSCAN_API_KEY;
  if (!key) return null;
  const q = new URLSearchParams({
    chainid: String(chainId),
    module: "contract",
    action: "getabi",
    address: a,
    apikey: key,
  });
  const j = (await safeJson(f, `https://api.etherscan.io/v2/api?${q}`)) as {
    status?: string;
    result?: unknown;
  } | null;
  if (!j || j.status !== "1" || typeof j.result !== "string") return null;
  return { abi: parseAbi(j.result), name: null };
}
/** Sourcify, then Etherscan V2 (key only). Upstream failures fall through to the next source. */
async function fetchAbi(f: F, env: NodeJS.ProcessEnv, chainId: number, a: string) {
  const s = await sourcifyAbi(f, chainId, a).catch(() => null);
  if (s) return { ...s, source: "sourcify" as const };
  const e = await etherscanAbi(f, env, chainId, a).catch(() => null);
  if (e) return { ...e, source: "etherscan" as const };
  return null;
}

/** An address in the low 20 bytes of a 32-byte word, or null (zero, malformed, or high bytes set). */
const wordAddr = (v: unknown): string | null => {
  const s = String(v);
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(s) || BigInt(s) === 0n) return null;
  const hex = s.slice(2).padStart(64, "0");
  if (!/^0{24}/.test(hex)) return null;
  return `0x${hex.slice(24)}`;
};
const slotAddr = async (rpc: Rpc, a: string, slot: string) =>
  wordAddr(await rpc("eth_getStorageAt", [a, slot, "latest"]));
/** implementation() on `a`; only an exact 32-byte address word counts. */
const callImpl = async (rpc: Rpc, a: string) => {
  const r = String(await rpc("eth_call", [{ to: a, data: IMPLEMENTATION_SELECTOR }, "latest"]));
  return r.length === 66 ? wordAddr(r) : null;
};
const hasCode = async (rpc: Rpc, a: string) => {
  const c = String(await rpc("eth_getCode", [a, "latest"]));
  return c !== "0x" && c !== "";
};

/** EIP-1967 implementation address from the proxy slot, or null. */
export async function eip1967Impl(rpc: Rpc, a: string): Promise<string | null> {
  return slotAddr(rpc, a, EIP1967_IMPL_SLOT);
}

/**
 * Storage-slot proxies, in order: EIP-1967 implementation, EIP-1967 beacon (then the beacon's implementation()),
 * OpenZeppelin legacy (zos), EIP-1822. A failed read counts as "not this kind".
 */
export async function detectSlotProxy(rpc: Rpc, a: string): Promise<ProxyInfo | null> {
  const q = (s: string) => slotAddr(rpc, a, s).catch(() => null);
  const i1967 = await q(EIP1967_IMPL_SLOT);
  if (i1967) return { kind: "EIP-1967", implementation: i1967 };
  const beacon = await q(EIP1967_BEACON_SLOT);
  if (beacon) {
    const bi = await callImpl(rpc, beacon).catch(() => null);
    if (bi) return { kind: "EIP-1967 beacon", implementation: bi, beacon };
  }
  const zos = await q(ZEPPELINOS_IMPL_SLOT);
  if (zos) return { kind: "OpenZeppelin legacy", implementation: zos };
  const uups = await q(EIP1822_PROXIABLE_SLOT);
  if (uups) return { kind: "EIP-1822", implementation: uups };
  return null;
}

/** EIP-897 fallback: implementation() on the address, returning another address that has code. */
export async function eip897Impl(rpc: Rpc, a: string): Promise<string | null> {
  const i = await callImpl(rpc, a).catch(() => null);
  if (!i || i === a) return null;
  return (await hasCode(rpc, i).catch(() => false)) ? i : null;
}
const hasImplFn = (abi: AbiItem[]) =>
  abi.some((x) => x.type === "function" && x.name === "implementation" && !x.inputs?.length);
const proxyWarning = (p: ProxyInfo) =>
  p.kind === "EIP-1967"
    ? `This is an EIP-1967 proxy. Functions shown are the implementation's (${p.implementation}); calls go to the proxy address, and the owner can change the implementation.`
    : `This is a proxy (${p.kind}${p.beacon ? `, beacon ${p.beacon}` : ""}). Functions shown are the implementation's (${p.implementation}); calls go to the proxy address, and the owner can change the implementation.`;

export function rpcOf(chainId: number, env: NodeJS.ProcessEnv): Rpc {
  const c = evmClient(chainId, env);
  const ok = new Set(["eth_call", "eth_getStorageAt", "eth_getCode", "eth_getTransactionCount"]);
  return (method, p) => {
    if (!ok.has(method)) return bad("not_a_read_method");
    return (c.request as (a: { method: string; params: unknown[] }) => Promise<unknown>)({
      method,
      params: p,
    });
  };
}

type CacheEntry = { at: number; ttl: number; v: Awaited<ReturnType<typeof fetchAbi>> };
export type Deps = {
  f: F;
  env: NodeJS.ProcessEnv;
  rpc?: (chainId: number) => Rpc;
  now?: () => number;
};

export function contractTool(d: Deps) {
  const now = d.now ?? Date.now;
  const rpc = d.rpc ?? ((id: number) => rpcOf(id, d.env));
  const cache = new Map<string, CacheEntry>();
  let inFlight = 0;
  const cached = async (chainId: number, a: string) => {
    const k = `${chainId}:${a}`;
    const hit = cache.get(k);
    if (hit && now() - hit.at < hit.ttl) return hit.v;
    const v = await fetchAbi(d.f, d.env, chainId, a);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(k, { at: now(), ttl: v ? CACHE_TTL_MS : MISS_TTL_MS, v });
    return v;
  };

  async function abiInfo(i: {
    chainId: unknown;
    address: unknown;
    abi?: unknown;
  }): Promise<AbiInfo> {
    const chainId = evmChain(i.chainId);
    const address = needAddress(i.address);
    const r = rpc(chainId);
    const code = String(
      await r("eth_getCode", [address, "latest"]).catch(() => bad("rpc_failed", 502)),
    );
    const isContract = code !== "0x" && code !== "";
    let proxy = isContract ? await detectSlotProxy(r, address) : null;
    const warnings: string[] = [];
    if (!isContract) warnings.push("No contract code at this address on this chain.");
    let abi: AbiItem[] | null = null;
    let source: AbiSource | null = null;
    let abiOf: string | null = null;
    let name: string | null = null;
    if (i.abi !== undefined && i.abi !== null && i.abi !== "") {
      abi = parseAbi(i.abi);
      source = "pasted";
      abiOf = address;
      warnings.push(
        "You pasted this ABI. SwapChan did not check it against the contract's source.",
      );
    } else {
      let implGot = proxy ? await cached(chainId, proxy.implementation) : null;
      const own = !implGot && isContract ? await cached(chainId, address) : null;
      // EIP-897 only when no slot proxy was found and the address's own ABI is missing or has implementation().
      if (!proxy && isContract && (!own || hasImplFn(own.abi))) {
        const i897 = await eip897Impl(r, address);
        if (i897) {
          proxy = { kind: "EIP-897", implementation: i897 };
          implGot = await cached(chainId, i897);
        }
      }
      const got = implGot ?? own;
      if (got) {
        abi = got.abi;
        source = got.source;
        name = got.name;
        abiOf = implGot && proxy ? proxy.implementation : address;
        warnings.push(
          `ABI from ${source === "sourcify" ? "Sourcify" : "Etherscan"}, a third party. SwapChan does not audit the contract; check it before you send anything.`,
        );
      } else if (isContract)
        warnings.push(
          "No verified ABI found on Sourcify or Etherscan. Paste the ABI to use this contract.",
        );
    }
    // Display form: EIP-55 checksummed, never lowercase (lookups above keep the raw form).
    if (proxy)
      proxy = {
        ...proxy,
        implementation: fullAddress(proxy.implementation),
        ...(proxy.beacon ? { beacon: fullAddress(proxy.beacon) } : {}),
      };
    if (abiOf && abiOf !== address) abiOf = fullAddress(abiOf);
    if (proxy) warnings.push(proxyWarning(proxy));
    return {
      chainId,
      chain: chainName(chainId),
      address,
      isContract,
      proxy,
      abiSource: source,
      abiOf,
      verifiedName: name,
      warnings,
      functions: abi ? listFunctions(abi) : [],
      abi,
    };
  }

  const pickFn = (fns: ContractFn[], sel: unknown): ContractFn => {
    if (typeof sel !== "string" || !sel.trim() || sel.length > 512) return bad("missing_function");
    const s = sel.replace(/\s+/g, "");
    if (SIG.test(s)) return fns.find((f) => f.signature === s) ?? bad("function_not_in_abi");
    const byName = fns.filter((f) => f.name === s);
    if (byName.length > 1) bad("overloaded_function_use_signature");
    return byName[0] ?? bad("function_not_in_abi");
  };

  /** Arguments as a list; each string is passed as typed, JSON for arrays/tuples, true/false for bool. */
  const shapeArgs = (fn: ContractFn, v: unknown): unknown[] => {
    let a = v ?? [];
    if (typeof a === "string") {
      try {
        a = a.trim() ? JSON.parse(a) : [];
      } catch {
        return bad("bad_args");
      }
    }
    if (!Array.isArray(a) || a.length > MAX_ARGS) return bad("bad_args");
    if (a.length !== fn.inputs.length) bad("wrong_arg_count");
    if (JSON.stringify(a).length > MAX_ARG_CHARS * 4) bad("args_too_large");
    return a.map((x, k) => {
      const t = fn.inputs[k]!.type;
      if (typeof x === "string") {
        if (x.length > MAX_ARG_CHARS) bad("arg_too_large");
        const s = x.trim();
        if (t === "bool") return s === "true" ? true : s === "false" ? false : bad(`bad_arg_${k}`);
        if (t.endsWith("]") || t.startsWith("(")) {
          try {
            return JSON.parse(s);
          } catch {
            return bad(`bad_arg_${k}`);
          }
        }
        return s;
      }
      return x;
    });
  };

  const encode = (fn: ContractFn, args: unknown[]) => {
    const e = JSON.parse(w().evmAbiEncode(JSON.stringify({ sig: fn.signature, args }))) as {
      status?: string;
      data?: string;
      error?: string;
    };
    if (e.status !== "ok" || !e.data) bad("encode_failed");
    return e.data!;
  };

  /** Wei as a decimal string; nonzero only for payable targets. */
  const valueOf = (payable: boolean, v: unknown): string => {
    if (v === undefined || v === null || v === "" || v === "0") return "0";
    if (typeof v !== "string" || !/^\d{1,78}$/.test(v)) return bad("bad_value");
    if (BigInt(v) === 0n) return "0";
    if (!payable) bad("value_on_non_payable");
    return BigInt(v).toString();
  };

  const resolve = async (i: Record<string, unknown>) => {
    const info = await abiInfo({ chainId: i.chainId, address: i.address, abi: i.abi });
    if (!info.abi) bad("no_abi", 404);
    return info;
  };

  async function read(i: Record<string, unknown>) {
    const info = await resolve(i);
    const fn = pickFn(info.functions, i.function ?? i.signature);
    if (fn.kind !== "read") bad("not_a_read_function");
    const data = encode(fn, shapeArgs(fn, i.args));
    if (inFlight >= MAX_CONCURRENT_READS) bad("busy_try_again", 503);
    inFlight++;
    let raw: string;
    try {
      raw = String(await rpc(info.chainId)("eth_call", [{ to: info.address, data }, "latest"]));
    } catch (e) {
      const m = String((e as Error)?.message ?? "");
      return {
        ok: false as const,
        error_code: /revert/i.test(m) ? "call_reverted" : "rpc_failed",
        function: fn.signature,
        calldata: data,
      };
    } finally {
      inFlight--;
    }
    if (!/^0x[0-9a-fA-F]*$/.test(raw))
      return {
        ok: false as const,
        error_code: "bad_rpc_result",
        function: fn.signature,
        calldata: data,
      };
    if (raw === "0x" && fn.outputs.length)
      return {
        ok: false as const,
        error_code: "empty_result",
        function: fn.signature,
        calldata: data,
      };
    const types = `(${fn.outputs.map((o) => o.type).join(",")})`;
    const dec = JSON.parse(
      w().evmAbiDecode(
        JSON.stringify({ input: raw, types, allow_trailing: true, allow_gaps: true }),
      ),
    ) as {
      status?: string;
      args?: { type: string; value: unknown }[];
    };
    if (dec.status !== "ok" || !Array.isArray(dec.args))
      return {
        ok: false as const,
        error_code: "decode_failed",
        function: fn.signature,
        calldata: data,
        raw,
      };
    return {
      ok: true as const,
      chainId: info.chainId,
      address: info.address,
      function: fn.signature,
      calldata: data,
      raw,
      result: dec.args.map((a, k) => ({
        name: fn.outputs[k]?.name ?? `out${k}`,
        type: a.type,
        value: a.value,
      })),
    };
  }

  /** Build calldata for any function (read or write). Nothing is signed or sent. */
  async function encodeCall(i: Record<string, unknown>) {
    const info = await resolve(i);
    const fn = pickFn(info.functions, i.function ?? i.signature);
    const data = encode(fn, shapeArgs(fn, i.args));
    const value = valueOf(fn.payable, i.value);
    const decoded = JSON.parse(
      w().evmAbiDecode(JSON.stringify({ input: data, abi: JSON.stringify(info.abi) })),
    ) as {
      status?: string;
      signature?: string;
      args?: unknown[];
    };
    if (decoded.status !== "ok" || decoded.signature !== fn.signature)
      bad("decode_check_failed", 500);
    return {
      ok: true as const,
      chainId: info.chainId,
      chain: info.chain,
      to: info.address,
      function: fn.signature,
      stateMutability: fn.stateMutability,
      value,
      data,
      decoded: { signature: decoded.signature, args: decoded.args },
      proxy: info.proxy,
      abiSource: info.abiSource,
      warnings: info.warnings,
      note: "Unsigned call data only. SwapChan never signs or sends; your own wallet does.",
    };
  }

  /**
   * Pre-signing verdict for a write call. Encodes the call, re-encodes it with the full ABI and the exact signature,
   * builds an unsigned tx (placeholder nonce/gas/gas price; the wallet sets real ones), approves the calldata against
   * the ABI (evmApproveCall) and checks the unsigned tx with verifyTx and the ABI. Any failed step makes it "fail".
   */
  async function approveCall(i: Record<string, unknown>) {
    const presign = presignOptions(i);
    const info = await resolve(i);
    const fn = pickFn(info.functions, i.function ?? i.signature);
    const args = shapeArgs(fn, i.args);
    const data = encode(fn, args);
    const value = valueOf(fn.payable, i.value);
    const reasons: string[] = [];
    const re = wcall(() =>
      w().evmAbiEncode(
        JSON.stringify({ abi: info.abi, name: fn.name, args, signature: fn.signature }),
      ),
    );
    if (!re.ok) reasons.push(`abi_encode_failed:${re.code}`);
    else if (String(re.v.data).toLowerCase() !== data.toLowerCase())
      reasons.push("reencode_mismatch");
    const built = wcall(() =>
      w().buildEvmTransfer(
        JSON.stringify({
          chainId: info.chainId,
          nonce: PLACEHOLDER.nonce,
          gas: PLACEHOLDER.gas,
          gasPrice: PLACEHOLDER.gasPrice,
          to: info.address,
          value,
          data,
        }),
      ),
    );
    if (!built.ok) reasons.push(`build_failed:${built.code}`);
    else {
      if (String(built.v.data).toLowerCase() !== data.toLowerCase())
        reasons.push("built_data_mismatch");
      if (String(built.v.to).toLowerCase() !== info.address) reasons.push("built_target_mismatch");
      if (String(built.v.value) !== value) reasons.push("built_value_mismatch");
    }
    const ap = wcall(() =>
      w().evmApproveCall(JSON.stringify({ to: info.address, data, abi: info.abi })),
    );
    if (!ap.ok) reasons.push(`approve_failed:${ap.code}`);
    else if (ap.v.status !== "ok") reasons.push(`approve_${String(ap.v.status)}`);
    else if (ap.v.signature !== fn.signature) reasons.push("approve_signature_mismatch");
    const verify = built.ok
      ? check(
          reasons,
          String(built.v.unsigned),
          // the contract, plus any address the user typed as an argument (verifyTx reads a token transfer's
          // recipient from the calldata and checks it against this list)
          [
            info.address,
            ...fn.inputs
              .map((p, k) => (p.type === "address" ? String(args[k]).toLowerCase() : ""))
              .filter((x) => /^0x[0-9a-f]{40}$/.test(x)),
          ],
          info.chainId,
          null,
          JSON.stringify({ abi: info.abi, ...presign }),
        )
      : null;
    return {
      ok: true as const,
      verdict: reasons.length ? ("fail" as const) : ("pass" as const),
      reasons,
      chainId: info.chainId,
      chain: info.chain,
      to: info.address,
      function: fn.signature,
      selector: fn.selector,
      value,
      data,
      approve: ap.ok ? ap.v : null,
      verify,
      placeholders: PLACEHOLDER_NOTE,
      proxy: info.proxy,
      abiSource: info.abiSource,
      warnings: info.warnings,
      note: "Checks only. SwapChan never signs or sends; your own wallet does, and it sets the real nonce, gas and gas price.",
    };
  }

  /**
   * Unsigned contract creation. Initcode = bytecode + ABI-encoded constructor args. blocktools builds the creation
   * (buildEvmTransfer create), returns initcode_keccak256, and approves the initcode against that hash (or one the
   * caller pins). With `from`, the predicted address uses that account's pending nonce (eth_getTransactionCount).
   */
  async function buildCreation(i: Record<string, unknown>) {
    const chainId = evmChain(i.chainId);
    if (typeof i.bytecode !== "string") return bad("missing_bytecode");
    if (i.bytecode.length > MAX_INITCODE_BYTES * 2 + 512) return bad("initcode_too_large");
    const code = i.bytecode.replace(/\s+/g, "").replace(/^0x/i, "");
    if (!code) bad("missing_bytecode");
    if (!/^[0-9a-fA-F]*$/.test(code) || code.length % 2) bad("bad_bytecode");
    let ctor: AbiItem | undefined;
    if (i.abi !== undefined && i.abi !== null && i.abi !== "")
      ctor = parseAbi(i.abi).find((x) => x.type === "constructor");
    const inputs = params(ctor?.inputs);
    const payable = ctor?.stateMutability === "payable";
    let args: unknown = i.args ?? [];
    if (typeof args === "string") {
      try {
        args = args.trim() ? JSON.parse(args) : [];
      } catch {
        return bad("bad_args");
      }
    }
    if (!Array.isArray(args) || args.length > MAX_ARGS) return bad("bad_args");
    if (args.length !== inputs.length) bad("wrong_arg_count");
    if (JSON.stringify(args).length > MAX_ARG_CHARS * 4) bad("args_too_large");
    const shaped = shapeArgs(
      {
        name: "constructor",
        signature: "",
        selector: "",
        stateMutability: "",
        kind: "write",
        payable,
        inputs,
        outputs: [],
      },
      args,
    );
    let ctorData = "";
    if (inputs.length) {
      const e = wcall(() =>
        w().evmAbiEncode(
          JSON.stringify({ sig: `(${inputs.map((p) => p.type).join(",")})`, args: shaped }),
        ),
      );
      if (!e.ok || e.v.status !== "ok" || typeof e.v.data !== "string") return bad("encode_failed");
      ctorData = (e.v.data as string).replace(/^0x/, "");
    }
    const initcode = `0x${code.toLowerCase()}${ctorData.toLowerCase()}`;
    const bytes = (initcode.length - 2) / 2;
    if (bytes > MAX_INITCODE_BYTES) bad("initcode_too_large");
    let value = "0";
    if (i.value !== undefined && i.value !== null && i.value !== "" && i.value !== "0") {
      if (!ctor) bad("value_needs_constructor_abi");
      value = valueOf(payable, i.value);
    }
    let pinned: string | null = null;
    if (i.createHash !== undefined && i.createHash !== null && i.createHash !== "") {
      if (typeof i.createHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(i.createHash))
        return bad("bad_createHash");
      pinned = i.createHash.toLowerCase();
    }
    const from =
      i.from === undefined || i.from === null || i.from === "" ? null : needAddress(i.from, "from");
    const reasons: string[] = [];
    const built = wcall(() =>
      w().buildEvmTransfer(
        JSON.stringify({
          chainId,
          nonce: PLACEHOLDER.nonce,
          gas: PLACEHOLDER.createGas,
          gasPrice: PLACEHOLDER.gasPrice,
          create: initcode,
          value,
        }),
      ),
    );
    if (!built.ok) return bad(`build_failed:${built.code}`);
    const hash = String(built.v.initcode_keccak256 ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hash)) bad("build_failed:no_initcode_hash", 500);
    if (built.v.to !== null && built.v.to !== undefined) reasons.push("built_not_a_creation");
    if (String(built.v.data).toLowerCase() !== initcode) reasons.push("built_data_mismatch");
    if (String(built.v.value) !== value) reasons.push("built_value_mismatch");
    const createHash = pinned ?? hash;
    const ap = wcall(() =>
      w().evmApproveCall(JSON.stringify({ to: null, data: initcode, createHash })),
    );
    if (!ap.ok) reasons.push(`approve_failed:${ap.code}`);
    else if (ap.v.status !== "ok") reasons.push(`approve_${String(ap.v.status)}`);
    const verify = check(reasons, String(built.v.unsigned), [], chainId, createHash, null);
    const warnings = [
      "Contract creation is irreversible: once mined, the new contract's code cannot be changed or removed by SwapChan.",
      "SwapChan has not verified this bytecode. Deploy only code you compiled yourself or trust.",
      value === "0"
        ? "This creation sends no native coin (value 0)."
        : `This creation sends ${value} wei of the chain's native coin to the new contract.`,
    ];
    let predicted: { address: string; deployer: string; nonce: string } | null = null;
    if (from) {
      try {
        const n = String(await rpc(chainId)("eth_getTransactionCount", [from, "pending"]));
        if (!/^0x[0-9a-fA-F]{1,16}$/.test(n)) throw new Error("bad_nonce");
        const ca = JSON.parse(
          w().evmCreateAddress(JSON.stringify({ deployer: from, nonce: n })),
        ) as { status?: string; address?: string };
        if (ca.status !== "ok" || !ca.address) throw new Error("create_address_failed");
        predicted = { address: ca.address, deployer: from, nonce: BigInt(n).toString() };
        warnings.push(
          `Predicted address assumes this is the next transaction from ${from} (nonce ${predicted.nonce}). Any other transaction from that account first changes it.`,
        );
      } catch {
        warnings.push("Could not read the deployer's nonce, so there is no predicted address.");
      }
    }
    return {
      ok: true as const,
      verdict: reasons.length ? ("fail" as const) : ("pass" as const),
      reasons,
      chainId,
      chain: chainName(chainId),
      to: null,
      value,
      data: initcode,
      initcode_bytes: bytes,
      initcode_keccak256: hash,
      createHash,
      constructor: ctor ? { inputs, payable } : null,
      approve: ap.ok ? ap.v : null,
      verify,
      predicted,
      placeholders: PLACEHOLDER_NOTE,
      warnings,
      note: "Unsigned creation only. SwapChan never signs or sends; your own wallet does, and it sets the real nonce, gas and gas price.",
    };
  }

  return { abiInfo, read, encodeCall, approveCall, buildCreation };
}

const PLACEHOLDER_NOTE =
  "The checked unsigned tx uses placeholder nonce 0, gas and a 1 gwei gas price; your wallet sets the real ones.";
/** A blocktools call returning JSON; a throw becomes {ok:false, code}. */
function wcall(
  f: () => string,
): { ok: true; v: Record<string, unknown> } | { ok: false; code: string } {
  let raw: string;
  try {
    raw = f();
  } catch (e) {
    if (e instanceof ContractError) throw e;
    return { ok: false, code: String(e instanceof Error ? e.message : e).slice(0, 120) };
  }
  try {
    return { ok: true, v: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    return { ok: false, code: "bad_json" };
  }
}
/** verifyTx on the check-only unsigned tx (chain "eth" with the real chainId); failures go into reasons. */
function check(
  reasons: string[],
  unsigned: string,
  expectTo: string[],
  chainId: number,
  createHash: string | null,
  callJson: string | null,
) {
  const v = wcall(() =>
    w().verifyTx(
      unsigned,
      "eth",
      expectTo,
      [],
      chainId,
      "",
      false,
      null,
      createHash ? JSON.stringify({ createHash }) : callJson,
    ),
  );
  if (!v.ok) {
    reasons.push(`verify_failed:${v.code}`);
    return null;
  }
  const failures = Array.isArray(v.v.failures) ? (v.v.failures as string[]) : [];
  const warns = Array.isArray(v.v.warnings) ? (v.v.warnings as string[]) : [];
  // high_fee_pct compares the placeholder fee (not the wallet's real one) with the value, so on its own it is
  // reported, not blocking. Every other failure blocks.
  const feeOnly =
    v.v.ok !== true &&
    failures.length === 1 &&
    failures[0] === "has_warnings" &&
    warns.includes("high_fee_pct") &&
    warns.every((x) =>
      ["high_fee_pct", "unsigned", "unknown_calldata", "contract_creation"].includes(x),
    );
  if (v.v.ok !== true && !feeOnly)
    reasons.push(...(failures.length ? failures : ["not_ok"]).map((f) => `verify_${f}`));
  return {
    ok: v.v.ok === true || feeOnly,
    fee_vs_value_note: feeOnly
      ? "blocktools flagged a high fee relative to the value using the placeholder gas; check the real fee in your wallet."
      : null,
    failures,
    warnings: Array.isArray(v.v.warnings) ? (v.v.warnings as string[]) : [],
    check_these: typeof v.v.check_these === "string" ? v.v.check_these : null,
    call: v.v.call ?? null,
    approvals: Array.isArray(v.v.approvals) ? v.v.approvals : [],
    transfers: Array.isArray(v.v.transfers) ? v.v.transfers : [],
    inner_calls: Array.isArray(v.v.inner_calls) ? v.v.inner_calls : [],
  };
}

const strip = (x: AbiInfo) => {
  const { abi: _abi, ...rest } = x;
  return rest;
};

export function contractRoutes(d: Deps, opts: { perMinute?: number } = {}) {
  const t = contractTool(d);
  const now = d.now ?? Date.now;
  const limit = opts.perMinute ?? RATE_PER_MIN;
  const windows = new Map<string, { start: number; count: number }>();
  const r = new Hono();
  r.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    const ts = now();
    const who = clientOf((n) => c.req.header(n), socketAddressOf(c.env));
    let win = windows.get(who);
    if (!win || ts - win.start >= 60_000) {
      win = { start: ts, count: 0 };
      windows.set(who, win);
      if (windows.size > 50_000) windows.clear();
    }
    win.count++;
    c.header("x-ratelimit-limit", String(limit));
    c.header("x-ratelimit-remaining", String(Math.max(0, limit - win.count)));
    if (win.count > limit) {
      c.header("retry-after", String(Math.ceil((win.start + 60_000 - ts) / 1000)));
      return c.json({ ok: false, error_code: "rate_limited", error: "rate_limited" }, 429);
    }
    await next();
  });
  const body = async (c: {
    req: { header: (n: string) => string | undefined; text: () => Promise<string> };
  }) => {
    if (Number(c.req.header("content-length") ?? 0) > MAX_BODY) bad("body_too_large", 413);
    const raw = await c.req.text().catch(() => "");
    if (raw.length > MAX_BODY) bad("body_too_large", 413);
    try {
      const j = JSON.parse(raw) as unknown;
      return j && typeof j === "object" && !Array.isArray(j)
        ? (j as Record<string, unknown>)
        : bad("bad_json");
    } catch (e) {
      if (e instanceof ContractError) throw e;
      return bad("bad_json");
    }
  };
  const run = async (
    c: { json: (v: unknown, s?: number) => Response },
    fn: () => Promise<unknown>,
  ) => {
    try {
      return c.json(await fn());
    } catch (e) {
      if (e instanceof ContractError)
        return c.json({ ok: false, error_code: e.code, error: e.code }, e.status as 400);
      return c.json({ ok: false, error_code: "internal_error", error: "internal_error" }, 500);
    }
  };
  r.get("/abi", (c) =>
    run(c, async () => ({
      ok: true,
      ...strip(
        await t.abiInfo({ chainId: c.req.query("chainId"), address: c.req.query("address") }),
      ),
    })),
  );
  r.post("/abi", (c) =>
    run(c, async () => ({
      ok: true,
      ...strip(await t.abiInfo((await body(c)) as Parameters<typeof t.abiInfo>[0])),
    })),
  );
  r.post("/read", (c) =>
    run(c, async () => {
      const out = await t.read(await body(c));
      return out;
    }),
  );
  r.post("/encode", (c) => run(c, async () => t.encodeCall(await body(c))));
  r.post("/approve", (c) => run(c, async () => t.approveCall(await body(c))));
  r.post("/create", (c) => run(c, async () => t.buildCreation(await body(c))));
  return r;
}
