import { type BuildResponse, type Quote, vmOf } from "@swapchan/shared";
import { decodeFunctionData, erc20Abi } from "viem";

const NATIVE = new Set([
  "0x0000000000000000000000000000000000000000",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
]);
const ZERO = "0x0000000000000000000000000000000000000000";
const isEvm = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
const same = (a: unknown, b: string) =>
  typeof a === "string" && (isEvm(b) ? a.toLowerCase() === b.toLowerCase() : a === b);
const big = (v: unknown): bigint | null => {
  try {
    return typeof v === "bigint" ? v : BigInt(String(v));
  } catch {
    return null;
  }
};

/**
 * Client-side check of a /build response before anything is signed. Independent of the API's own
 * guard: the swap card must not trust the response blindly. Returns a list of problems; empty = ok.
 * Fail closed: anything that cannot be checked is a problem.
 */
export function checkBuilt(built: BuildResponse, quote: Quote, taker: string): string[] {
  const r = quote.request;
  const out: string[] = [];
  const payout = r.recipient ?? taker;
  const crossChain = r.fromChainId !== r.toChainId;
  if (built.verified !== true) out.push("API did not verify this payload");
  if (
    built.fallbackFrom ||
    (built.quoteId && built.quoteId !== quote.id) ||
    (built.provider && built.provider !== quote.provider)
  )
    out.push("route changed after review");
  if (!built.payoutTo || !same(built.payoutTo, payout))
    out.push(`payout goes to ${built.payoutTo ?? "unknown"}, expected ${payout}`);

  if (built.execution === "nonevm") {
    // Solana/Tron/Bitcoin payloads are opaque here; the checks above (API verification of the
    // decoded payload, payout pinned to you) are what's feasible client-side.
    const n = built.nonEvmTx;
    if (!n) out.push("no transaction in response");
    else if (n.vm !== vmOf(r.fromChainId))
      out.push(`a ${n.vm} transaction for a ${vmOf(r.fromChainId)} chain`);
    // The API's blocktools cross-decode (guard "blocktools" check) must have run and passed.
    const v = built.verification?.checks ?? [];
    if (v.some((c) => !c.ok)) out.push("a server check failed");
    if (
      n &&
      n.kind !== "tvm-deposit" &&
      n.kind !== "tvm-json" &&
      n.kind !== "svm-instructions" &&
      !v.some((c) => c.name === "blocktools" && c.ok)
    )
      out.push("transaction was not cross-checked by blocktools");
    return out;
  }

  if (built.execution === "order") {
    const o = built.order;
    const m = (o?.message ?? {}) as Record<string, unknown>;
    const d = (o?.domain ?? {}) as Record<string, unknown>;
    if (!o) out.push("no order in response");
    else {
      if (Number(d.chainId) !== r.fromChainId) out.push("order is for another chain");
      if (!same(m.sellToken, r.fromToken)) out.push("order sells a different token");
      if (!same(m.buyToken, r.toToken)) out.push("order buys a different token");
      const recv = String(m.receiver ?? "");
      if (!(same(recv, payout) || (recv.toLowerCase() === ZERO && same(payout, taker))))
        out.push(`order pays ${recv || "unknown"}, expected ${payout}`);
      const sell = big(m.sellAmount);
      const fee = big(m.feeAmount ?? 0);
      if (sell === null || fee === null || sell + fee > BigInt(r.amount))
        out.push("order sells more than the amount you entered");
    }
    return out;
  }

  // Plain EVM tx (+ optional approval).
  if (built.chainId !== r.fromChainId)
    out.push(`tx is for chain ${built.chainId}, expected ${r.fromChainId}`);
  const value = big(built.value);
  const amount = BigInt(r.amount);
  const nativeIn = NATIVE.has(r.fromToken.toLowerCase());
  if (value === null) out.push("bad tx value");
  else if (nativeIn) {
    // Same-chain: at most the amount (+1% headroom). Cross-chain: bridge messaging fee headroom 10%.
    const cap = amount + (amount * (crossChain ? 10n : 1n)) / 100n;
    if (value > cap) out.push("tx sends more native coin than the amount you entered");
  } else if (!crossChain) {
    if (value !== 0n) out.push("tx sends native coin on a token swap");
  } else {
    // Cross-chain token swap: native value only pays the bridge's messaging fee, which the quote
    // states in its own tx. Cap at that (+10% for fee drift); no quoted fee means no value allowed.
    const need = quote.tx ? big(quote.tx.value) : 0n;
    if (need === null) out.push("bad quoted tx value");
    else if (value > need + need / 10n)
      out.push(`tx sends ${value} native on a token swap; the quote requires at most ${need}`);
  }

  const a = built.approval;
  if (a) {
    if (nativeIn) out.push("unexpected approval on a native-coin swap");
    if (a.chainId !== r.fromChainId) out.push("approval is for another chain");
    if (!same(a.to, r.fromToken)) out.push("approval is for a different token");
    if (big(a.value) !== 0n) out.push("approval sends native coin");
    try {
      const call = decodeFunctionData({ abi: erc20Abi, data: a.data as `0x${string}` });
      if (call.functionName !== "approve")
        out.push(`approval is ${call.functionName}, not approve`);
      else {
        const [spender, amt] = call.args as readonly [string, bigint];
        const okSpender =
          same(spender, built.to) ||
          (!!quote.approvalAddress && same(spender, quote.approvalAddress));
        if (!okSpender) out.push(`approval spender ${spender} is not the swap contract`);
        if (amt !== amount) out.push("approval is not exactly the swap amount");
      }
    } catch {
      out.push("approval calldata is not an ERC-20 approve");
    }
  }
  return out;
}

/** Throw (fail closed) if the built payload doesn't match what the user asked for. */
export function assertBuilt(built: BuildResponse, quote: Quote, taker: string): void {
  const p = checkBuilt(built, quote, taker);
  if (p.length) throw new Error(`Refusing to sign: ${p.join("; ")}`);
}
