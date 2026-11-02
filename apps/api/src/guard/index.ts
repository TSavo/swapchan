import { base58, bech32, bech32m, hex } from "@scure/base";
import {
  type BuildResponse,
  isEvmChain,
  isReceiveOnly,
  NATIVE_TOKEN,
  type NonEvmTx,
  nativeOf,
  type Quote,
  type QuoteRequest,
  SOLANA,
  sameAddressSpace,
  type TxRequest,
  type TypedData,
  vmOf,
} from "@swapchan/shared";
import * as bitcoin from "bitcoinjs-lib";
import type { Hex } from "viem";
import { btB58Decode, btBech32Witness, btDecode, btVerifyThorSend } from "../blocktools.js";
import { UTXO_DEST, validateUtxoRecipient } from "../utxodest.js";
import { fullAddr } from "../utxosend.js";
import {
  COW_SETTLEMENT,
  evmAllowed,
  SVM_FEE_WALLETS,
  SVM_PROGRAMS,
  TVM_CONTRACTS,
} from "./allowlist.js";
import { crossCheckPsbt, crossCheckSvm } from "./btcheck.js";
import type { GuardCtx } from "./ctx.js";
import { type Decoded, decodeApprove, decodeEvm, lifiNonEvm } from "./evm.js";
import {
  checkRelayOrder,
  type RelayOrder,
  relayChainPinned,
  relayNotPinnedMessage,
} from "./relay.js";
import {
  ata,
  checkSvmIxs,
  parseSvmBase64,
  parseSvmInstructions,
  TOKEN,
  TOKEN22,
  WSOL,
} from "./svm.js";

export type { GuardCtx } from "./ctx.js";
export { liveGuardCtx } from "./ctx.js";

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}
export interface Verification {
  verified: boolean;
  /** full = recipient + min output decoded from the payload; partial = some fields not decodable. */
  level: "full" | "partial" | "indicative";
  checks: Check[];
}

/** Everything a client could be asked to sign for one route. */
export interface Payload {
  provider: string;
  req: QuoteRequest;
  /** Expected output (reference quote) used to bound min-out. */
  toAmount: string;
  approvalAddress?: string | null | undefined;
  tx?: TxRequest | null | undefined;
  approval?: TxRequest | undefined;
  permit2?: TypedData | undefined;
  order?: TypedData | undefined;
  nonEvmTx?: NonEvmTx | undefined;
  /** Relay Protocol v2 order the deposit must commit to. */
  relayOrder?: RelayOrder | undefined;
}

const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const ZERO = "0x0000000000000000000000000000000000000000";
/** Extra native value a cross-chain route may charge on top of the input (bridge protocol fee). */
const FEE_CAP: Record<number, bigint> = {
  56: 5n * 10n ** 16n,
  137: 20n * 10n ** 18n,
  43114: 10n ** 18n,
};
const feeCap = (chainId: number) => FEE_CAP[chainId] ?? 10n ** 16n;
/** Slack beyond the user's slippage for rounding / our fee, in bps. */
const TOL_BPS = 100;

const lc = (s: string) => s.toLowerCase();
const isNativeTok = (chainId: number, t: string) =>
  lc(t) === lc(nativeOf(chainId)) || lc(t) === lc(NATIVE_TOKEN) || lc(t) === ZERO;
const sameTok = (chainId: number, a: string | undefined, b: string) =>
  !a || lc(a) === lc(b) || (isNativeTok(chainId, a) && isNativeTok(chainId, b));

const ascii = (s: string) => hex.encode(new TextEncoder().encode(s));
/** Byte patterns (lowercase hex) under which an address of any VM can appear in calldata. */
export function needles(a: string): string[] {
  const out = [ascii(a), ascii(lc(a))];
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) out.push(lc(a).slice(2));
  else
    try {
      // base58 decoded via blocktools' vendored base58Decode (byte-for-byte == @scure base58.decode on
      // valid input; proven in btcheck.test.ts). Tron: drop the 0x41 version byte, keep the 20-byte hash.
      if (/^T/.test(a) && a.length === 34) out.push(hex.encode(btB58Decode(a).slice(1, 21)));
      else if (/^bc1/i.test(a)) {
        // blocktools bech32WitnessProgram: the bare witness-program bytes and the raw 5-bit words (the
        // calldata needles; addressToScript would return the full scriptPubKey instead).
        const w = btBech32Witness(a);
        out.push(w.program_hex);
        out.push(w.words_hex); // 5-bit words (LayerSwap)
      } else if (a.length >= 32) {
        const b = btB58Decode(a);
        if (b.length === 32) out.push(hex.encode(b));
      }
    } catch {
      /* ascii only (also when the blocktools wasm is unavailable: fail closed — a vanished needle can
         only make `contains` stricter, never looser) */
    }
  return out;
}
const contains = (data: string, a: string) => {
  const d = lc(data);
  return needles(a).some((n) => d.includes(n));
};
const addrBytes = (a: string) => needles(a).at(-1)!;

const minBound = (p: Payload) =>
  (BigInt(p.toAmount) * BigInt(10_000 - p.req.slippageBps - TOL_BPS)) / 10_000n;

/** THORChain memo: =:ASSET:DEST[/REFUND]:LIM[/INT/QTY][:AFF:BPS]. */
export function parseThorMemo(m: string): { dest: string; limit: bigint } | null {
  const p = m.split(":");
  if (!["=", "s", "SWAP"].includes(p[0] ?? "") || p.length < 3) return null;
  const dest = p[2]!.split("/")[0]!;
  let limit = 0n;
  try {
    limit = BigInt((p[3] ?? "0").split("/")[0] || "0");
  } catch {
    return null;
  }
  return { dest, limit };
}
const THOR_CHAIN: Record<number, string> = {
  1: "ETH",
  8453: "BASE",
  56: "BSC",
  43114: "AVAX",
  8253038: "BTC",
  728126428: "TRON",
  2000000002: "LTC",
  2000000003: "DOGE",
  2000000145: "BCH",
};
/** THORChain memo asset forms per receive-only chain (full and the short codes THORChain emits). */
const THOR_DEST_ASSET: Record<number, string[]> = {
  2000000002: ["LTC.LTC", "l"],
  2000000003: ["DOGE.DOGE", "d"],
  2000000145: ["BCH.BCH", "c"],
};

class Acc {
  checks: Check[] = [];
  partial = false;
  ok(name: string, detail?: string) {
    this.checks.push({ name, ok: true, ...(detail ? { detail } : {}) });
  }
  bad(name: string, detail: string) {
    this.checks.push({ name, ok: false, detail });
  }
  test(name: string, cond: boolean, detail: string) {
    if (cond) this.ok(name);
    else this.bad(name, detail);
  }
  part(name: string, detail: string) {
    this.partial = true;
    this.ok(name, `not verifiable: ${detail}`);
  }
}

function checkRecipientMemo(c: Acc, memo: string, dest: string | undefined, toChainId?: number) {
  const m = parseThorMemo(memo);
  if (!m) return c.bad("memo", `unparseable THORChain memo`);
  if (toChainId !== undefined && isReceiveOnly(toChainId)) {
    // UTXO payout: the memo must name this chain's coin and pay exactly the blocktools-validated address.
    const asset = memo.split(":")[1] ?? "";
    c.test(
      "outToken",
      THOR_DEST_ASSET[toChainId]!.includes(asset),
      `memo asset ${asset} is not ${UTXO_DEST[toChainId]!.thor}`,
    );
    if (!dest) c.bad("recipient", `${UTXO_DEST[toChainId]!.name} payout needs a recipient`);
    else {
      const v = validateUtxoRecipient(toChainId, dest);
      if (!v.ok) c.bad("recipient", v.reason);
      else
        c.test(
          "recipient",
          m.dest === v.address,
          `memo destination ${m.dest} != validated ${v.address}`,
        );
    }
  } else if (dest)
    c.test("recipient", lc(m.dest) === lc(dest), `memo destination ${m.dest} != ${dest}`);
  c.test("minOut", m.limit > 0n, "memo has no output limit");
  c.part("minOut-bound", "THORChain limit is in 1e8 units; checked > 0 only");
}

/** The only Available pool asset on `chain` with `symbol` (upper case), or null when none or several. */
function soleSymbolPool(pools: Iterable<string> | undefined, chain: string, symbol: string) {
  if (!pools) return null;
  const hit = [...pools]
    .map((p) => p.toUpperCase())
    .filter((p) => p.startsWith(`${chain}.${symbol}-`));
  return hit.length === 1 ? hit[0]! : null;
}
/** THORChain short asset codes it emits in generated memos (native coins only). */
const THOR_SHORT: Record<string, string> = {
  "ETH.ETH": "e",
  "BTC.BTC": "b",
  "LTC.LTC": "l",
  "DOGE.DOGE": "d",
  "BCH.BCH": "c",
  "AVAX.AVAX": "a",
  "BSC.BNB": "s",
};
/**
 * Why THORChain's memo does not pay what was asked, or null when it does. Asset (field 1): for LTC/DOGE/BCH the
 * THOR_DEST_ASSET forms; otherwise the requested pool asset, its short code, or THORChain's fuzzy token form
 * (same chain and symbol, "-<suffix>" of the requested contract). Payout (field 2 before "/"): for LTC/DOGE/BCH the
 * blocktools-validated canonical address exactly; EVM case-insensitive; other chains exactly.
 */
export function thorMemoMismatch(
  memo: string,
  toChainId: number,
  toAsset: string,
  dest: string,
  /** THORChain's Available pool assets; required to accept the bare short token form (e.g. ETH.USDC). */
  pools?: Iterable<string>,
): string | null {
  const m = parseThorMemo(memo);
  if (!m) return "unparseable THORChain memo";
  const asset = memo.split(":")[1] ?? "";
  const want = toAsset.toUpperCase();
  const forms = THOR_DEST_ASSET[toChainId];
  let assetOk: boolean;
  if (forms) assetOk = forms.includes(asset);
  else {
    const a = asset.toUpperCase();
    const [wp, wr = ""] = want.split(".");
    const [ap, ar = ""] = a.split(".");
    const [wsym, wid = ""] = wr.split("-");
    const [asym, aid = ""] = ar.split("-");
    assetOk =
      a === want ||
      (THOR_SHORT[want] !== undefined && asset === THOR_SHORT[want]) ||
      (!!wid && !!aid && ap === wp && asym === wsym && wid.endsWith(aid)) ||
      // Bare "CHAIN.SYMBOL" (THORChain drops the contract, measured for ETH.USDC/ETH.USDT): only when exactly one
      // Available pool has that chain and symbol and it is the requested contract, so another token can't pass.
      (!!wid &&
        !aid &&
        a === `${wp}.${wsym}` &&
        ap === wp &&
        asym === wsym &&
        soleSymbolPool(pools, wp!, wsym!) === want);
  }
  if (!assetOk) return `memo asset ${asset} is not ${toAsset}`;
  if (isReceiveOnly(toChainId)) {
    const v = validateUtxoRecipient(toChainId, dest);
    if (!v.ok) return v.reason;
    if (m.dest !== v.address) return `memo destination ${m.dest} != validated ${v.address}`;
  } else if (isEvmChain(toChainId) ? lc(m.dest) !== lc(dest) : m.dest !== dest)
    return `memo destination ${m.dest} != ${dest}`;
  return null;
}

/**
 * The memo SwapChan expects on a THORChain-only send, built by SwapChan itself rather than trusted from the payload:
 * THORChain's limit/streaming/affiliate fields are kept, but the asset must be one SwapChan accepts for the requested
 * destination and the destination (and refund) must be SwapChan's validated addresses. A memo that names anything
 * else therefore never equals what SwapChan expects, so blocktools' byte compare refuses it too.
 */
export function expectedThorMemo(
  quoteMemo: string,
  toChainId: number,
  dest: string | undefined,
  refund: string | undefined,
): string | null {
  const p = quoteMemo.split(":");
  if (!parseThorMemo(quoteMemo) || !dest) return null;
  const forms = THOR_DEST_ASSET[toChainId];
  if (forms && !forms.includes(p[1] ?? "")) p[1] = forms[0]!;
  let d = dest;
  if (isReceiveOnly(toChainId)) {
    const v = validateUtxoRecipient(toChainId, dest);
    if (!v.ok) return null;
    d = v.address;
  } else if (lc(p[2]!.split("/")[0]!) === lc(dest)) d = p[2]!.split("/")[0]!;
  p[2] = p[2]!.includes("/") && refund ? `${d}/${refund}` : d;
  return p.join(":");
}

async function thorVault(ctx: GuardCtx, chainId: number) {
  const name = THOR_CHAIN[chainId];
  const xs = await ctx.thorInbound().catch(() => null);
  if (!xs) return null;
  return xs.find((x) => x.chain === name) ?? undefined;
}

/** Bitcoin address as LI.FI's bytes32 nonEVMReceiver (5-bit program words, right-padded). */
export function btcReceiverWord(a: string): string | null {
  try {
    const codec = lc(a).startsWith("bc1p") ? bech32m : bech32;
    const w = codec.decode(lc(a) as `${string}1${string}`).words.slice(1);
    return w.length <= 32 ? hex.encode(Uint8Array.from(w)).padEnd(64, "0") : null;
  } catch {
    return null;
  }
}

function checkLifiNonEvm(c: Acc, data: Hex, dest: string, taker: string | undefined) {
  const f = lifiNonEvm(data);
  if (!f) {
    // Unknown/undecodable non-EVM facet: refund and receiver can't be checked, so fail closed.
    c.bad("refund", "LI.FI non-EVM facet not recognized: refund/depositor not verifiable");
    c.bad("recipient", `LI.FI non-EVM facet not recognized: receiver ${dest} not verifiable`);
    return;
  }
  c.test(
    "refund",
    lc(f.refund) === taker,
    `LI.FI ${f.bridge} refund/depositor ${f.refund} != taker`,
  );
  if (f.receiver === undefined) {
    c.part("recipient", `LI.FI ${f.bridge}: recipient bound off-chain to the order id`);
    return;
  }
  const want = /^(bc1|tb1)/i.test(dest) ? btcReceiverWord(dest) : null;
  if (want)
    c.test(
      "recipient",
      f.receiver === want,
      `LI.FI ${f.bridge} receiver 0x${f.receiver} != ${dest}`,
    );
  else c.test("recipient", contains(data, dest), `non-EVM recipient ${dest} not found in calldata`);
}

async function checkEvmTx(c: Acc, p: Payload, tx: TxRequest, ctx: GuardCtx, dest?: string) {
  const { req, provider } = p;
  const taker = req.taker ? lc(req.taker) : undefined;
  c.test("chain", tx.chainId === req.fromChainId, `tx chain ${tx.chainId} != ${req.fromChainId}`);
  // Router allowlist.
  let allowed = evmAllowed(provider, req.fromChainId);
  let thor: Awaited<ReturnType<typeof thorVault>>;
  if (provider === "thorchain") {
    thor = await thorVault(ctx, req.fromChainId);
    allowed = new Set(thor?.router ? [lc(thor.router)] : []);
  }
  if (provider === "relay")
    allowed = new Set([...allowed, ...(await ctx.relay(req.fromChainId)).contracts]);
  let settlers: string[] = [];
  if (provider === "0x") {
    settlers = await ctx.zeroxSettlers(req.fromChainId);
    allowed = new Set([...allowed, ...settlers]);
  }
  c.test(
    "router",
    allowed.has(lc(tx.to)),
    `tx.to ${tx.to} is not an allowlisted ${provider} router on chain ${req.fromChainId}`,
  );
  // Native value.
  const value = BigInt(tx.value);
  const amount = BigInt(req.amount);
  const cross = req.fromChainId !== req.toChainId;
  const nativeIn = isNativeTok(req.fromChainId, req.fromToken);
  const maxValue = (nativeIn ? amount : 0n) + (cross ? feeCap(req.fromChainId) : 0n);
  c.test("value", value <= maxValue, `tx value ${value} > allowed ${maxValue}`);

  const d: Decoded | null = decodeEvm(provider, tx.data as Hex);
  if (!d) {
    c.part("decode", `unknown selector ${tx.data.slice(0, 10)}`);
    if (dest)
      c.test("recipient", contains(tx.data, dest), `recipient ${dest} not found in calldata`);
    c.part("minOut", "calldata not decoded");
    return;
  }
  c.ok("decode", d.fn);
  if (d.inAmount !== undefined)
    c.test("inAmount", d.inAmount <= amount, `pulls ${d.inAmount} > sell amount ${amount}`);
  if (d.inToken && !(provider === "across" && nativeIn))
    c.test(
      "inToken",
      sameTok(req.fromChainId, d.inToken, req.fromToken),
      `input token ${d.inToken} != ${req.fromToken}`,
    );
  if (d.outToken && !cross)
    c.test(
      "outToken",
      sameTok(req.toChainId, d.outToken, req.toToken),
      `output token ${d.outToken} != ${req.toToken}`,
    );
  if (taker)
    for (const o of d.owners ?? [])
      c.test("owner", o === taker || o === ZERO, `depositor/refund/authority ${o} != taker`);
  if (d.target && settlers.length)
    c.test(
      "target",
      settlers.includes(d.target),
      `0x inner target ${d.target} is not the registered Settler`,
    );
  if (d.dstChainId !== undefined && isEvmChain(req.toChainId) && provider !== "lifi")
    c.test(
      "dstChain",
      d.dstChainId === BigInt(req.toChainId),
      `destination chain ${d.dstChainId} != ${req.toChainId}`,
    );

  // Recipient.
  if (provider === "thorchain") {
    c.test(
      "vault",
      !!thor && d.vault === lc(thor.address),
      `vault ${d.vault} not in THORChain inbound_addresses`,
    );
    if (thor?.halted) c.bad("vault", "THORChain chain halted");
    return checkRecipientMemo(c, d.memo ?? "", dest, p.req.toChainId);
  }
  if (provider === "relay" && d.fn.startsWith("deposit")) {
    // Depository deposit: recipient + min out live in the Relay order the deposit id commits to.
    if (!taker || !dest) return c.part("recipient", "indicative Relay quote without taker");
    const cur = (chainId: number, t: string) =>
      isNativeTok(chainId, t) && isEvmChain(chainId) ? ZERO : t;
    checkRelayOrder(c, {
      order: p.relayOrder,
      proto: await ctx.relayProtocol?.().catch(() => undefined),
      tx,
      fromChainId: req.fromChainId,
      toChainId: req.toChainId,
      fromCurrency: cur(req.fromChainId, req.fromToken),
      toCurrency: cur(req.toChainId, req.toToken),
      amount: BigInt(req.amount),
      taker,
      recipient: dest,
      minOut: minBound(p),
    });
    return;
  }
  if (provider === "relay") {
    if (dest && contains(tx.data, dest)) c.ok("recipient", "found in calldata");
    else if (d.fn.startsWith("deposit"))
      c.part("recipient", "Relay deposit: recipient bound off-chain to the request id");
    else if (dest) c.bad("recipient", `recipient ${dest} not found in calldata`);
    c.part("minOut", "Relay solver fills off-chain");
    return;
  }
  if (provider === "debridge") {
    if (dest) {
      c.test(
        "recipient",
        d.recipientBytes === addrBytes(dest),
        `receiverDst 0x${d.recipientBytes} != ${dest}`,
      );
      c.test(
        "dstAuthority",
        d.dstAuthorityBytes === addrBytes(dest),
        `orderAuthorityDst 0x${d.dstAuthorityBytes} != ${dest}`,
      );
    }
    c.test("externalCall", !d.dstCall, "order carries a destination external call");
  } else if (d.recipient !== undefined && dest) {
    const evmDest = isEvmChain(req.toChainId);
    if (d.recipient === "sender")
      c.test("recipient", lc(dest) === taker, `output goes to msg.sender but recipient is ${dest}`);
    else if (provider === "lifi" && d.recipient === "0x11f111f111f111f111f111f111f111f111f111f1")
      checkLifiNonEvm(c, tx.data as Hex, dest, taker);
    else if (d.dstCall)
      c.test(
        "recipient",
        contains(tx.data, dest),
        `recipient ${dest} not found in destination call`,
      );
    else if (provider === "across" && !evmDest)
      c.test(
        "recipient",
        d.recipientBytes === addrBytes(dest).padStart(64, "0"),
        `recipient ${d.recipientBytes} != ${dest}`,
      );
    else c.test("recipient", d.recipient === lc(dest), `recipient ${d.recipient} != ${dest}`);
  } else if (dest) {
    c.test("recipient", contains(tx.data, dest), `recipient ${dest} not found in calldata`);
  }
  if (d.minOut !== undefined) {
    const b = minBound(p);
    c.test(
      "minOut",
      d.minOut >= b,
      `min output ${d.minOut} < bound ${b} (quote ${p.toAmount}, slippage ${req.slippageBps}bps)`,
    );
  } else if (d.inputMin !== undefined) {
    c.test("inputMin", d.inputMin <= amount, `bridge amount ${d.inputMin} > sell amount`);
    c.part("minOut", "LI.FI bridge facet: output minimum lives in bridge-specific data");
  } else c.part("minOut", `${d.fn} has no decodable min output`);
}

function spenderAllowed(p: Payload, extra: string[]) {
  return evmAllowed(p.provider, p.req.fromChainId, extra);
}

async function checkApprovals(c: Acc, p: Payload, ctx: GuardCtx) {
  const extra: string[] = [];
  if (p.provider === "thorchain") {
    const v = await thorVault(ctx, p.req.fromChainId);
    if (v?.router) extra.push(v.router);
  }
  if (p.provider === "relay") extra.push(...(await ctx.relay(p.req.fromChainId)).contracts);
  if (p.provider === "0x") extra.push(...(await ctx.zeroxSettlers(p.req.fromChainId)));
  if (p.permit2) extra.push(PERMIT2);
  const ok = spenderAllowed(p, extra);
  if (p.approvalAddress)
    c.test(
      "spender",
      ok.has(lc(p.approvalAddress)) || (lc(p.approvalAddress) === PERMIT2 && p.provider === "0x"),
      `approval spender ${p.approvalAddress} not allowlisted for ${p.provider}`,
    );
  if (p.approval) {
    const a = decodeApprove(p.approval.data as Hex);
    c.test(
      "approval.to",
      lc(p.approval.to) === lc(p.req.fromToken),
      `approval tx targets ${p.approval.to}, not the sell token`,
    );
    if (!a) c.bad("approval", "approval tx is not approve(address,uint256)");
    else {
      c.test("approval.spender", ok.has(a.spender), `approve spender ${a.spender} not allowlisted`);
      c.test(
        "approval.amount",
        a.amount <= BigInt(p.req.amount),
        `approve amount ${a.amount} > sell amount (unlimited approvals are never built server-side)`,
      );
    }
    c.test("approval.value", BigInt(p.approval.value) === 0n, "approval tx sends native value");
  }
  if (p.permit2) {
    const m = p.permit2.message as Record<string, any>;
    const vc = lc(String(p.permit2.domain.verifyingContract ?? ""));
    c.test("permit2.contract", vc === PERMIT2, `permit2 verifyingContract ${vc}`);
    const spender = lc(String(m.spender ?? ""));
    c.test("permit2.spender", ok.has(spender), `permit2 spender ${spender} not allowlisted`);
    const amt = BigInt(m.permitted?.amount ?? m.details?.amount ?? 0);
    c.test("permit2.amount", amt <= BigInt(p.req.amount), `permit2 amount ${amt} > sell amount`);
  }
}

function checkOrder(c: Acc, p: Payload, dest?: string) {
  const o = p.order!;
  const m = o.message as Record<string, any>;
  c.test(
    "router",
    lc(String(o.domain.verifyingContract)) === COW_SETTLEMENT,
    `order verifyingContract ${String(o.domain.verifyingContract)} is not CoW settlement`,
  );
  const recv = lc(String(m.receiver ?? ZERO));
  if (dest)
    c.test(
      "recipient",
      recv === lc(dest) || (recv === ZERO && lc(dest) === lc(p.req.taker ?? "")),
      `order receiver ${recv} != ${dest}`,
    );
  c.test(
    "inToken",
    sameTok(p.req.fromChainId, String(m.sellToken), p.req.fromToken),
    `sellToken ${m.sellToken}`,
  );
  c.test(
    "outToken",
    sameTok(p.req.toChainId, String(m.buyToken), p.req.toToken),
    `buyToken ${m.buyToken}`,
  );
  const sell = BigInt(m.sellAmount ?? 0) + BigInt(m.feeAmount ?? 0);
  c.test("inAmount", sell <= BigInt(p.req.amount), `order sells ${sell} > amount`);
  const b = minBound(p);
  c.test("minOut", BigInt(m.buyAmount ?? 0) >= b, `buyAmount ${m.buyAmount} < bound ${b}`);
}

async function checkSvm(c: Acc, p: Payload, n: NonEvmTx, ctx: GuardCtx, dest?: string) {
  const taker = p.req.taker!;
  let ixs;
  try {
    if (n.kind === "svm-base64") {
      const t = parseSvmBase64(String(n.data));
      c.test("feePayer", t.feePayer === taker, `fee payer ${t.feePayer} != taker`);
      ixs = t.ixs;
      const x = crossCheckSvm(
        String(n.data),
        t.feePayer,
        t.ixs.map((i) => i.programId),
      );
      c.test("blocktools", x.length === 0, x.join("; "));
    } else ixs = parseSvmInstructions(n.data as never);
  } catch (e) {
    return c.bad("decode", `cannot parse Solana tx: ${(e as Error).message}`);
  }
  c.ok("decode", `${ixs.length} instructions`);
  const mints = [p.req.fromToken, p.req.toToken, WSOL].filter((m) => m !== nativeOf(SOLANA));
  const fees = [
    ...(SVM_FEE_WALLETS[p.provider] ?? []),
    ...(process.env.SWAPCHAN_FEE_RECIPIENT_SOLANA
      ? [process.env.SWAPCHAN_FEE_RECIPIENT_SOLANA]
      : []),
  ];
  const dests = new Set<string>([taker, ...fees]);
  for (const owner of [taker, ...fees])
    for (const m of mints)
      for (const tp of [TOKEN, TOKEN22]) {
        try {
          dests.add(ata(owner, m, tp));
        } catch {
          /* non-solana mint */
        }
      }
  if (p.provider === "relay") for (const s of (await ctx.relay(SOLANA)).solvers) dests.add(s);
  const v = checkSvmIxs(ixs, taker, SVM_PROGRAMS, dests);
  c.test("programs+transfers", v.fail.length === 0, v.fail.join("; "));
  const cross = p.req.toChainId !== SOLANA;
  const nativeIn = p.req.fromToken === nativeOf(SOLANA);
  const maxLam = (nativeIn ? BigInt(p.req.amount) : 0n) + (cross ? 10n ** 8n : 0n) + 10n ** 7n;
  c.test("value", v.lamportsOut <= maxLam, `moves ${v.lamportsOut} lamports > ${maxLam}`);
  if (!dest) return;
  if (!cross) {
    const outMine = [TOKEN, TOKEN22].map((tp) =>
      p.req.toToken === nativeOf(SOLANA) ? ata(taker, WSOL, tp) : ata(taker, p.req.toToken, tp),
    );
    const swapIx = ixs.find((i) => i.programId.startsWith("JUP6"));
    if (swapIx)
      c.test(
        "recipient",
        swapIx.keys.some((k) => k && outMine.includes(k)),
        `Jupiter destination is not the taker's ${p.req.toToken} token account`,
      );
    else c.part("recipient", "no Jupiter instruction to inspect");
    c.part("minOut", "Solana swap amounts are program-specific");
  } else {
    const blob = ixs
      .map(
        (i) =>
          hex.encode(i.data) + i.keys.map((k) => (k ? hex.encode(base58.decode(k)) : "")).join(""),
      )
      .join("");
    if (contains(blob, dest)) c.ok("recipient", "found in instruction data");
    else if (p.provider === "relay")
      c.part("recipient", "Relay deposit: recipient bound off-chain to the request id");
    else c.bad("recipient", `recipient ${dest} not found in the Solana tx`);
    c.part("minOut", "cross-chain Solana payload");
  }
}

async function checkBtc(c: Acc, p: Payload, n: NonEvmTx, ctx: GuardCtx, dest?: string) {
  const s = String(n.data);
  let psbt: bitcoin.Psbt;
  try {
    psbt = /^[0-9a-fA-F]+$/.test(s) ? bitcoin.Psbt.fromHex(s) : bitcoin.Psbt.fromBase64(s);
  } catch (e) {
    return c.bad("decode", `cannot parse PSBT: ${(e as Error).message}`);
  }
  const taker = p.req.taker!;
  let allowedTo: string[] = [];
  if (p.provider === "thorchain") {
    const v = await thorVault(ctx, p.req.fromChainId);
    allowedTo = v ? [v.address] : [];
  } else if (p.provider === "relay") allowedTo = (await ctx.relay(p.req.fromChainId)).solvers;
  if (p.provider !== "thorchain" && p.provider !== "relay") {
    const v = await thorVault(ctx, p.req.fromChainId);
    allowedTo = v ? [v.address] : [];
  }
  // PRIMARY decoder: the vendored blocktools wasm (not mainnet-only, and it decodes script kinds the old
  // bitcoin.address.fromOutputScript path could not — e.g. Taproot, which this process never inits ECC for).
  // Its failure names are mapped onto the guard's reasons; a decode error or missing wasm fails closed.
  let dec: ReturnType<typeof btDecode>;
  try {
    dec = btDecode(s, "btc");
  } catch (e) {
    return c.bad("decode", `blocktools cannot decode the PSBT: ${(e as Error).message}`);
  }
  if (!dec) return c.bad("blocktools", "blocktools decoder unavailable");
  // Independent second decode: bitcoin.address.fromOutputScript vs blocktools must agree (PSBT + unsigned,
  // every input owned by the taker, output count / address / value identical). Keeps crossCheckPsbt's guarantees.
  const outs = psbt.txOutputs.map((o) => {
    try {
      return {
        address: bitcoin.address.fromOutputScript(o.script, bitcoin.networks.bitcoin),
        value: BigInt(o.value),
      };
    } catch {
      return { address: null, value: BigInt(o.value) };
    }
  });
  const x = crossCheckPsbt(s, outs, taker);
  c.test("blocktools", x.length === 0, x.join("; "));
  // Output decisions (pays / change / value) read from the blocktools decode, ordered by tx index.
  let out = 0n;
  const bad: string[] = [];
  const pays: string[] = [];
  // The OP_RETURN memo: blocktools decodeTx now reports the op_return output's pushed payload (hex) in
  // `op_return`, so the memo is read from the blocktools decode (last OP_RETURN wins, as before) rather
  // than the raw bitcoinjs script. The THORChain memo check is unchanged.
  let memo: string | null = null;
  const bOuts = dec
    .filter((o) => o.role === "output")
    .sort((o1, o2) => (o1.index ?? 0) - (o2.index ?? 0));
  for (const o of bOuts) {
    if (o.kind === "op_return") {
      if (o.op_return) memo = Buffer.from(o.op_return, "hex").toString("utf8");
      continue;
    }
    if (!o.address) {
      bad.push("non-standard output");
      continue;
    }
    if (o.address === taker) continue; // change
    out += BigInt(o.amount ?? "0");
    pays.push(o.address);
  }
  // Relay BTC uses a per-request deposit address (not derivable): allow exactly one payment.
  const relayDeposit = p.provider === "relay" && pays.length === 1;
  for (const a of pays)
    if (!allowedTo.includes(a) && !relayDeposit)
      bad.push(`pays ${a}, not a ${p.provider} vault/solver`);
  if (relayDeposit && !allowedTo.includes(pays[0]!))
    c.part("router", `Relay per-request deposit address ${pays[0]}`);
  c.test("router", bad.length === 0, bad.join("; "));
  c.test("value", out <= BigInt(p.req.amount), `sends ${out} sats > amount`);
  if (memo && p.provider !== "relay") checkRecipientMemo(c, memo, dest, p.req.toChainId);
  else if (p.provider === "relay") {
    c.part("recipient", "Relay deposit: recipient bound off-chain to the request id");
    c.part("minOut", "Relay solver fills off-chain");
  } else c.bad("memo", "no OP_RETURN memo");
}

/** Minimal protobuf reader for Tron raw_data → TriggerSmartContract fields. */
function tronRaw(
  rawHex: string,
): { owner: string; contract: string; callValue: bigint; data: string } | null {
  const b = hex.decode(rawHex.replace(/^0x/, ""));
  const read = (buf: Uint8Array, cb: (f: number, wt: number, v: Uint8Array | bigint) => void) => {
    let i = 0;
    const varint = () => {
      let r = 0n;
      let sh = 0n;
      for (;;) {
        const x = buf[i++]!;
        r |= BigInt(x & 0x7f) << sh;
        if (!(x & 0x80)) return r;
        sh += 7n;
      }
    };
    while (i < buf.length) {
      const tag = Number(varint());
      const f = tag >> 3;
      const wt = tag & 7;
      if (wt === 0) cb(f, wt, varint());
      else if (wt === 2) {
        const len = Number(varint());
        cb(f, wt, buf.slice(i, i + len));
        i += len;
      } else if (wt === 1) i += 8;
      else if (wt === 5) i += 4;
      else throw new Error("bad wire type");
    }
  };
  let res: ReturnType<typeof tronRaw> = null;
  try {
    read(b, (f, _wt, v) => {
      if (f !== 11 || !(v instanceof Uint8Array)) return; // raw_data.contract
      read(v, (f2, _w2, v2) => {
        if (f2 !== 2 || !(v2 instanceof Uint8Array)) return; // parameter (Any)
        read(v2, (f3, _w3, v3) => {
          if (f3 !== 2 || !(v3 instanceof Uint8Array)) return; // Any.value
          const r = { owner: "", contract: "", callValue: 0n, data: "" };
          read(v3, (f4, _w4, v4) => {
            if (f4 === 1 && v4 instanceof Uint8Array) r.owner = hex.encode(v4);
            if (f4 === 2 && v4 instanceof Uint8Array) r.contract = hex.encode(v4);
            if (f4 === 3 && typeof v4 === "bigint") r.callValue = v4;
            if (f4 === 4 && v4 instanceof Uint8Array) r.data = hex.encode(v4);
          });
          res = r;
        });
      });
    });
  } catch {
    return null;
  }
  return res;
}
const tronHex = (a: string) => hex.encode(base58.decode(a).slice(0, 21));

/**
 * LTC/DOGE/BCH PSBT to a THORChain vault. blocktools' verifyThorSend does the whole check (no TS fallback; missing
 * WASM = refused): outputs exactly [vault == amount, optional change to the taker, OP_RETURN == memo], every input
 * value proven (prev_tx for legacy) and owned by the taker, no RBF, fee under the chain cap. The memo it read back
 * must then pay this request's validated recipient.
 */
async function checkUtxo(c: Acc, p: Payload, n: NonEvmTx, ctx: GuardCtx, dest?: string) {
  const d = UTXO_DEST[p.req.fromChainId];
  if (!d) return c.bad("chain", `chain ${p.req.fromChainId} is not LTC, DOGE or BCH`);
  if (p.provider !== "thorchain") return c.bad("router", `${d.sym} is sent through THORChain only`);
  if (n.kind !== "uvm-psbt") return c.bad("decode", `unexpected ${n.kind} payload for ${d.sym}`);
  const data = n.data as { psbt?: unknown; summary?: { memo?: unknown } } | null;
  const psbt = typeof data?.psbt === "string" ? data.psbt : "";
  const quoted = typeof data?.summary?.memo === "string" ? data.summary.memo : "";
  if (!psbt || !quoted) return c.bad("decode", "PSBT or memo missing");
  const taker = p.req.taker;
  if (!taker) return c.bad("taker", "no sending address");
  const tv = validateUtxoRecipient(p.req.fromChainId, taker);
  if (!tv.ok) return c.bad("taker", tv.reason);
  const memo = expectedThorMemo(quoted, p.req.toChainId, dest, tv.address);
  if (!memo) return c.bad("memo", "cannot build the expected THORChain memo for this request");
  const v = await thorVault(ctx, p.req.fromChainId);
  if (!v) return c.bad("router", `THORChain ${d.sym} vault unavailable`);
  if (v.halted) return c.bad("router", `THORChain ${d.sym} is halted`);
  const from = fullAddr(p.req.fromChainId, tv.address);
  let r: ReturnType<typeof btVerifyThorSend>;
  try {
    r = btVerifyThorSend(
      d.bt,
      psbt,
      fullAddr(p.req.fromChainId, v.address),
      memo,
      BigInt(p.req.amount),
      from,
      [from],
      null,
    );
  } catch (e) {
    return c.bad(
      "blocktools",
      `blocktools unavailable: ${String((e as Error).message).slice(0, 80)}`,
    );
  }
  // Two layers, both kept. SwapChan's own memo checks on the memo read back from the PSBT give the specific
  // reasons ("recipient", "outToken", "minOut"); blocktools' exact byte compare of the whole send comes on top,
  // its failure names mapped onto SwapChan's guard reasons.
  const onChain = r.memo;
  if (onChain === null) c.bad("memo", "no THORChain memo (OP_RETURN) in the PSBT");
  else checkRecipientMemo(c, onChain, dest, p.req.toChainId);
  if (onChain !== null && onChain !== memo)
    c.bad("memo", "PSBT memo differs from the memo SwapChan expects (bytes, case included)");
  const bad = new Map<string, string[]>();
  for (const f of r.failures) {
    const k = THOR_SEND_REASON[f] ?? "blocktools";
    bad.set(k, [...(bad.get(k) ?? []), f]);
  }
  for (const [k, fs] of bad) c.bad(k, `blocktools verifyThorSend: ${fs.join(", ")}`);
  if (r.ok && bad.size === 0) c.ok("blocktools");
  else if (!bad.size) c.bad("blocktools", "verifyThorSend did not pass");
}
/** blocktools verifyThorSend failure name -> SwapChan guard reason. */
export const THOR_SEND_REASON: Record<string, string> = {
  vault: "router",
  vault_invalid: "router",
  amount: "value",
  memo: "memo",
  change: "change",
  change_invalid: "change",
  output_count: "outputs",
  rbf: "rbf",
  fee: "fee",
  input_unknown: "input",
  input_foreign: "input",
  taker_invalid: "taker",
  tx: "decode",
  chain: "chain",
};

async function checkTron(c: Acc, p: Payload, n: NonEvmTx, ctx: GuardCtx, dest?: string) {
  const taker = p.req.taker!;
  if (n.kind === "tvm-deposit") {
    const d = n.data as { to: string; amount: string; memo: string };
    const v = await thorVault(ctx, p.req.fromChainId);
    c.test(
      "router",
      !!v && v.address === d.to,
      `deposit to ${d.to} is not the THORChain Tron vault`,
    );
    c.test("value", BigInt(d.amount) <= BigInt(p.req.amount), "deposit > amount");
    return checkRecipientMemo(c, d.memo, dest, p.req.toChainId);
  }
  const d = n.data as { calls?: { parameter: Record<string, any> }[]; raw?: string };
  const calls = d.calls
    ? d.calls.map((x) => ({
        owner: lc(String(x.parameter.owner_address)),
        contract: lc(String(x.parameter.contract_address)),
        callValue: BigInt(x.parameter.call_value ?? 0),
        data: lc(String(x.parameter.data ?? "")),
      }))
    : d.raw
      ? [tronRaw(d.raw)].filter((x) => !!x)
      : [];
  if (!calls.length) return c.bad("decode", "cannot decode Tron transaction");
  c.ok("decode", `${calls.length} TriggerSmartContract`);
  const allowed = (TVM_CONTRACTS[p.provider] ?? []).map(tronHex);
  const me = tronHex(taker);
  let val = 0n;
  for (const x of calls) {
    c.test("owner", x!.owner === me, `owner ${x!.owner} != taker`);
    c.test(
      "router",
      allowed.includes(x!.contract),
      `contract 41${x!.contract.slice(2)} not allowlisted for ${p.provider}`,
    );
    val += x!.callValue;
  }
  const nativeIn = p.req.fromToken === nativeOf(p.req.fromChainId);
  const max = (nativeIn ? BigInt(p.req.amount) : 0n) + 50n * 10n ** 6n;
  c.test("value", val <= max, `call_value ${val} > ${max}`);
  const data = calls.map((x) => x!.data).join("");
  if (dest && contains(data, dest)) c.ok("recipient", "found in calldata");
  else if (p.provider === "relay" && dest)
    c.part("recipient", "Relay deposit: recipient bound off-chain to the request id");
  else if (dest) c.bad("recipient", `recipient ${dest} not found in Tron calldata`);
  c.part("minOut", "Tron calldata min output not decoded");
}

/** Verify everything in a payload. Never throws: an exception is a failed check. */
export async function verifyPayload(p: Payload, ctx: GuardCtx): Promise<Verification> {
  const c = new Acc();
  const { req } = p;
  const sameVm = sameAddressSpace(req.fromChainId, req.toChainId);
  const dest = req.recipient ?? (sameVm ? req.taker : undefined);
  try {
    // Fail closed: a Relay order from a chain with no confirmed depository pin is refused before
    // anything else runs, so Relay's /chains list is never fetched or used as a fallback.
    if (p.provider === "relay" && !relayChainPinned(req.fromChainId, ctx.relayPins)) {
      c.bad("relayChainPinned", relayNotPinnedMessage(req.fromChainId));
      return { verified: false, level: "full", checks: c.checks };
    }
    await checkApprovals(c, p, ctx);
    if (p.order) checkOrder(c, p, dest);
    else if (p.tx && p.tx.data !== "0x") await checkEvmTx(c, p, p.tx, ctx, dest);
    else if (p.nonEvmTx) {
      if (!req.taker) c.part("taker", "indicative quote without taker");
      else if (p.nonEvmTx.vm === "svm") await checkSvm(c, p, p.nonEvmTx, ctx, dest);
      else if (p.nonEvmTx.vm === "bvm") await checkBtc(c, p, p.nonEvmTx, ctx, dest);
      else if (p.nonEvmTx.vm === "uvm") await checkUtxo(c, p, p.nonEvmTx, ctx, dest);
      else await checkTron(c, p, p.nonEvmTx, ctx, dest);
    } else if (p.tx && p.tx.data === "0x") {
      c.bad("tx", "empty calldata");
    }
  } catch (e) {
    c.bad("guard", `verification error: ${(e as Error).message}`);
  }
  const failed = c.checks.some((x) => !x.ok);
  const hasPayload = !!(p.tx || p.order || p.nonEvmTx);
  const indicative = !req.taker || !hasPayload;
  return {
    verified: !failed && !indicative,
    level: indicative ? "indicative" : c.partial ? "partial" : "full",
    checks: c.checks,
  };
}

export const quotePayload = (q: Quote): Payload => ({
  provider: q.provider,
  req: q.request,
  toAmount: q.toAmount,
  approvalAddress: q.approvalAddress,
  tx: q.tx,
  order: q.order,
  nonEvmTx: q.nonEvmTx,
  relayOrder: q.relayOrder,
});

export const buildPayload = (q: Quote, req: QuoteRequest, b: BuildResponse): Payload => ({
  provider: q.provider,
  req,
  toAmount: q.toAmount,
  approvalAddress: q.approvalAddress,
  tx: b.execution === "order" || b.execution === "nonevm" ? null : b,
  approval: b.approval,
  permit2: b.permit2,
  order: b.order,
  nonEvmTx: b.nonEvmTx,
  relayOrder: b.relayOrder,
});

export const failures = (v: Verification) =>
  v.checks
    .filter((x) => !x.ok)
    .map((x) => `${x.name}: ${x.detail ?? "failed"}`)
    .join("; ");

/** Self-check for /onchain/revoke: approve(spender, 0) on the token, nothing else. */
export function verifyRevoke(
  tx: { to: string; data: string; value: string },
  token: string,
  spender: string,
) {
  const a = decodeApprove(tx.data as Hex);
  if (
    !a ||
    a.amount !== 0n ||
    a.spender !== lc(spender) ||
    lc(tx.to) !== lc(token) ||
    tx.value !== "0"
  )
    throw new Error("revoke tx failed self-verification");
}
