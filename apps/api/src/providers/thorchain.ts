import {
  BITCOIN,
  BITCOIN_CASH,
  type BuildResponse,
  DOGECOIN,
  fromBaseUnits,
  LITECOIN,
  NON_EVM,
  type NonEvmTx,
  Quote,
  type QuoteRequest,
  sameAddressSpace,
  TRON,
  type UtxoDeposit,
  UtxoTrack,
  vmOf,
} from "@swapchan/shared";
import { encodeFunctionData } from "../blocktools.js";

import { buildBtcPsbt, type UtxoSource } from "../btc.js";
import { thorMemoMismatch } from "../guard/index.js";
import { type Pricer, ZERO_ADDRESS } from "../pricing.js";
import { RouteRefused, UTXO_DEST, validateUtxoRecipient } from "../utxodest.js";
import { buildUtxoSend, MEMO_LIMIT } from "../utxosend.js";
import { tronUsdcSettlement } from "./thorchain-tron-settlement.js";
import { type Fetch, getJson, type ProviderAdapter, placeholderFor } from "./types.js";

/** THORChain's error when memo + refund + affiliate exceed the source chain's memo limit (BTC: 80 bytes). */
const MEMO_TOO_LONG = /memo too long/i;
/** THORChain's dust thresholds (inbound_addresses, 8-decimal base units; measured 2026-10-27). Checked before any
 *  quote call so a too-small send is a clear 400, never THORChain's raw error as a 500. */
export const UTXO_MIN: Record<number, bigint> = {
  [LITECOIN]: 100_000n,
  [DOGECOIN]: 100_000_000n,
  [BITCOIN_CASH]: 10_000n,
};
const DUST = /dust threshold/i;
const MIN_SWAP = /min(?:imum)? swap amount(?:[^\d]*recommended_min_amount_in:\s*(\d+))?/i;
const TOO_LOW = /amount (?:is )?(?:too (?:low|small)|less than)/i;
/** THORChain's zero-output refusal ("emit asset 0 less than price limit"): the amount is below what it can swap.
 *  A non-zero emit under the price limit is a slippage refusal and stays unmapped. */
const PRICE_LIMIT = /emit asset 0 less than price limit/i;
/** "fail swap, invalid amount": e.g. 10^30 base units. */
const INVALID_AMOUNT = /\binvalid amount\b/i;
export const AMOUNT_INVALID = "amount invalid or too large";
/** THORChain's practical minimum (recommended_min_amount_in, 1e8 units) as shown to users; null when absent. */
export const practicalOf = (raw: string | undefined) =>
  raw && /^\d+$/.test(raw) && BigInt(raw) > 0n
    ? {
        amount: raw,
        display: fromBaseUnits(BigInt(raw), 8),
        note: "THORChain's current estimate of its minimum; it changes with fees and can be higher when you send",
      }
    : null;
export const belowMinimum = (min: bigint, sym: string) =>
  `below minimum: send at least ${fromBaseUnits(min, 8)} ${sym}`;
const DEFAULT_BASE = "https://gateway.liquify.com/chain/thorchain_api/thorchain";
/** Our chain id -> THORChain chain prefix. */
const PREFIX: Record<number, string> = {
  1: "ETH",
  8453: "BASE",
  56: "BSC",
  43114: "AVAX",
  [BITCOIN]: "BTC",
  [TRON]: "TRON",
  // THORChain-only UTXO coins (both directions; Relay and LI.FI never see them, see aggregate.ts).
  [LITECOIN]: "LTC",
  [DOGECOIN]: "DOGE",
  [BITCOIN_CASH]: "BCH",
};
const NATIVE: Record<string, string> = {
  ETH: "ETH.ETH",
  BASE: "BASE.ETH",
  BSC: "BSC.BNB",
  AVAX: "AVAX.AVAX",
  BTC: "BTC.BTC",
  TRON: "TRON.TRX",
  LTC: "LTC.LTC",
  DOGE: "DOGE.DOGE",
  BCH: "BCH.BCH",
};
const isNative = (chainId: number, a: string) =>
  NON_EVM[chainId]?.native === a ||
  a.toLowerCase() === ZERO_ADDRESS ||
  a.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

const routerAbi = [
  {
    name: "depositWithExpiry",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "vault", type: "address" },
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "memo", type: "string" },
      { name: "expiration", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

interface ThorQuote {
  inbound_address: string;
  router?: string;
  memo: string;
  expected_amount_out: string;
  expiry: number;
  total_swap_seconds?: number;
  recommended_gas_rate?: string;
  /** smallest inbound THORChain observes on this chain (base units, 1e8); at or below it the coins are lost */
  dust_threshold?: string;
  recommended_min_amount_in?: string;
  fees: { asset: string; affiliate: string; outbound: string; liquidity: string; total: string };
  error?: string;
  message?: string;
}

/** THORChain liquidity_tolerance_bps floor. The limit THORChain writes into the memo is expected_amount_out (already net
 *  of swap, outbound and affiliate fees) minus this many bps, so 1% is tighter than the old tolerance_bps=300, which was
 *  measured against the input value and counted fees: measured 2026-10-27, 0.5 LTC->BTC with tolerance_bps 100 and 300
 *  fails ("emit asset 34166 less than price limit 34970 / 34264") while liquidity_tolerance_bps 50/100/300 quotes with
 *  memo limits 33960/33789/33107 against expected 34131. */
const TOLERANCE_FLOOR_BPS = 100;

/** Block-explorer link for a THORChain outbound (thornode ids carry no 0x and may be upper case). */
export function explorerTx(chain: string, id: string): string | null {
  const h = id.toLowerCase().replace(/^0x/, "");
  const evm: Record<string, string> = {
    ETH: "https://etherscan.io/tx/0x",
    BASE: "https://basescan.org/tx/0x",
    BSC: "https://bscscan.com/tx/0x",
    AVAX: "https://snowtrace.io/tx/0x",
  };
  const other: Record<string, string> = {
    BTC: "https://mempool.space/tx/",
    LTC: "https://blockchair.com/litecoin/transaction/",
    DOGE: "https://blockchair.com/dogecoin/transaction/",
    BCH: "https://blockchair.com/bitcoin-cash/transaction/",
    TRON: "https://tronscan.org/#/transaction/",
  };
  if (!/^[0-9a-f]{64}$/.test(h)) return null;
  if (evm[chain]) return `${evm[chain]}${h}`;
  if (other[chain]) return `${other[chain]}${h}`;
  return null;
}
const normVault = (a: string) =>
  a
    .trim()
    .toLowerCase()
    .replace(/^bitcoincash:/, "");

const scale = (x: bigint, from: number, to: number) =>
  to >= from ? x * 10n ** BigInt(to - from) : x / 10n ** BigInt(from - to);

/**
 * THORChain native swaps (BTC, ETH, BASE, BSC, AVAX, TRON L1 assets). Keyless. Our fee is
 * the affiliate fee, which needs the THORName (THORCHAIN_AFFILIATE, default "swapchan", checked on
 * thornode every 10 min); until it exists,
 * routes run fee-free and rank with our fee as a handicap. Measured from fees.affiliate.
 */
export type ThorAdapter = ProviderAdapter & {
  /** Deposit-address flow for LTC/DOGE/BCH: vault, exact amount, memo, minimum, expiry. refund is optional and goes
   *  in the memo only if THORChain fits it; otherwise refunds go to the sending address (said plainly). */
  deposit(req: QuoteRequest, refund: string | undefined, signal: AbortSignal): Promise<UtxoDeposit>;
  /** Read-only progress of an inbound txid on THORChain. */
  track(txid: string, signal: AbortSignal): Promise<UtxoTrack>;
};

export function thorchain(
  pricer: Pricer,
  env: NodeJS.ProcessEnv,
  f: Fetch = fetch,
  utxos?: UtxoSource,
): ThorAdapter {
  const base = env.THORNODE_URL || DEFAULT_BASE;
  /** Last recommended_min_amount_in seen per source asset (1e8 units), for replies that carry no number. */
  const lastPractical = new Map<string, bigint>();
  const affiliate = env.THORCHAIN_AFFILIATE || "swapchan";
  // Only send the affiliate once the THORName exists (THORChain rejects unknown names).
  let named: { at: number; v: Promise<boolean> } | undefined;
  const nameLive = () => {
    if (!named || Date.now() - named.at > 600_000)
      named = {
        at: Date.now(),
        v: getJson<{ aliases?: { chain: string }[] }>(f, `${base}/thorname/${affiliate}`, {})
          .then((t) => !!t?.aliases?.some((a) => a.chain === "THOR"))
          .catch(() => false),
      };
    return named.v;
  };
  const feeBps = Number(env.SWAPCHAN_FEE_BPS ?? 0);
  let pools: { at: number; v: Promise<Set<string>> } | undefined;
  const poolSet = () => {
    if (!pools || Date.now() - pools.at > 600_000)
      pools = {
        at: Date.now(),
        v: getJson<{ asset: string; status: string }[]>(f, `${base}/pools`, {}).then(
          (ps) => new Set(ps.filter((p) => p.status === "Available").map((p) => p.asset)),
        ),
      };
    return pools.v;
  };
  const assetOf = async (chainId: number, token: string) => {
    const pre = PREFIX[chainId];
    if (!pre) return null;
    if (isNative(chainId, token)) return NATIVE[pre] ?? null;
    const set = await poolSet();
    const up = token.toUpperCase();
    for (const a of set)
      if (a.startsWith(`${pre}.`) && a.toUpperCase().endsWith(`-${up}`)) return a;
    return null;
  };
  /** refund: overrides req.taker (the deposit flow passes the user's refund address). keepRefund: never drop it on
   *  "memo too long" (refuse instead). The deposit flow does NOT set it: measured 2026-10-27, THORChain refuses every
   *  LTC/DOGE/BCH memo that names a refund address, so it drops the refund and tells the user plainly that refunds go
   *  back to the sending address. */
  const call = async (
    req: QuoteRequest,
    signal: AbortSignal,
    opts: { keepRefund?: boolean; refund?: string } = {},
  ) => {
    const floor = UTXO_MIN[req.fromChainId];
    if (floor !== undefined && /^\d+$/.test(req.amount) && BigInt(req.amount) < floor)
      throw new RouteRefused(belowMinimum(floor, PREFIX[req.fromChainId] ?? ""));
    const [fromAsset, toAsset, src, dst] = await Promise.all([
      assetOf(req.fromChainId, req.fromToken),
      assetOf(req.toChainId, req.toToken),
      pricer.token(req.fromChainId, req.fromToken),
      pricer.token(req.toChainId, req.toToken),
    ]);
    if (!fromAsset || !toAsset) throw new Error("asset not in a THORChain pool");
    if (!src || !dst) throw new Error("unknown token decimals");
    // LTC/DOGE/BCH share the "uvm" tag but not addresses: LTC -> DOGE is a cross-chain payout.
    const sameVm = sameAddressSpace(req.fromChainId, req.toChainId);
    let destination =
      req.recipient ?? (sameVm && req.taker ? req.taker : placeholderFor(req.toChainId));
    if (UTXO_DEST[req.toChainId]) {
      // Receive-only UTXO payout: native coin only, recipient blocktools-validated and canonical (BCH prefixless:
      // memos are colon-separated). Re-checked here so no caller path can put an unvalidated address in a memo.
      if (!isNative(req.toChainId, req.toToken)) throw new Error("THORChain: only the native coin");
      if (req.recipient !== undefined) {
        const v = validateUtxoRecipient(req.toChainId, req.recipient);
        if (!v.ok) throw new Error(`recipient: ${v.reason}`);
        destination = v.address;
      }
    }
    const q = new URLSearchParams({
      from_asset: fromAsset,
      to_asset: toAsset,
      amount: scale(BigInt(req.amount), src.decimals, 8).toString(),
      destination,
      streaming_interval: "1",
      streaming_quantity: "0",
      // liquidity_tolerance_bps (THORChain's preferred price-limit parameter): limit = expected_amount_out minus this
      // many bps. tolerance_bps ignores fees and refuses small swaps whose fees exceed it.
      liquidity_tolerance_bps: String(Math.max(req.slippageBps, TOLERANCE_FLOOR_BPS)),
    });
    let refund = opts.refund ?? req.taker;
    if (refund && UTXO_DEST[req.fromChainId]) {
      // LTC/DOGE/BCH origin: the refund address goes into the memo, so it is blocktools-validated for the sending
      // chain and canonical (BCH prefixless) like any payout address.
      const v = validateUtxoRecipient(req.fromChainId, refund);
      if (!v.ok) throw new RouteRefused(`refund address: ${v.reason}`);
      refund = v.address;
    }
    if (refund) q.set("refund_address", refund);
    if (affiliate && feeBps > 0 && (await nameLive())) {
      q.set("affiliate", affiliate);
      q.set("affiliate_bps", String(feeBps));
    }
    // THORChain answers an over-long memo with HTTP 400, which getJson throws; read it as an error body.
    const ask = () =>
      getJson<ThorQuote>(f, `${base}/quote/swap?${q}`, { signal }).catch(
        (e: unknown): ThorQuote => {
          if (
            e instanceof Error &&
            (MEMO_TOO_LONG.test(e.message) ||
              DUST.test(e.message) ||
              MIN_SWAP.test(e.message) ||
              TOO_LOW.test(e.message) ||
              PRICE_LIMIT.test(e.message) ||
              INVALID_AMOUNT.test(e.message))
          )
            return { error: e.message } as ThorQuote;
          throw e;
        },
      );
    let r = await ask();
    let refundDropped = false;
    const err = r.error ?? r.message;
    if (
      err &&
      MEMO_TOO_LONG.test(err) &&
      q.has("refund_address") &&
      !opts.keepRefund &&
      (vmOf(req.fromChainId) === "bvm" || vmOf(req.fromChainId) === "uvm")
    ) {
      // Bitcoin memos ride in an 80-byte OP_RETURN. "=:e:<42-char 0x addr>:LIM/1/0" is already ~52 bytes, so
      // "/<refund>" overflows for every BTC address type. THORChain refunds to the sending address when the memo
      // names none, and our PSBT spends only the taker's UTXOs, so a refund still goes to req.taker.
      // The affiliate is never dropped: if it is what overflows, the retry fails and we refuse below.
      // LTC/DOGE/BCH behave like BTC. Measured 2026-10-27 on thornode: every LTC, DOGE and BCH quote that names a
      // refund address answers "generated memo too long" (BCH included: a ~102-byte memo is refused although an
      // OP_RETURN could carry 220). In the PSBT path the PSBT spends only the taker's coins, so the default refund
      // is the taker; the deposit flow says plainly that refunds go to the sending address.
      q.delete("refund_address");
      r = await ask();
      refundDropped = true;
    }
    if (r.error || r.message) {
      const e = r.error ?? r.message ?? "";
      const sym = isNative(req.fromChainId, req.fromToken)
        ? (PREFIX[req.fromChainId] ?? fromAsset)
        : fromAsset;
      if (INVALID_AMOUNT.test(e)) throw new RouteRefused(AMOUNT_INVALID);
      const ms = MIN_SWAP.exec(e);
      if (ms?.[1]) {
        lastPractical.set(fromAsset, BigInt(ms[1]));
        throw new RouteRefused(belowMinimum(BigInt(ms[1]), sym));
      }
      if (DUST.test(e) || ms || TOO_LOW.test(e) || PRICE_LIMIT.test(e)) {
        // Price-limit replies carry no number: use THORChain's last recommended minimum for this asset when
        // one was seen, else our floor (or a plain "send more").
        const floor = UTXO_MIN[req.fromChainId];
        const seen = lastPractical.get(fromAsset);
        const min = seen !== undefined && (floor === undefined || seen > floor) ? seen : floor;
        throw new RouteRefused(
          min !== undefined
            ? belowMinimum(min, sym)
            : `below minimum: the amount is under THORChain's minimum for ${sym}; send more`,
        );
      }
      if (MEMO_TOO_LONG.test(e)) {
        const sym = PREFIX[req.fromChainId] ?? "this chain";
        // BCH: THORChain enforces its own limit below the 220-byte OP_RETURN (measured: ~102 bytes refused).
        const lim =
          sym === "BCH"
            ? "THORChain's memo limit"
            : `${sym === "BTC" ? 80 : (MEMO_LIMIT[sym.toLowerCase()] ?? 80)}-byte OP_RETURN`;
        throw new RouteRefused(
          opts.keepRefund
            ? `THORChain: the swap memo with a refund address does not fit ${sym}'s ${lim}; THORChain accepts no refund address in the memo for this route`
            : `THORChain: the swap memo does not fit ${sym}'s ${lim} even without a refund address; refusing rather than dropping SwapChan's fee`,
        );
      }
      throw new Error(e);
    }
    if (refundDropped) {
      // Trust THORChain's own memo: its destination field must name no refund address.
      const destField = (r.memo ?? "").split(":")[2] ?? "";
      if (destField.includes("/"))
        throw new Error("THORChain: unexpected refund address in shortened memo");
    }
    if (r.recommended_min_amount_in && /^\d+$/.test(r.recommended_min_amount_in))
      lastPractical.set(fromAsset, BigInt(r.recommended_min_amount_in));
    return { r, src, dst, refundDropped, toAsset, destination };
  };

  const toTx = async (
    req: QuoteRequest,
    r: ThorQuote,
  ): Promise<{ tx: Quote["tx"]; nonEvmTx?: NonEvmTx; approval: string | null }> => {
    const vm = vmOf(req.fromChainId);
    if (vm === "evm") {
      const native = isNative(req.fromChainId, req.fromToken);
      if (!r.router) throw new Error("THORChain returned no router");
      return {
        approval: native ? null : r.router,
        tx: req.taker
          ? {
              chainId: req.fromChainId,
              to: r.router as `0x${string}`,
              data: encodeFunctionData({
                abi: routerAbi,
                functionName: "depositWithExpiry",
                args: [
                  r.inbound_address as `0x${string}`,
                  (native ? ZERO_ADDRESS : req.fromToken) as `0x${string}`,
                  BigInt(req.amount),
                  r.memo,
                  BigInt(r.expiry),
                ],
              }),
              value: native ? req.amount : "0",
            }
          : null,
      };
    }
    if (vm === "tvm") {
      if (!isNative(req.fromChainId, req.fromToken))
        throw new Error("THORChain: only TRX from Tron");
      return {
        approval: null,
        tx: null,
        nonEvmTx: {
          vm,
          kind: "tvm-deposit",
          data: { to: r.inbound_address, amount: req.amount, memo: r.memo },
        },
      };
    }
    if (vm === "bvm") {
      if (!req.taker || !utxos) return { approval: null, tx: null };
      const psbt = await buildBtcPsbt(utxos, {
        from: req.taker,
        to: r.inbound_address,
        amount: BigInt(req.amount),
        memo: r.memo,
        feeRate: Number(r.recommended_gas_rate ?? 5),
      });
      return { approval: null, tx: null, nonEvmTx: { vm, kind: "bvm-psbt", data: psbt } };
    }
    if (vm === "uvm") {
      if (!isNative(req.fromChainId, req.fromToken))
        throw new RouteRefused("THORChain: only the native coin can be sent from this chain");
      if (!req.taker) return { approval: null, tx: null };
      const amount = BigInt(req.amount);
      if (r.dust_threshold && amount <= BigInt(r.dust_threshold))
        throw new RouteRefused(
          `amount is at or below THORChain's minimum for this chain (${fromBaseUnits(BigInt(r.dust_threshold), 8)}); it would be lost`,
        );
      const out = await buildUtxoSend(f, env, {
        chainId: req.fromChainId,
        taker: req.taker,
        vault: r.inbound_address,
        amount,
        memo: r.memo,
        feeRate: Number(r.recommended_gas_rate ?? 0) || 1,
      });
      return {
        approval: null,
        tx: null,
        nonEvmTx: { vm, kind: "uvm-psbt", data: { psbt: out.psbt, summary: out.summary } },
      };
    }
    throw new Error("unsupported origin VM");
  };

  return {
    name: "thorchain",
    enabled: () => true,
    supports: (r) =>
      r.fromChainId in PREFIX && r.toChainId in PREFIX && r.fromChainId !== r.toChainId,
    async quote(req, signal) {
      const { r, dst } = await call(req, signal);
      const out = scale(BigInt(r.expected_amount_out), 8, dst.decimals);
      const affRaw = scale(BigInt(r.fees.affiliate || "0"), 8, dst.decimals);
      const [outUsd, ourFeeUsd] = await Promise.all([
        pricer.usd(req.toChainId, req.toToken, out),
        affRaw > 0n ? pricer.usd(req.toChainId, req.toToken, affRaw) : Promise.resolve(0),
      ]);
      // LTC/DOGE/BCH PSBTs are built at /build only (each one fetches the taker's coins and previous txs).
      const x =
        req.taker && vmOf(req.fromChainId) !== "uvm" ? await toTx(req, r).catch(() => null) : null;
      return Quote.parse({
        id: `thorchain:${crypto.randomUUID()}`,
        provider: "thorchain",
        request: req,
        toAmount: out.toString(),
        toAmountMin: (
          (out * BigInt(10_000 - Math.max(req.slippageBps, TOLERANCE_FLOOR_BPS))) /
          10_000n
        ).toString(),
        gasUsd: 0,
        feeUsd: ourFeeUsd ?? 0,
        netUsd: outUsd,
        etaSeconds: Math.max(6, Math.round(r.total_swap_seconds ?? 60)),
        steps: [
          {
            type: req.fromChainId === req.toChainId ? "swap" : "bridge",
            tool: "thorchain",
            fromChainId: req.fromChainId,
            toChainId: req.toChainId,
            fromToken: req.fromToken,
            toToken: req.toToken,
            fromAmount: req.amount,
            toAmount: out.toString(),
          },
        ],
        approvalAddress:
          vmOf(req.fromChainId) === "evm" && !isNative(req.fromChainId, req.fromToken)
            ? (r.router ?? null)
            : null,
        tx: x?.tx ?? null,
        expiresAt: Math.min(Date.now() + 60_000, r.expiry * 1000),
        ourFeeUsd: ourFeeUsd ?? 0,
        ourFeeVerified: affRaw > 0n,
        ...(x?.nonEvmTx ? { execution: "nonevm" as const, nonEvmTx: x.nonEvmTx } : {}),
        ...(UTXO_DEST[req.fromChainId] || vmOf(req.fromChainId) === "bvm"
          ? { practicalMinimum: practicalOf(r.recommended_min_amount_in) }
          : {}),
      });
    },
    async build(req, signal): Promise<BuildResponse> {
      const { r } = await call(req, signal);
      const x = await toTx(req, r);
      if (x.tx) return { ...x.tx, execution: "tx" };
      if (!x.nonEvmTx) throw new Error("THORChain: no transaction for this origin");
      // Non-EVM: placeholder EVM fields are ignored by the client when execution === "nonevm".
      return {
        chainId: req.fromChainId,
        to: ZERO_ADDRESS,
        data: "0x",
        value: "0",
        execution: "nonevm",
        nonEvmTx: x.nonEvmTx,
      };
    },
    async status(req, signal) {
      const result = await track(req.txHash, signal);
      if (result.state === "refunded")
        return { status: "failed", receivingTxHash: null, refundTxHash: result.payout?.txid };
      if (result.state === "paid_out") {
        const receivingTxHash = result.payout?.txid ?? null;
        const verified =
          req.fromChainId === TRON &&
          req.toChainId === 1 &&
          result.payout?.chain === "ETH" &&
          receivingTxHash
            ? await tronUsdcSettlement(
                f,
                signal,
                req.txHash,
                receivingTxHash,
                env.RPC_URL_1 || "https://ethereum-rpc.publicnode.com",
              ).catch(() => null)
            : null;
        return {
          status: "done",
          receivingTxHash,
          ...(verified ? { tronUsdcSettlement: verified } : {}),
        };
      }
      return {
        status:
          result.state === "waiting"
            ? "not_found"
            : result.state === "failed"
              ? "failed"
              : "pending",
        receivingTxHash: null,
      };
    },
    async deposit(req, refund, signal): Promise<UtxoDeposit> {
      const d = UTXO_DEST[req.fromChainId];
      if (!d)
        throw new RouteRefused(
          "deposit addresses are offered for Litecoin, Dogecoin and Bitcoin Cash only",
        );
      if (!isNative(req.fromChainId, req.fromToken))
        throw new RouteRefused(`${d.name}: only the native coin can be sent`);
      if (!req.recipient?.trim())
        throw new RouteRefused("recipient required: the payout address on the destination chain");
      // The refund address is optional: THORChain refuses a refund address in every LTC/DOGE/BCH memo measured so
      // far, and without one it refunds to the address that sent the coins.
      let given = "";
      if (refund?.trim()) {
        const rv = validateUtxoRecipient(req.fromChainId, refund);
        if (!rv.ok) throw new RouteRefused(`refund address: ${rv.reason}`);
        given = rv.address;
      }
      const { taker: _t, ...noTaker } = req;
      const [{ r, dst, refundDropped, toAsset, destination }, ibs] = await Promise.all([
        call(noTaker as QuoteRequest, signal, given ? { refund: given } : {}),
        getJson<
          {
            chain: string;
            address: string;
            halted?: boolean;
            chain_trading_paused?: boolean;
            dust_threshold?: string;
          }[]
        >(f, `${base}/inbound_addresses`, { signal }),
      ]);
      const memo = r.memo ?? "";
      // THORChain's memo (first attempt or the retry without refund) must pay the requested recipient in the
      // requested asset; anything else is refused, never shown as deposit instructions.
      const bad = thorMemoMismatch(memo, req.toChainId, toAsset, destination, await poolSet());
      if (bad) throw new RouteRefused(`THORChain: ${bad}; not offered`);
      const limit = MEMO_LIMIT[d.bt]!;
      const memoBytes = Buffer.byteLength(memo, "utf8");
      if (memoBytes > limit)
        throw new RouteRefused(
          `THORChain's memo is ${memoBytes} bytes, over ${d.sym}'s ${limit}-byte OP_RETURN limit; not offered`,
        );
      // THORChain's own memo decides where a refund goes: dest field "<payout>/<refund>" or "<payout>" alone.
      const memoRefund = (memo.split(":")[2] ?? "").split("/")[1] ?? "";
      const refundInMemo = !!given && !refundDropped;
      if (refundInMemo ? memoRefund.toLowerCase() !== given.toLowerCase() : memoRefund !== "")
        throw new Error(
          "THORChain: the memo's refund address is not the expected one; not offered",
        );
      const ib = ibs.find((x) => x.chain === d.sym);
      if (!ib || ib.halted || ib.chain_trading_paused)
        throw new RouteRefused(`THORChain has paused ${d.name} right now; try again later`);
      if (normVault(ib.address) !== normVault(r.inbound_address))
        throw new Error("THORChain's vault changed between two reads; try again");
      const dustRaw = ib.dust_threshold ?? r.dust_threshold;
      if (!dustRaw || !/^\d+$/.test(dustRaw))
        throw new Error(`THORChain did not report its ${d.sym} minimum; not offered`);
      const dust = BigInt(dustRaw);
      const amount = BigInt(req.amount);
      if (amount <= dust)
        throw new RouteRefused(
          `amount must be above THORChain's ${d.sym} minimum of ${fromBaseUnits(dust, 8)} ${d.sym}; smaller sends are lost`,
        );
      const out = scale(BigInt(r.expected_amount_out), 8, dst.decimals);
      const practical = practicalOf(r.recommended_min_amount_in);
      const shown = practical && BigInt(practical.amount) > dust ? BigInt(practical.amount) : dust;
      return {
        chain: d.sym,
        vault: r.inbound_address,
        amount: amount.toString(),
        amountDisplay: fromBaseUnits(amount, 8),
        memo,
        memoBytes,
        memoLimit: limit,
        minimum: dust.toString(),
        minimumDisplay: fromBaseUnits(shown, 8),
        practicalMinimum: practical,
        expiresAt: r.expiry,
        refund: given,
        refundInMemo,
        refundTo: refundInMemo ? "memo" : "sender",
        expectedOut: fromBaseUnits(out, dst.decimals),
        warnings: [
          ...(refundInMemo
            ? []
            : [
                `REFUNDS GO BACK TO THE ADDRESS THAT SENT THE COINS. THORChain does not fit a refund address in this ${d.sym} memo, so if the swap fails it refunds to the ${d.name} address your coins came from. Never send from an exchange or from any address you do not control: a refund there can be lost.`,
              ]),
          `The memo is required. A ${d.sym} send without this exact memo in an OP_RETURN output cannot be matched to your swap.`,
          refundInMemo
            ? "Do not send from an exchange: exchanges cannot add the memo, and a refund would go to the address in the memo, not to the exchange."
            : "Do not send from an exchange: exchanges cannot add the memo.",
          `Send exactly ${fromBaseUnits(amount, 8)} ${d.sym} in one transaction before the quote expires.`,
        ],
      };
    },
    track,
  };

  async function track(txid: string, signal: AbortSignal): Promise<UtxoTrack> {
    const id = txid.replace(/^0x/, "").toUpperCase();
    const thorchainUrl = `https://thorchain.net/tx/${id}`;
    type Out = { chain: string; id: string; memo?: string };
    const s = await getJson<{
      tx?: unknown;
      out_txs?: Out[];
      planned_out_txs?: { chain: string; refund?: boolean }[];
      stages?: {
        inbound_observed?: { started?: boolean; completed?: boolean };
        inbound_confirmation_counted?: { completed?: boolean };
        swap_status?: { pending?: boolean };
        swap_finalised?: { completed?: boolean };
        outbound_signed?: { completed?: boolean };
      };
      error?: string;
    }>(f, `${base}/tx/status/${id}`, { signal }).catch((e: unknown) => {
      if (e instanceof Error && /^(404|400)\b/.test(e.message)) return null;
      throw e;
    });
    const waiting: UtxoTrack = {
      state: "waiting",
      message:
        "THORChain has not seen this transaction yet. It shows up once your wallet broadcasts it.",
      thorchainUrl,
      payout: null,
    };
    if (!s || !s.tx || s.stages?.inbound_observed?.started === false) return waiting;
    const outs = (s.out_txs ?? []).filter((o) => o.id && !/^0+$/.test(o.id));
    const refundPlanned = (s.planned_out_txs ?? []).some((p) => p.refund);
    const out = outs[0];
    if (out && s.stages?.outbound_signed?.completed !== false) {
      const refunded = refundPlanned || /^refund/i.test(out.memo ?? "");
      return UtxoTrack.parse({
        state: refunded ? "refunded" : "paid_out",
        message: refunded
          ? "THORChain refunded this swap to the refund address (minus network fees)."
          : "Paid out: THORChain sent the swap output.",
        thorchainUrl,
        payout: { chain: out.chain, txid: out.id, url: explorerTx(out.chain, out.id) },
      });
    }
    if (s.error)
      return {
        state: "failed",
        message: `THORChain reports: ${s.error.slice(0, 160)}`,
        thorchainUrl,
        payout: null,
      };
    if (
      s.stages?.inbound_observed?.completed === false ||
      s.stages?.inbound_confirmation_counted?.completed === false
    )
      return {
        state: "seen",
        message: "THORChain has seen your transaction and is waiting for confirmations.",
        thorchainUrl,
        payout: null,
      };
    return {
      state: "swapping",
      message: refundPlanned
        ? "The swap could not complete; THORChain is sending a refund."
        : "Swapping: THORChain is executing the swap and preparing the payout.",
      thorchainUrl,
      payout: null,
    };
  }
}
