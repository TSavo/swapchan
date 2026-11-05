import { Hono } from "hono";
import { blocktools } from "./blocktools.js";
import { socketAddressOf, trustedClientIp } from "./clientip.js";

/**
 * Public developer & chain tools (swapchan.com/tools/<slug>, MCP address_tool / xpub_addresses / solana_address /
 * substrate_tool / chain_params): pure blocktools WASM calls on PUBLIC input only (addresses, xpubs, SS58, PDA
 * seeds, hashes, chain params). Nothing is fetched or stored.
 *
 * Safety rules (tested in devtools.test.ts):
 * - never log request bodies, inputs or outputs (this file has no console calls; errors return a code only);
 * - body capped at MAX_BODY bytes; per-client fixed-window rate limit;
 * - anything that looks like a secret (xprv/WIF/seed words/secret-named fields) is refused before any call;
 * - no raw signed-tx decode/verify here: that input never leaves the browser (waits for the web WASM build).
 *   tron-tx takes UNSIGNED raw_data only and refuses a tx that carries signatures (signed_tx_refused).
 */
export const MAX_BODY = 4096;
/** Tools whose public input is naturally larger (contract bytecode, EIP-712 documents, ABIs). */
/**
 * typed_data cap for typed-data-verify. Measured: a Seaport 1.6 BulkOrder at tree height 7 (128 leaves) is
 * ~49 KB compact with padding leaves and ~200 KB pretty-printed with every leaf a real order; height 8 padded is
 * ~97 KB compact. Height 9+ (192 KB+ compact even when padded) is rejected as too_long_typed_data.
 * Measured on Battleaxe: a padded height-7 tree takes ~15 ms for three checks in the tests; the 30/min rate limit still applies.
 */
export const TYPED_DATA_MAX = 262_144;
export const BIG_BODY: Record<string, number> = {
  "bytecode-inspect": 60_000,
  // typed_data usually arrives as a JSON string inside the body, so quotes and newlines are escaped (~2x).
  "typed-data-verify": TYPED_DATA_MAX * 2 + 8_192,
  "evm-abi": 16_384,
  "tx-combine": 60_000,
  "tx-plan-resolve": 32_768,
};
export const bodyLimit = (fn: string) => (Object.hasOwn(BIG_BODY, fn) ? BIG_BODY[fn]! : MAX_BODY);
export const RATE_PER_MIN = 30;
const MAX_STR = 1024;

export class ToolError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const bad = (code: string): never => {
  throw new ToolError(code);
};

/** Extended private keys (any SLIP-132 prefix), WIF private keys, BIP39-like word lists, raw 32-byte keys by field name. */
const PRIV_EXT = /\b[xtyzuvYZUV]prv[1-9A-HJ-NP-Za-km-z]{20,}/;
const WIF = /^(5[HJK][1-9A-HJ-NP-Za-km-z]{49}|[KLc9][1-9A-HJ-NP-Za-km-z]{50,51})$/;
const SEEDLIKE = /^\s*([a-z]{3,8}\s+){11,23}[a-z]{3,8}\s*$/;
const SECRET_KEY = /priv|secret|seed|mnemonic|wif|password|passphrase|keystore|xprv/i;

/** Throws secret_input_refused when any key or string value looks like private key material. */
export function refuseSecrets(v: unknown, depth = 0): void {
  if (depth > 4) bad("too_deep");
  if (typeof v === "string") {
    if (PRIV_EXT.test(v) || WIF.test(v.trim()) || SEEDLIKE.test(v)) bad("secret_input_refused");
    return;
  }
  if (Array.isArray(v)) return v.forEach((x) => refuseSecrets(x, depth + 1));
  if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      // "seeds" = public Solana PDA seed bytes, not a wallet seed
      if (k !== "seeds" && SECRET_KEY.test(k)) bad("secret_input_refused");
      refuseSecrets(x, depth + 1);
    }
}

type In = Record<string, unknown>;
const str = (i: In, k: string, re?: RegExp, max = MAX_STR): string => {
  const v = i[k];
  if (typeof v !== "string" || !v.trim()) return bad(`missing_${k}`);
  const s = v.trim();
  if (s.length > max) return bad(`too_long_${k}`);
  if (re && !re.test(s)) return bad(`bad_${k}`);
  return s;
};
const optStr = (i: In, k: string, re?: RegExp, max = MAX_STR) =>
  i[k] === undefined || i[k] === "" ? undefined : str(i, k, re, max);
/** A JSON document given either as an object or as JSON text (pasted into a page). */
const doc = (i: In, k: string, max: number): string => {
  const v = i[k];
  if (v && typeof v === "object") {
    const t = JSON.stringify(v);
    return t.length > max ? bad(`too_long_${k}`) : t;
  }
  const t = str(i, k, undefined, max);
  try {
    JSON.parse(t);
  } catch {
    bad(`bad_${k}`);
  }
  return t;
};
const int = (i: In, k: string, def: number, min: number, max: number): number => {
  const v = i[k] ?? def;
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) return bad(`bad_${k}`);
  return n;
};
const CHAIN = /^[a-z0-9]{2,8}$/;
const HEX = /^(0x)?([0-9a-fA-F]{2})*$/;
const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
/** ABI args: a JSON array, or JSON array text from a page field. */
const args = (i: In): unknown[] => {
  const v = i.args ?? [];
  const a = typeof v === "string" ? (v.trim() ? (json(v) as unknown) : []) : v;
  if (!Array.isArray(a) || a.length > 64) return bad("bad_args");
  return a;
};
/** Public keys for a multisig: compressed (66 hex) or x-only (64 hex), 1-20 of them, order kept. */
const pubkeys = (i: In): string[] => {
  const v = i.pubkeys;
  if (!Array.isArray(v) || v.length < 1 || v.length > 20) return bad("bad_pubkeys");
  return v.map((k) =>
    typeof k === "string" && /^([0-9a-fA-F]{64}|0[23][0-9a-fA-F]{64})$/.test(k.trim())
      ? k.trim()
      : bad("bad_pubkeys"),
  );
};
const NETWORK = /^(bitcoin|testnet|signet|regtest)$/;
const unhex = (s: string) => s.replace(/^0x/, "");
const json = (s: string) => JSON.parse(s) as unknown;

/** blocktools error text -> short machine code (never echoes the input). */
export const errCode = (e: unknown): string =>
  e instanceof ToolError
    ? e.code
    : (
        String((e as Error)?.message ?? e)
          .toLowerCase()
          .replace(/[^a-z0-9_:]+/g, "_")
          .replace(/^_+|_+$/g, "")
          .slice(0, 48) || "invalid_input"
      ).replace(/^error_/, "");

export const XPUB_KINDS = ["p2pkh", "p2wpkh", "p2sh-p2wpkh", "p2tr"] as const;

/** Tool name -> pure function of public input. Names match the /tools/<slug> pages. */
export const DEV_TOOLS: Record<string, (i: In) => unknown> = {
  "detect-address": (i) => ({
    chains: json(w().detectAddress(str(i, "address"))),
  }),
  "validate-address": (i) => {
    const chain = str(i, "chain", CHAIN);
    try {
      return { chain, valid: true, kind: w().addressValidate(chain, str(i, "address")) };
    } catch (e) {
      return { chain, valid: false, reason: errCode(e) };
    }
  },
  "convert-address": (i) => {
    const address = str(i, "address");
    const to = str(i, "to", CHAIN);
    const from = optStr(i, "from", CHAIN);
    return {
      to,
      address: from ? w().convertAddressFrom(from, address, to) : w().convertAddress(address, to),
    };
  },
  cashaddr: (i) => {
    const op = str(i, "op", /^(to_legacy|to_cashaddr|decode|encode)$/);
    if (op === "encode")
      return {
        cashaddr: w().cashAddrEncode(
          optStr(i, "prefix", /^[a-z]{1,16}$/) ?? "bitcoincash",
          str(i, "kind", /^(p2pkh|p2sh)$/),
          unhex(str(i, "hash", /^(0x)?([0-9a-fA-F]{2}){20,64}$/)),
        ),
      };
    const address = str(i, "address");
    if (op === "to_legacy") return { legacy: w().cashAddrToLegacy(address) };
    if (op === "decode") return json(w().cashAddrDecode(address));
    const prefix = optStr(i, "prefix", /^[a-z]{1,16}$/) ?? "bitcoincash";
    return { cashaddr: w().legacyToCashAddr(address, prefix) };
  },
  "address-script": (i) => {
    const op = str(i, "op", /^(to_script|from_script)$/);
    const chain = str(i, "chain", CHAIN);
    if (op === "from_script")
      return json(w().scriptToAddress(chain, unhex(str(i, "script", HEX)))) ?? { address: null };
    const address = str(i, "address");
    // Zcash t-addresses and all-uppercase bech32 are handled by the vendored wasm (blocktools 0b48cd3; tested)
    return { script: w().addressToScript(chain, address) };
  },
  "xpub-addresses": (i) => {
    const chain = str(i, "chain", CHAIN);
    const xpub = str(i, "xpub", /^[1-9A-HJ-NP-Za-km-z]{100,120}$/);
    const kind = optStr(i, "kind") ?? "p2pkh";
    if (!(XPUB_KINDS as readonly string[]).includes(kind)) bad("bad_kind");
    const branch = int(i, "branch", 0, 0, 1);
    const start = int(i, "start", 0, 0, 1_000_000);
    const count = int(i, "count", 10, 1, 20);
    const idx = Array.from({ length: count }, (_, n) => start + n);
    const out = json(
      w().addressesFromXpub(xpub, chain, [kind], Uint32Array.from([branch]), Uint32Array.from(idx)),
    ) as unknown[];
    if (!out.length) bad("kind_not_supported_for_chain");
    return { chain, kind, addresses: out };
  },
  ss58: (i) => {
    const op = str(i, "op", /^(decode|encode|convert)$/);
    if (op === "encode")
      return {
        address: w().ss58Encode(
          unhex(str(i, "account", /^(0x)?[0-9a-fA-F]{64}$/)),
          int(i, "prefix", 0, 0, 16383),
        ),
      };
    const d = json(w().ss58Decode(str(i, "address"))) as { prefix: number; account: string };
    if (op === "decode") return d;
    return { ...d, address: w().ss58Encode(d.account, int(i, "prefix", 0, 0, 16383)) };
  },
  "polkadot-storage-key": (i) => ({
    key: `0x${unhex(w().polkadotAccountStorageKey(str(i, "account")))}`,
  }),
  "decode-account-info": (i) =>
    json(w().decodeAccountInfo(unhex(str(i, "hex", /^(0x)?[0-9a-fA-F]{2,400}$/)))),
  "solana-pda": (i) => {
    const seeds = i.seeds;
    if (!Array.isArray(seeds) || seeds.length > 16) return bad("bad_seeds");
    const hex = seeds.map((s) => {
      if (typeof s !== "string" || !HEX.test(s) || unhex(s).length > 64) return bad("bad_seeds");
      return unhex(s);
    });
    return json(w().solFindProgramAddress(JSON.stringify(hex), str(i, "program")));
  },
  "solana-ata": (i) =>
    json(
      w().solAssociatedTokenAddress(
        str(i, "owner"),
        str(i, "mint"),
        optStr(i, "token_program") ?? "",
      ),
    ),
  "solana-on-curve": (i) => ({ onCurve: w().solIsOnCurve(str(i, "address")) }),
  "anchor-discriminator": (i) => ({
    discriminator: w().solAnchorDiscriminator(str(i, "name", /^[A-Za-z0-9_]{1,64}$/)),
  }),
  blake2b: (i) => ({
    hash: w().blake2b(
      unhex(str(i, "data", HEX)),
      int(i, "out_len", 32, 1, 64),
      typeof i.personal === "string" ? i.personal : "",
    ),
  }),
  twox128: (i) => ({ hash: w().twox128(str(i, "text")) }),
  base58: (i) => {
    const op = str(i, "op", /^(encode|decode)$/);
    return op === "encode"
      ? { base58: w().base58Encode(unhex(str(i, "data", HEX))) }
      : { hex: w().base58Decode(str(i, "data")) };
  },
  "tron-tx": (i) => {
    const op = str(i, "op", /^(decode|txid)$/);
    const hex = unhex(str(i, "hex", /^(0x)?([0-9a-fA-F]{2}){8,}$/));
    const d = json(w().tronDecodeTx(hex)) as { signatures?: number; txid?: string };
    // signed bytes stay in the user's wallet: only unsigned raw_data is accepted here
    if ((d.signatures ?? 0) > 0) bad("signed_tx_refused");
    return op === "txid" ? { txid: w().tronTxId(hex) } : d;
  },
  // EVM tools (blocktools 4e4a404 / 5dd2037 / 69e09b9): ABI, CREATE/CREATE2, bytecode, EIP-712.
  // All hashing, ABI coding and signer recovery runs in blocktools; SwapChan only shapes input.
  "evm-abi": (i) => {
    const op = str(i, "op", /^(encode|decode|inspect)$/);
    if (op === "inspect") return json(w().evmAbiInspect(str(i, "abi", undefined, 12_000)));
    if (op === "encode")
      return json(w().evmAbiEncode(JSON.stringify({ sig: str(i, "sig"), args: args(i) })));
    const req: Record<string, unknown> = { input: str(i, "input", HEX, 12_000) };
    const sig = optStr(i, "sig");
    const abi = optStr(i, "abi", undefined, 12_000);
    const types = optStr(i, "types", /^\(.*\)$/);
    if (sig) req.sig = sig;
    if (abi) req.abi = abi;
    if (types) req.types = types;
    if (i.output === true || i.output === "true") req.output = true;
    return json(w().evmAbiDecode(JSON.stringify(req)));
  },
  "create-address": (i) => {
    const deployer = str(i, "deployer", EVM_ADDR);
    const salt = optStr(i, "salt", /^(0x)?[0-9a-fA-F]{64}$/);
    if (!salt) {
      const n = i.nonce;
      const nonce = typeof n === "number" ? n : str(i, "nonce", /^(0x[0-9a-fA-F]{1,16}|\d{1,20})$/);
      return json(w().evmCreateAddress(JSON.stringify({ deployer, nonce })));
    }
    const hash = optStr(i, "init_code_hash", /^(0x)?[0-9a-fA-F]{64}$/);
    const req: Record<string, unknown> = { deployer, salt };
    if (hash) req.init_code_hash = hash;
    else req.init_code = str(i, "init_code", HEX, 12_000);
    return json(w().evmCreateAddress(JSON.stringify(req)));
  },
  // Keyless multisig / PSBT combine / Plan resolve / message verify (blocktools 07a5023).
  // No signer is exported to the wasm; these take public keys, PSBTs, plans and public signatures only.
  "multisig-address": (i) =>
    json(
      w().multisigAddress(
        int(i, "threshold", 0, 1, 20),
        pubkeys(i),
        optStr(i, "network", NETWORK) ?? "",
      ),
    ),
  "taproot-multisig-address": (i) =>
    json(
      w().taprootMultisigAddress(
        int(i, "threshold", 0, 1, 20),
        pubkeys(i),
        optStr(i, "network", NETWORK) ?? "",
      ),
    ),
  "tx-combine": (i) => {
    const v = i.psbts;
    if (!Array.isArray(v) || v.length > 16) return bad("bad_psbts");
    return json(
      w().combinePsbts(
        v.map((p) => (typeof p === "string" && p.length <= 20_000 ? p.trim() : bad("bad_psbts"))),
      ),
    );
  },
  "tx-plan-resolve": (i) =>
    json(
      w().txPlanResolve(
        doc(i, "plan", 30_000),
        i.context === undefined ? "{}" : doc(i, "context", 2_000),
      ),
    ),
  "msg-verify": (i) => {
    // the message is used byte-for-byte (not trimmed): it is what was signed
    const m = i.message;
    if (typeof m !== "string" || m.length > 2_000) return bad("bad_message");
    // blocktools v0.4.0 msgVerifyOpts: optional chain (eth|btc|tron|sol|cosmos; required for strings valid
    // as both Cosmos bech32 and a Solana key, else ambiguous_address; a mismatch gives
    // chain_does_not_match_address), format (Solana raw|offchain-v0) and pubkey (Cosmos ADR-036, base64).
    // Omitted options are not sent, so existing callers get the same result as msgVerify.
    for (const k of ["chain", "format", "pubkey"])
      if (i[k] !== undefined && typeof i[k] !== "string") bad(`${k}_must_be_string`);
    const chain = optStr(i, "chain", /^(eth|btc|tron|sol|cosmos)$/);
    const format = optStr(i, "format", /^(raw|offchain-v0)$/);
    const pubkey = optStr(i, "pubkey", /^[A-Za-z0-9+/]{1,64}={0,2}$/, 100);
    const req: Record<string, string> = {
      address: str(i, "address"),
      [i.message_is_hex === true ? "message_hex" : "message"]: m,
      signature: str(i, "sig", undefined, 200),
    };
    if (format) req.format = format;
    if (pubkey) req.pubkey = pubkey;
    if (chain) req.chain = chain;
    return json(w().msgVerifyOpts(JSON.stringify(req)));
  },
  // Keyless BOLT11 decode (blocktools tx::bolt11): public invoice string only, no keys, no channel.
  "bolt11-decode": (i) => json(w().bolt11Decode(str(i, "invoice", undefined, 8_000))),
  "bytecode-inspect": (i) => json(w().evmBytecodeInspect(str(i, "code", HEX, 59_000))),
  "typed-data-verify": (i) => {
    const sig = optStr(i, "signature", /^(0x)?([0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/);
    const signer = optStr(i, "signer", EVM_ADDR);
    // optional domain and permit assertions (blocktools options_json); none given: unchanged
    for (const k of [
      "expect_chain_id",
      "expect_verifying_contract",
      "expect_spender",
      "expect_amount",
      "expect_min_consideration",
    ])
      if (i[k] !== undefined && typeof i[k] !== "string") bad(`${k}_must_be_string`);
    const chainId = optStr(i, "expect_chain_id", /^\d{1,78}$/);
    const contract = optStr(i, "expect_verifying_contract", EVM_ADDR);
    const spender = optStr(i, "expect_spender", EVM_ADDR);
    const amount = optStr(i, "expect_amount", /^\d{1,78}$/);
    const minConsideration = optStr(i, "expect_min_consideration", /^[0-9A-Za-z:, ]{1,2000}$/);
    const ul = i.expect_unlimited;
    if (ul !== undefined && ul !== "" && typeof ul !== "boolean" && ul !== "true" && ul !== "false")
      bad("expect_unlimited_must_be_bool");
    const unlimited = ul === true || ul === "true";
    const opts =
      chainId || contract || spender || amount || unlimited || minConsideration
        ? JSON.stringify({
            ...(chainId ? { expect_chain_id: chainId } : {}),
            ...(contract ? { expect_verifying_contract: contract } : {}),
            ...(spender ? { expect_spender: spender } : {}),
            ...(amount ? { expect_amount: amount } : {}),
            ...(unlimited ? { expect_unlimited: true } : {}),
            ...(minConsideration ? { expect_min_consideration: minConsideration } : {}),
          })
        : null;
    return json(
      w().evmTypedDataVerify(
        doc(i, "typed_data", TYPED_DATA_MAX),
        sig ?? null,
        signer ?? null,
        opts,
      ),
    );
  },
  "supported-chains": (i) => {
    const all = [
      ...(json(w().supportedChains()) as { name: string; ticker: string }[]),
      ...(json(w().unverifiedChains()) as { name: string; ticker: string }[]),
    ];
    const chain = optStr(i, "chain", CHAIN)?.toLowerCase();
    if (chain)
      return (
        all.find((c) => c.name === chain || c.ticker.toLowerCase() === chain) ??
        bad("unknown_chain")
      );
    const verified = all.filter((c) => (c as { verified?: boolean }).verified).length;
    return { version: w().version(), verified, unverified: all.length - verified, chains: all };
  },
  "chain-params": (i) => {
    const all = json(w().chainParams()) as { name: string }[];
    const chain = optStr(i, "chain", CHAIN);
    if (!chain) return { count: all.length, chains: all };
    const one = all.find((p) => p.name === chain);
    return one ?? bad("unknown_chain");
  },
};
const w = () => blocktools() ?? bad("blocktools_unavailable");

/** Run one tool. Returns a code on failure, never the input or a stack. */
export function runDevTool(
  fn: string,
  input: unknown,
):
  | { ok: true; tool: string; result: unknown }
  | { ok: false; tool: string; error_code: string; error: string } {
  const tool = Object.hasOwn(DEV_TOOLS, fn) ? fn : "unknown";
  try {
    const run = DEV_TOOLS[tool] ?? bad("unknown_tool");
    if (!input || typeof input !== "object" || Array.isArray(input)) bad("bad_body");
    refuseSecrets(input);
    return { ok: true, tool, result: run(input as In) };
  } catch (e) {
    const code = errCode(e);
    // `error` mirrors error_code so generic API clients (MCP) surface the code
    return { ok: false, tool, error_code: code, error: code };
  }
}

/** Client key for the rate limit: the proxy-set client IP; never logged or stored beyond the 60s window. */
export const clientOf = (h: (n: string) => string | undefined, remoteAddress?: string) =>
  trustedClientIp(h, remoteAddress);

export function devToolRoutes(opts: { perMinute?: number; now?: () => number } = {}) {
  const limit = opts.perMinute ?? RATE_PER_MIN;
  const now = opts.now ?? Date.now;
  const windows = new Map<string, { start: number; count: number }>();
  const r = new Hono();
  r.get("/", (c) =>
    c.json({
      tools: Object.keys(DEV_TOOLS),
      maxBody: MAX_BODY,
      bigBody: BIG_BODY,
      perMinute: limit,
    }),
  );
  r.post("/:fn", async (c) => {
    c.header("cache-control", "no-store");
    const t = now();
    const who = clientOf((n) => c.req.header(n), socketAddressOf(c.env));
    let win = windows.get(who);
    if (!win || t - win.start >= 60_000) {
      win = { start: t, count: 0 };
      windows.set(who, win);
      if (windows.size > 50_000) windows.clear();
    }
    win.count++;
    c.header("x-ratelimit-limit", String(limit));
    c.header("x-ratelimit-remaining", String(Math.max(0, limit - win.count)));
    if (win.count > limit) {
      c.header("retry-after", String(Math.ceil((win.start + 60_000 - t) / 1000)));
      return c.json({ ok: false, error_code: "rate_limited" }, 429);
    }
    const fn = c.req.param("fn");
    const cap = bodyLimit(fn);
    if (Number(c.req.header("content-length") ?? 0) > cap)
      return c.json({ ok: false, tool: fn, error_code: "body_too_large" }, 413);
    const raw = await c.req.text().catch(() => "");
    if (raw.length > cap) return c.json({ ok: false, tool: fn, error_code: "body_too_large" }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ ok: false, tool: fn, error_code: "bad_json" }, 400);
    }
    const out = runDevTool(fn, body);
    return c.json(out, out.ok ? 200 : out.error_code === "unknown_tool" ? 404 : 400);
  });
  return r;
}
