import { createRequire } from "node:module";

/**
 * TSavo/blocktools public API (WASM, default features: no secrets/signing), vendored in ../vendor/blocktools
 * (see vendor/blocktools/SOURCE). Loaded once; if it fails to load, the try-helpers return null and the need()
 * helpers (Polkadot, Solana, ...) throw, so callers fail closed rather than fall back to unverified TS.
 */
type Wasm = {
  version(): string;
  multisigAddress(threshold: number, pubkeys: string[], network: string): string;
  taprootMultisigAddress(threshold: number, pubkeys: string[], network: string): string;
  combinePsbts(psbts: string[]): string;
  txPlanResolve(planJson: string, contextJson: string): string;
  msgVerify(address: string, message: string, sig: string, messageIsHex: boolean): string;
  /** v0.4.0: {address, message|message_hex, signature, format?, pubkey?, chain?} as JSON; same result JSON as msgVerify */
  msgVerifyOpts(input: string): string;
  bolt11Decode(invoice: string): string;
  supportedChains(): string;
  unverifiedChains(): string;
  chainParams(): string;
  chainTable(): string;
  detectAddress(addr: string): string;
  decodeTx(input: string, chain: string): string;
  verifyTx(
    input: string,
    chain: string,
    expectTo: string[],
    change: string[],
    chainId: number | null | undefined,
    maxFee: string,
    allowWarnings: boolean,
    /** 8dfbe68: nonzero ETH value beside ERC-20 transfer calldata fails (eth_value_with_token_call) unless true */
    allowValueWithToken?: boolean | null,
    /**
     * f90a6dd: {abi} / {sigs} to check non-token calldata against, or {createHash} to pin a creation's initcode.
     * 10a1356a: also expect_spender, expect_amount, expect_unlimited, expect_recipient, expect_value,
     * allow_inner_call ("TO:SELECTOR"[]), allow_delegatecall (TO[]).
     */
    callJson?: string | null,
  ): string;
  /** f90a6dd: unsigned EVM tx (transfer, call `data`, or creation `create`) as JSON */
  buildEvmTransfer(requestJson: string): string;
  /** f90a6dd: approve calldata against an ABI ({to,data,abi}) or initcode against a pinned hash ({to:null,data,createHash}) */
  evmApproveCall(requestJson: string): string;
  convertAddress(addr: string, to: string): string;
  convertAddressFrom(from: string, addr: string, to: string): string;
  addressValidate(chain: string, addr: string): string;
  buildUnsignedSweep(chain: string, utxos: string, to: string, feeRate: number): string;
  buildUnsignedSweepAt(
    chain: string,
    utxos: string,
    to: string,
    feeRate: number,
    time: number,
  ): string;
  decodeTx(input: string, chain: string): string;
  blake2b(dataHex: string, outLen: number, personal: string): string;
  /** 7a2f4c7: keccak-256 of hex bytes -> 0x + 64 hex */
  evmKeccak256(dataHex: string): string;
  /** 7a2f4c7: selector/topic JSON of one Solidity signature */
  evmSigHash(signature: string): string;
  /** 4e4a404: ABI encode/decode/inspect and CREATE/CREATE2 addresses (request JSON in, JSON out) */
  evmAbiEncode(requestJson: string): string;
  evmAbiDecode(requestJson: string): string;
  evmAbiInspect(abiText: string): string;
  evmCreateAddress(requestJson: string): string;
  /** 5dd2037: runtime bytecode classification (EIP-1167 / EIP-7702 / EOF), EIP-170 size, keccak256 */
  evmBytecodeInspect(codeHex: string): string;
  /** 69e09b9: EIP-712 digest; with a signature the recovered signer; with an expected signer a verdict */
  /** 10a1356a: optionsJson {expect_chain_id?: decimal string, expect_verifying_contract?: 0x address}; c9fe8428 adds {expect_spender?: 0x address, expect_amount?: decimal string, expect_unlimited?: boolean} for permits */
  evmTypedDataVerify(
    typedDataJson: string,
    sigHex?: string | null,
    signer?: string | null,
    optionsJson?: string | null,
  ): string;
  twox128(text: string): string;
  ss58Encode(accountHex: string, prefix: number): string;
  ss58Decode(addr: string): string;
  polkadotAccountStorageKey(account: string): string;
  decodeAccountInfo(hex: string): string;
  base58Encode(hex: string): string;
  base58Decode(s: string): string;
  /** bech32/bech32m witness program of a bc1 address: {version, program_hex (fromWords after the version), words_hex (raw 5-bit words)} */
  bech32WitnessProgram(addr: string): string;
  solIsOnCurve(addr: string): boolean;
  solFindProgramAddress(seedsJson: string, program: string): string;
  solAssociatedTokenAddress(owner: string, mint: string, tokenProgram: string): string;
  solAnchorDiscriminator(name: string): string;
  solDecodeTx(raw: string): string;
  solVerifyTx(raw: string, expectJson: string): string;
  /** Unsigned Solana legacy transfer (SOL/SPL). Plan: {from,to,blockhash,lamports?|token?:{mint,amount,decimals}}. No keys. */
  solBuildTransfer(planJson: string): string;
  /** Unsigned Tron raw_data (TRX/TRC-20). Plan: {from,to,ref_block_bytes,ref_block_hash,expiration_ms,timestamp_ms,amount?|trc20?}. No keys. */
  tronBuildTransfer(planJson: string): string;
  cashAddrDecode(addr: string): string;
  cashAddrEncode(prefix: string, kind: string, hashHex: string): string;
  cashAddrToLegacy(addr: string): string;
  legacyToCashAddr(addr: string, prefix: string): string;
  addressToScript(chain: string, addr: string): string;
  scriptToAddress(chain: string, scriptHex: string): string;
  buildPsbtWithMemo(
    chain: string,
    utxos: string,
    to: string,
    amount: string,
    change: string,
    feeRate: number,
    memoHex: string,
    rbf?: boolean | null,
  ): string;
  /** cd93cd8: THORChain inbound send check on btc/ltc/doge/bch; never throws; {ok, failures[], outputs, memo, fee, rbf} */
  verifyThorSend(
    chain: string,
    txOrPsbt: string,
    expectedVault: string,
    expectedMemo: string,
    expectedAmount: string,
    changeAddr: string,
    takerAddrs: string,
    maxFee: string,
  ): string;
  tronTxId(rawDataHex: string): string;
  serializeNvcTxFromJson(json: string, expectedTxid: string): string;
  verifyRecovery(txJson: string, owner: string, nowS: number): string;
  verifySweepTx(txJson: string, owner: string, chainId: number, token: string): string;
  tronDecodeTx(hex: string): string;
  addressesFromXpub(
    xpub: string,
    chain: string,
    kinds: string[],
    branches: Uint32Array,
    indices: Uint32Array,
  ): string;
};
export type BtParams = {
  name: string;
  ticker: string;
  verified: boolean;
  p2pkh: number[] | null;
  p2sh: number[] | null;
  hrp: string | null;
  decimals: number;
  forkid: number | null;
  tx_format: string;
  sweep_build: boolean;
  /** per-coin verifyTx warning limits (d4e4ea8); basis starts with "default" when not measured for this coin */
  fee_warn?: { fee: number; rate: number; basis: string };
};
/**
 * blocktools (7b70ba4+) emits a decimal-string twin `amount_str` / `fee_str` beside every integer `amount` / `fee`
 * (any depth) because JSON.parse rounds integers above 2^53 (RDD: 33,979,404,789,171,950 units). This parses the
 * output and replaces each `amount` / `fee` with its exact twin; a missing twin throws (fail closed). This replaced
 * SwapChan's own regex quoting (bigJson) of 16+ digit integer tokens.
 */
export function exactJson<T>(raw: string): T {
  const fix = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const k of ["amount", "fee"])
        if (k in o && (typeof o[k] === "number" || typeof o[k] === "string")) {
          const t = o[`${k}_str`];
          if (typeof t !== "string" || !/^\d+$/.test(t))
            throw new Error(`blocktools output has ${k} without ${k}_str`);
          o[k] = t;
        }
      for (const k of Object.keys(o)) o[k] = fix(o[k]);
    }
    return v;
  };
  return fix(JSON.parse(raw)) as T;
}
let wasm: Wasm | null | undefined;
export function blocktools(): Wasm | null {
  if (wasm !== undefined) return wasm;
  try {
    const req = createRequire(import.meta.url);
    wasm = req(
      new URL("../vendor/blocktools/blocktools_wasm.js", import.meta.url).pathname,
    ) as Wasm;
    wasm.version();
  } catch (e) {
    console.log(JSON.stringify({ evt: "blocktools_load_failed", err: String(e).slice(0, 200) }));
    wasm = null;
  }
  return wasm;
}
const tryRun = <T>(fn: (w: Wasm) => T): T | null => {
  const w = blocktools();
  if (!w) return null;
  try {
    return fn(w);
  } catch {
    return null;
  }
};
export const btVersion = () => tryRun((w) => w.version());
export const btParams = (): Map<string, BtParams> | null =>
  tryRun((w) => new Map((JSON.parse(w.chainParams()) as BtParams[]).map((p) => [p.name, p])));
/** Every chain the address is valid on (never picks one); [] = unrecognised; null = WASM unavailable. */
export const btDetect = (addr: string): string[] | null =>
  blocktools()
    ? (tryRun((w) =>
        (JSON.parse(w.detectAddress(addr)) as { chain: string }[]).map((x) => x.chain),
      ) ?? [])
    : null;
/** Address kind if valid on `chain`, else null. */
export const btValidate = (chain: string, addr: string) =>
  tryRun((w) => w.addressValidate(chain, addr));
export const btConvertFrom = (from: string, addr: string, to: string) =>
  tryRun((w) => w.convertAddressFrom(from, addr, to));
export type BtSweep = {
  chain: string;
  tx_format: string;
  /** absent for pos-ntime (no PSBT exists for that format) */
  psbt?: string;
  unsigned_tx: string;
  /** pos-ntime: the tx timestamp and the prevouts verifyTx/decodeTx need for amounts */
  time?: number;
  pos_prevouts?: { amount: string; amount_str: string; script: string }[];
  /** zcash-v5: consensus branch id (hex), expiry height and the prevouts (ZIP-244 commits to amounts) */
  branch_id?: string;
  expiry_height?: number;
  zec_prevouts?: { amount: string; amount_str: string; script: string }[];
  /** the raw JSON line blocktools returned (decode/verify input for pos-ntime) */
  envelope?: string;
  inputs: unknown[];
  /** exact decimal strings (from amount_str / fee_str) */
  amount: string;
  fee: string;
};
/** Throws blocktools' error (e.g. unsupported_tx_format:pos-ntime); returns null only when the WASM is unavailable. */
export function btSweep(
  chain: string,
  /** prev_tx: raw previous tx hex, required by blocktools for legacy (P2PKH), bare P2SH (2052b30) and every pos-ntime input */
  utxos: {
    txid: string;
    vout: number;
    amount: number | string;
    address: string;
    prev_tx?: string | undefined;
  }[],
  to: string,
  feeRate: number,
  /** unix seconds; when set, builds with buildUnsignedSweepAt (required by pos-ntime chains ppc/nvc/clam/rdd) */
  time?: number,
): BtSweep | null {
  const w = blocktools();
  if (!w) return null;
  // amount as a decimal string (accepted since 7b70ba4; per-UTXO limit 2^63-1), never a rounded Number
  const lines = utxos
    .map((u) =>
      JSON.stringify({
        txid: u.txid,
        vout: u.vout,
        amount: BigInt(u.amount).toString(),
        address: u.address,
        ...(u.prev_tx ? { prev_tx: u.prev_tx } : {}),
      }),
    )
    .join("\n");
  const raw =
    time === undefined
      ? w.buildUnsignedSweep(chain, lines, to, feeRate)
      : w.buildUnsignedSweepAt(chain, lines, to, feeRate, time);
  return { ...exactJson<BtSweep>(raw), envelope: raw };
}

export type BtDecoded = {
  role: string;
  /** exact decimal string (from fee_str) */
  fee?: string;
  inputs?: number;
  outputs?: number;
  txid?: string;
  address?: string;
  /** exact decimal string (from amount_str) */
  amount?: string;
  /** input/output position (0-based) in the tx */
  index?: number;
  /** script classification: p2pkh / p2sh / p2wpkh / p2wsh / p2tr / op_return / nonstandard / ... */
  kind?: string;
  /** for an op_return output: hex of the pushed data (the memo payload); blocktools 982722e+ */
  op_return?: string;
}[];
/** decodeTx lines (summary, inputs, outputs) for a built tx/PSBT. Throws on a decode error. */
export function btDecode(tx: string, chain: string): BtDecoded | null {
  const w = blocktools();
  return w ? exactJson<BtDecoded>(w.decodeTx(tx, chain)) : null;
}
/** verifyTx: every output pays `to`, fee is known and at most `maxFee` (decimal base units). The "unsigned" warning is expected. */
export function btVerify(tx: string, chain: string, to: string, maxFee: string) {
  const w = blocktools();
  if (!w) return null;
  return JSON.parse(w.verifyTx(tx, chain, [to], [], undefined, maxFee, false)) as {
    ok: boolean;
    failures: string[];
    warnings: string[];
  };
}

/**
 * Watch-only addresses from an account-level xpub (public input only; GRS xpubs carry the Groestl-512 checksum).
 * Returns null when the WASM is unavailable or blocktools rejects the xpub for this chain.
 */
export function btXpubAddresses(
  xpub: string,
  chain: string,
  kinds: string[],
  branches: number[],
  indices: number[],
): { chain: string; kind: string; path: string; address: string }[] | null {
  const w = blocktools();
  if (!w) return null;
  try {
    return JSON.parse(
      w.addressesFromXpub(
        xpub,
        chain,
        kinds,
        Uint32Array.from(branches),
        Uint32Array.from(indices),
      ),
    );
  } catch {
    return null;
  }
}

/** Polkadot helpers (blocktools 000a71a). Fail closed: throw when the WASM is unavailable, no TS fallback. */
const need = (): Wasm => {
  const w = blocktools();
  if (!w) throw new Error("blocktools unavailable");
  return w;
};
/** SS58 (any prefix) -> { prefix, account: 32-byte hex }. Throws on bad base58/checksum/length. */
export const btSs58Decode = (addr: string) =>
  JSON.parse(need().ss58Decode(addr)) as { prefix: number; account: string };
/** System.Account storage key (0x-prefixed) for an SS58 address or 32-byte hex account. */
export const btDotStorageKey = (account: string) =>
  `0x${need().polkadotAccountStorageKey(account).replace(/^0x/, "")}`;
/** SCALE AccountInfo -> balances as bigint. */
export function btDecodeAccountInfo(hex: string): {
  free: bigint;
  reserved: bigint;
  frozen: bigint;
} {
  const j = JSON.parse(need().decodeAccountInfo(hex.replace(/^0x/, ""))) as {
    data: { free: string; reserved: string; frozen: string };
  };
  return {
    free: BigInt(j.data.free),
    reserved: BigInt(j.data.reserved),
    frozen: BigInt(j.data.frozen),
  };
}

/** Solana / base58 helpers (blocktools 66dc76c). Fail closed: throw when the WASM is unavailable, no TS fallback. */
const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");
/** Bitcoin-alphabet base58 of raw bytes. */
export const btB58Encode = (b: Uint8Array) => need().base58Encode(hexOf(b));
/** Raw bytes of a bitcoin-alphabet base58 string; throws bad_base58. */
export const btB58Decode = (s: string) =>
  Uint8Array.from(Buffer.from(need().base58Decode(s), "hex"));
/** bech32/bech32m witness program of a bc1/bc1p address: {version, program_hex, words_hex}. Throws on a non-segwit address or a bad checksum. */
export const btBech32Witness = (a: string) =>
  JSON.parse(need().bech32WitnessProgram(a)) as {
    version: number;
    program_hex: string;
    words_hex: string;
  };
/** Is this 32-byte string a valid ed25519 point (a wallet key)? PDAs are off-curve. */
export const btSolOnCurve = (b: Uint8Array) => need().solIsOnCurve(btB58Encode(b));
/** findProgramAddress: highest-bump off-curve sha256(seeds|bump|program|"ProgramDerivedAddress"). */
export function btSolPda(seeds: Uint8Array[], program: string): { address: string; bump: number } {
  return JSON.parse(need().solFindProgramAddress(JSON.stringify(seeds.map(hexOf)), program));
}
/** Associated token account of owner for mint (tokenProgram omitted = classic SPL Token). */
export const btSolAta = (owner: string, mint: string, tokenProgram = "") =>
  (JSON.parse(need().solAssociatedTokenAddress(owner, mint, tokenProgram)) as { address: string })
    .address;
/** Anchor instruction discriminator: first 8 bytes (hex) of sha256("global:<name>"). */
/** EVM hashing (blocktools 7a2f4c7). Fail closed: throw when the WASM is unavailable, no TS fallback. */
type Hex = `0x${string}`;
/** keccak-256 of hex bytes (0x optional). */
export const btKeccak256 = (dataHex: string): Hex => need().evmKeccak256(dataHex) as Hex;
const sigHash = (sig: string) =>
  JSON.parse(need().evmSigHash(sig)) as { kind: string; selector?: Hex; topic?: Hex };
/** 4-byte function selector of a signature ("transfer(address,uint256)" or "function ..."). */
export const btSelector = (sig: string): Hex => {
  const r = sigHash(sig);
  if (!r.selector) throw new Error(`no selector for ${sig}`);
  return r.selector;
};
/** 32-byte event topic of an event signature (without the "event " keyword). */
export const btTopic = (sig: string): Hex => {
  const r = sigHash(`event ${sig}`);
  if (!r.topic) throw new Error(`no topic for ${sig}`);
  return r.topic;
};
export const btSolAnchorDisc = (name: string) => need().solAnchorDiscriminator(name);
export type BtSolTx = {
  version: "legacy" | 0;
  txid: string;
  fee_payer: string;
  recent_blockhash: string;
  num_required_signatures: number;
  accounts: { pubkey: string; signer: boolean; writable: boolean }[];
  address_table_lookups: { table: string; writable: number[]; readonly: number[] }[];
  instructions: ({
    program: string;
    kind: string;
    /** indices into `accounts`; an index beyond `accounts.length` is an address-lookup-table account (unresolved here) */
    account_indexes: number[];
    /** raw instruction data as hex ("" when empty) */
    data_hex: string;
  } & Record<string, unknown>)[];
  signatures: { signer: string; status: "valid" | "invalid" | "unsigned" }[];
  message_hex: string;
};
/** Decode a Solana wire tx (hex or base64; legacy or v0). Throws on malformed input. */
export const btSolDecodeTx = (raw: string) => JSON.parse(need().solDecodeTx(raw)) as BtSolTx;

/** Address helpers (blocktools 61f1297). Fail closed: throw when the WASM is unavailable; false/null = invalid. */
export function btAddrValid(chain: string, addr: string): boolean {
  const w = need();
  try {
    w.addressValidate(chain, addr);
    return true;
  } catch {
    return false;
  }
}
/** Every chain the address is valid on. */
export const btDetectChains = (addr: string): string[] =>
  (JSON.parse(need().detectAddress(addr)) as { chain: string }[]).map((d) => d.chain);
/** BCH CashAddr (prefix optional, checksum verified) -> legacy base58; null when not a valid CashAddr. */
export function btCashToLegacy(addr: string): string | null {
  const w = need();
  try {
    return w.cashAddrToLegacy(addr);
  } catch {
    return null;
  }
}

/** EVM recovery / sweep verifiers (blocktools 7a6d945, viem-parity corpus). Fail closed: throw when the WASM
 *  is unavailable; there is no TS copy. */
export type BtVerdict =
  | { readonly verified: true; readonly call: string }
  | { readonly verified: false; readonly reason: string };
const big = (o: unknown) =>
  JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
/** tx = {to, data, value}; nowS = unix seconds (exit deadlines are checked against it). */
export const btVerifyRecovery = (tx: unknown, owner: string, nowS: number): BtVerdict =>
  JSON.parse(need().verifyRecovery(big(tx), owner, nowS)) as BtVerdict;
/** tx = {from, to, value, data?, chainId}; token "" = native sweep. */
export const btVerifySweepTx = (
  tx: unknown,
  owner: string,
  chainId: number,
  token = "",
): BtVerdict => JSON.parse(need().verifySweepTx(big(tx), owner, chainId, token)) as BtVerdict;
/** Bitcoin-family address -> scriptPubKey hex for one chain (version bytes / HRP / checksum checked, BIP-173 case
 *  rule: mixed-case bech32 is refused). null when the address is not valid for that chain; throws if the WASM is
 *  unavailable (fail closed). */
export function btAddressToScript(chain: string, addr: string): string | null {
  const w = need();
  try {
    return w.addressToScript(chain, addr);
  } catch {
    return null;
  }
}

export type BtPsbt = { psbt: string; fee: string; vsize: number; rbf: boolean };
/** Unsigned BTC PSBT: `amount` to `to` (VOUT0), change to `change` (VOUT1, when above dust), OP_RETURN memo last
 *  (THORChain order). Non-RBF (nSequence 0xffffffff), like the old btc.ts. Throws blocktools' error; throws if the
 *  WASM is unavailable (fail closed, no TS fallback). */
export function btBuildPsbt(
  chain: string,
  utxos: {
    txid: string;
    vout: number;
    amount: number | string;
    address: string;
    /** raw previous tx hex: required by blocktools for legacy (P2PKH) and P2SH inputs */
    prev_tx?: string | undefined;
  }[],
  to: string,
  amount: bigint,
  change: string,
  feeRate: number,
  memoHex: string,
): BtPsbt {
  const lines = utxos
    .map((u) =>
      JSON.stringify({
        txid: u.txid,
        vout: u.vout,
        amount: BigInt(u.amount).toString(),
        address: u.address,
        ...(u.prev_tx ? { prev_tx: u.prev_tx } : {}),
      }),
    )
    .join("\n");
  // amounts in this output are decimal strings already (EXPORTS.md)
  return JSON.parse(
    need().buildPsbtWithMemo(chain, lines, to, amount.toString(), change, feeRate, memoHex, false),
  ) as BtPsbt;
}

export type BtThorSend = {
  ok: boolean;
  /** blocktools reasons: chain tx vault amount memo change output_count rbf fee input_unknown input_foreign
   *  vault_invalid change_invalid taker_invalid */
  failures: string[];
  outputs: { address: string | null; amount: string; kind: string }[];
  memo: string | null;
  fee: string | null;
  rbf: boolean | null;
};
/** THORChain inbound send check (blocktools verifyThorSend): exactly [vault == amount, optional change, OP_RETURN ==
 *  memo], non-RBF, every input value proven and owned by `takers`, fee <= maxFee (decimal string). Throws if the
 *  WASM is unavailable (fail closed, no TS fallback). */
export function btVerifyThorSend(
  chain: string,
  psbt: string,
  vault: string,
  memo: string,
  amount: bigint,
  change: string,
  takers: string[],
  /** null = blocktools' per-chain default cap */
  maxFee: bigint | null,
): BtThorSend {
  return JSON.parse(
    need().verifyThorSend(
      chain,
      psbt,
      vault,
      memo,
      amount.toString(),
      change,
      JSON.stringify(takers),
      maxFee === null ? "" : maxFee.toString(),
    ),
  ) as BtThorSend;
}

/** ABI encoding (blocktools evmAbiEncode). Drop-in for viem's encodeFunctionData / encodeAbiParameters: viem-style
 *  ABI items in, blocktools does the selector hashing and encoding. Fail closed: throws when the WASM is unavailable
 *  or the args don't fit the types. */
type AbiParam = {
  readonly type: string;
  readonly name?: string;
  readonly components?: readonly AbiParam[];
};
type AbiFn = {
  readonly type: string;
  readonly name?: string;
  readonly inputs?: readonly AbiParam[];
};
const canonType = (p: AbiParam): string =>
  p.type.startsWith("tuple")
    ? `(${(p.components ?? []).map(canonType).join(",")})${p.type.slice(5)}`
    : p.type;
const abiVal = (p: AbiParam, v: unknown): unknown => {
  const arr = /^(.*)\[\d*\]$/.exec(p.type);
  if (arr) {
    if (!Array.isArray(v)) throw new Error(`abi: ${p.type} needs an array`);
    return v.map((x) => abiVal({ ...p, type: arr[1]! }, x));
  }
  if (p.type === "tuple") {
    const cs = p.components ?? [];
    if (Array.isArray(v)) return cs.map((c, i) => abiVal(c, v[i]));
    const o = v as Record<string, unknown>;
    return cs.map((c) => abiVal(c, o[c.name ?? ""]));
  }
  if (typeof v === "bigint" || typeof v === "number") return v.toString();
  return v;
};
const encodeRaw = (sig: string, params: readonly AbiParam[], args: readonly unknown[]): Hex => {
  if (args.length !== params.length)
    throw new Error(`abi: ${sig} takes ${params.length} args, got ${args.length}`);
  const r = JSON.parse(
    need().evmAbiEncode(JSON.stringify({ sig, args: params.map((p, i) => abiVal(p, args[i])) })),
  ) as { data: Hex };
  return r.data.toLowerCase() as Hex;
};
export function encodeFunctionData(p: {
  readonly abi: readonly unknown[];
  readonly functionName?: string;
  readonly args?: readonly unknown[];
}): Hex {
  const args = p.args ?? [];
  const fns = (p.abi as AbiFn[]).filter(
    (x) => x.type === "function" && (p.functionName === undefined || x.name === p.functionName),
  );
  const pick = fns.length > 1 ? fns.filter((f) => (f.inputs ?? []).length === args.length) : fns;
  if (pick.length !== 1)
    throw new Error(`abi: ${pick.length} candidates for ${p.functionName ?? "function"}`);
  const f = pick[0]!;
  const ins = f.inputs ?? [];
  return encodeRaw(`${f.name}(${ins.map(canonType).join(",")})`, ins, args);
}
export const encodeAbiParameters = (params: readonly AbiParam[], values: readonly unknown[]): Hex =>
  encodeRaw(`(${params.map(canonType).join(",")})`, params, values);

/** ABI decoding (blocktools evmAbiDecode). Drop-in for viem's decodeFunctionData / decodeAbiParameters: the
 *  guard feeds the same viem-style ABI items and reads back the same native values (bigint ints, named-tuple
 *  objects, element arrays, checksummed addresses). blocktools returns ints as decimal strings and tuples as
 *  positional arrays, so the value tree is re-shaped against the viem param tree — which also carries the
 *  component names viem keys named tuples by (the raw `types` path has none). Fail closed: throws when the
 *  WASM is unavailable or the calldata does not decode (the guard's tryDecode catches it, as with viem).
 *  allow_trailing: viem ignores bytes after the last ABI word, so these drop-ins ask blocktools (strict by
 *  default since ac0b3f7) to do the same; dirty padding and truncated words are still rejected. allow_gaps:
 *  viem also follows forward offsets past the canonical tail position (LI.FI BridgeData at 0x60/0x80 in
 *  multi-param calldata); backward, overlapping and aliased offsets still throw non_canonical_offset. */
type AbiArg = { readonly value: unknown };
/** blocktools value (ints as decimal strings, tuples as positional arrays) -> viem's native value for `p`. */
const abiValueOf = (p: AbiParam, v: unknown): unknown => {
  const arr = /^(.*)\[\d*\]$/.exec(p.type);
  if (arr) return (v as unknown[]).map((x) => abiValueOf({ ...p, type: arr[1]! }, x));
  if (p.type.startsWith("tuple")) {
    const cs = p.components ?? [];
    const vals = v as unknown[];
    const parts = cs.map((c, i) => abiValueOf(c, vals[i]));
    if (cs.length > 0 && cs.every((c) => c.name)) {
      const o: Record<string, unknown> = {};
      cs.forEach((c, i) => {
        o[c.name!] = parts[i];
      });
      return o;
    }
    return parts;
  }
  const m = /^u?int(\d*)$/.exec(p.type);
  // viem decodes int/uint with size <= 48 bits as a JS number, larger as bigint.
  if (m) return Number(m[1] || "256") <= 48 ? Number(v) : BigInt(v as string);
  return v;
};
export function decodeFunctionData(p: { readonly abi: readonly unknown[]; readonly data: Hex }): {
  functionName: string;
  args: readonly unknown[];
} {
  const r = JSON.parse(
    need().evmAbiDecode(
      JSON.stringify({
        input: p.data,
        abi: JSON.stringify(p.abi),
        allow_trailing: true,
        allow_gaps: true,
      }),
    ),
  ) as { status?: string; signature?: string; args?: AbiArg[] };
  if (r.status !== "ok" || !r.signature || !Array.isArray(r.args))
    throw new Error(`abi: cannot decode ${String(p.data).slice(0, 10)}`);
  const f = (p.abi as AbiFn[]).find(
    (x) =>
      x.type === "function" &&
      `${x.name}(${(x.inputs ?? []).map(canonType).join(",")})` === r.signature,
  );
  if (!f) throw new Error(`abi: decoded ${r.signature} is not in the abi`);
  const ins = f.inputs ?? [];
  return { functionName: f.name!, args: ins.map((pp, i) => abiValueOf(pp, r.args![i]!.value)) };
}
export function decodeAbiParameters(params: readonly AbiParam[], data: Hex): unknown[] {
  const r = JSON.parse(
    need().evmAbiDecode(
      JSON.stringify({
        input: data,
        types: `(${params.map(canonType).join(",")})`,
        allow_trailing: true,
        allow_gaps: true,
      }),
    ),
  ) as { status?: string; args?: AbiArg[] };
  if (r.status !== "ok" || !Array.isArray(r.args) || r.args.length !== params.length)
    throw new Error("abi: cannot decode parameters");
  return params.map((pp, i) => abiValueOf(pp, r.args![i]!.value));
}
/** CoW appData hash: keccak-256 of the exact UTF-8 JSON document. */
export const btAppDataHash = (doc: string): Hex =>
  btKeccak256(`0x${Buffer.from(doc, "utf8").toString("hex")}`);
