import { formatUnits, isAddress, parseUnits } from "viem";
import { z } from "zod";
import tokenListJson from "./tokenList.json" with { type: "json" };

/** Contract version. Bump on any breaking change to the schemas below. */
export const API_VERSION = "1" as const;

export const ChainId = z.number().int().positive();
export type ChainId = z.infer<typeof ChainId>;

export const SUPPORTED_CHAINS = {
  1: { name: "Ethereum", mascot: "eth-chan" },
  8453: { name: "Base", mascot: "base-chan" },
  42161: { name: "Arbitrum", mascot: "arb-chan" },
  10: { name: "Optimism", mascot: "op-chan" },
  137: { name: "Polygon", mascot: "poly-chan" },
  56: { name: "BNB Chain", mascot: "bnb-chan" },
  43114: { name: "Avalanche", mascot: "avax-chan" },
  59144: { name: "Linea", mascot: "linea-chan" },
  534352: { name: "Scroll", mascot: "scroll-chan" },
  792703809: { name: "Solana", mascot: "sol-chan" },
  8253038: { name: "Bitcoin", mascot: "btc-chan" },
  728126428: { name: "Tron", mascot: "tron-chan" },
  2000000002: { name: "Litecoin", mascot: "ltc-chan" },
  2000000003: { name: "Dogecoin", mascot: "doge-chan" },
  2000000145: { name: "Bitcoin Cash", mascot: "bch-chan" },
} as const satisfies Record<number, { name: string; mascot: string }>;

/**
 * Virtual machine family per chain. Solana, Bitcoin and Tron ids follow Relay's numbering. "uvm" = a receive-only
 * UTXO coin (Litecoin, Dogecoin, Bitcoin Cash) paid out by THORChain: a swap destination, never an origin (yet).
 * Relay has no ids for these, so SwapChan uses 2_000_000_000 + the coin's SLIP-44 type (LTC 2, DOGE 3, BCH 145),
 * outside every EVM and Relay id in use.
 */
export type Vm = "evm" | "svm" | "bvm" | "tvm" | "uvm";
export const SOLANA = 792703809;
export const BITCOIN = 8253038;
export const TRON = 728126428;
export const LITECOIN = 2000000002;
export const DOGECOIN = 2000000003;
export const BITCOIN_CASH = 2000000145;
/** Native-coin sentinels for the uvm coins are the coin's zero-hash address (unspendable, blocktools-valid), like BTC's. */
export const NON_EVM: Record<number, { vm: Vm; native: string }> = {
  [SOLANA]: { vm: "svm", native: "11111111111111111111111111111111" },
  [BITCOIN]: { vm: "bvm", native: "bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8" },
  [TRON]: { vm: "tvm", native: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb" },
  [LITECOIN]: { vm: "uvm", native: "ltc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp9ysmq" },
  [DOGECOIN]: { vm: "uvm", native: "D596YFweJQuHY1BbjazZYmAbt8jJPbKehC" },
  [BITCOIN_CASH]: { vm: "uvm", native: "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqfnhks603" },
};
/** THORChain-only chains (LTC, DOGE, BCH): both directions route through THORChain only (no Relay, no LI.FI).
 *  The name is kept for compatibility; the API's /chains now reports them as `thorchainOnly: true`, `canSend: true`,
 *  `canReceive: true` and `receiveOnly: false` (they were destination-only before deposits and PSBT sends). */
export const RECEIVE_ONLY_CHAINS: readonly number[] = [LITECOIN, DOGECOIN, BITCOIN_CASH];
export const isReceiveOnly = (chainId: number) => RECEIVE_ONLY_CHAINS.includes(chainId);
export const vmOf = (chainId: number): Vm => NON_EVM[chainId]?.vm ?? "evm";
export const isEvmChain = (chainId: number) => vmOf(chainId) === "evm";
export const isThorOnly = isReceiveOnly;
/** Same address space: the taker's address can receive on the other chain. "uvm" groups LTC, DOGE and BCH, which
 *  each have their own addresses, so two uvm chains share an address space only when they are the same chain. */
export const sameAddressSpace = (a: number, b: number) =>
  vmOf(a) === vmOf(b) && (vmOf(a) !== "uvm" || a === b);

const B58 = "[1-9A-HJ-NP-Za-km-z]";
const PATTERNS: Record<Exclude<Vm, "evm">, RegExp> = {
  svm: new RegExp(`^${B58}{32,44}$`),
  bvm: /^(bc1[02-9ac-hj-np-z]{11,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
  tvm: new RegExp(`^T${B58}{33}$`),
  // Character-set shape only (UI hint + schema gate); no checksum is computed here. The API accepts a uvm
  // recipient only after blocktools' addressValidate for that exact chain (apps/api/src/utxodest.ts).
  uvm: /^(ltc1[02-9ac-hj-np-z]{11,87}|[LMDA9][1-9A-HJ-NP-Za-km-z]{25,34}|(bitcoincash:)?[qp][02-9ac-hj-np-z]{41})$/,
};
/** True if `a` is a well-formed address (wallet or token) on a chain of VM `vm`. */
export const isVmAddress = (a: string, vm: Vm): boolean =>
  vm === "evm" ? isAddress(a, { strict: false }) : PATTERNS[vm].test(a);
export const isAnyAddress = (a: string) =>
  (["evm", "svm", "bvm", "tvm", "uvm"] as const).some((vm) => isVmAddress(a, vm));
/** Native token sentinel for any supported chain. */
export const nativeOf = (chainId: number): string => NON_EVM[chainId]?.native ?? NATIVE_TOKEN;

export const Chain = z.object({
  id: ChainId,
  name: z.string(),
  mascot: z.string(),
  /** Additive v1, deprecated: was true while LTC/DOGE/BCH were destination only. Now false for them (they send too). */
  receiveOnly: z.boolean().optional(),
  /** true = both directions route through THORChain only (LTC, DOGE, BCH). */
  thorchainOnly: z.boolean().optional(),
  /** directions this chain supports; absent = both */
  canSend: z.boolean().optional(),
  canReceive: z.boolean().optional(),
});
export type Chain = z.infer<typeof Chain>;

export const Address = z
  .string()
  .refine((a) => isAnyAddress(a), "invalid address")
  .transform((a) => a as `0x${string}`);
/** Strict EVM address (tx targets, spenders). */
export const EvmAddress = z
  .string()
  .refine((a) => isAddress(a, { strict: false }), "invalid EVM address")
  .transform((a) => a as `0x${string}`);
export const Hex = z
  .string()
  .regex(/^0x[0-9a-fA-F]*$/)
  .transform((h) => h as `0x${string}`);
/** Integer amount in base units, serialized as decimal string (never floats). */
export const BaseUnits = z.string().regex(/^\d+$/, "base-unit integer string");

/** Native gas token sentinel used across providers. */
export const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as const;

export const Token = z.object({
  chainId: ChainId,
  address: Address,
  symbol: z.string(),
  name: z.string(),
  decimals: z.number().int().min(0).max(36),
  logoURI: z.string().url().optional(),
});
export type Token = z.infer<typeof Token>;

export const tokenList: Token[] = z.array(Token).parse(tokenListJson);

export const QuoteRequest = z.object({
  fromChainId: z.coerce.number().pipe(ChainId),
  toChainId: z.coerce.number().pipe(ChainId),
  fromToken: Address,
  toToken: Address,
  amount: BaseUnits,
  /** Optional: required by some providers to return a tx. */
  taker: Address.optional(),
  /** Receiving address on the destination chain; required when it's a different VM than taker's. */
  recipient: Address.optional(),
  /** Slippage in basis points (50 = 0.5%). */
  slippageBps: z.coerce.number().int().min(1).max(5000).default(50),
});
export type QuoteRequest = z.infer<typeof QuoteRequest>;

export const RouteStep = z.object({
  type: z.enum(["swap", "bridge", "wrap", "approve", "fee"]),
  tool: z.string(),
  fromChainId: ChainId,
  toChainId: ChainId,
  fromToken: Address,
  toToken: Address,
  fromAmount: BaseUnits,
  toAmount: BaseUnits,
});
export type RouteStep = z.infer<typeof RouteStep>;

export const Simulation = z.object({
  ok: z.boolean(),
  method: z.enum(["eth_call", "tenderly"]),
  gasUsed: BaseUnits.optional(),
  error: z.string().optional(),
});
export type Simulation = z.infer<typeof Simulation>;

export const TxRequest = z.object({
  chainId: ChainId,
  to: EvmAddress,
  data: Hex,
  value: BaseUnits,
  gasLimit: BaseUnits.optional(),
  /** Present when the API simulated the tx (SWAPCHAN_SIMULATE). Additive in v1. */
  simulation: Simulation.optional(),
});

/** Generic EIP-712 payload (Permit2 PermitSingle/PermitTransferFrom, CoW orders). */
export const TypedData = z.object({
  domain: z.record(z.string(), z.unknown()),
  types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
  primaryType: z.string(),
  message: z.record(z.string(), z.unknown()),
});
export type TypedData = z.infer<typeof TypedData>;
export type TxRequest = z.infer<typeof TxRequest>;

/** Non-EVM transaction payload. svm-base64 = serialized VersionedTransaction (sign + send);
 * svm-instructions = Relay instruction list to compile with the lookup tables.
 * bvm-psbt = base64 or hex PSBT to sign + broadcast; uvm-psbt = base64 LTC/DOGE/BCH PSBT ({psbt, summary}); tvm-json = provider-built Tron tx (or call);
 * tvm-deposit = {to, amount (sun), memo}: send TRX with the memo as tx data (THORChain). */
export const NonEvmTx = z.object({
  vm: z.enum(["svm", "bvm", "tvm", "uvm"]),
  kind: z.enum([
    "svm-base64",
    "svm-instructions",
    "bvm-psbt",
    "tvm-json",
    "tvm-deposit",
    "uvm-psbt",
  ]),
  data: z.unknown(),
});
export type NonEvmTx = z.infer<typeof NonEvmTx>;

/** Server-side payload verification (router allowlist, calldata decode, approvals). */
export const Verification = z.object({
  verified: z.boolean(),
  level: z.enum(["full", "partial", "indicative"]),
  checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string().optional() })),
});
export type Verification = z.infer<typeof Verification>;

/** THORChain's recommended_min_amount_in: its current estimate of the smallest swap it will do (can change). */
export const PracticalMinimum = z
  .object({ amount: z.string(), display: z.string(), note: z.string() })
  .nullable();
export type PracticalMinimum = z.infer<typeof PracticalMinimum>;

export const Quote = z.object({
  id: z.string(),
  provider: z.string(),
  request: QuoteRequest,
  toAmount: BaseUnits,
  toAmountMin: BaseUnits,
  gasUsd: z.number().nonnegative(),
  feeUsd: z.number().nonnegative(),
  /** toAmount value in USD minus gas and fees. Ranking key. */
  netUsd: z.number().nullable(),
  etaSeconds: z.number().int().nonnegative(),
  steps: z.array(RouteStep),
  /** Spender to approve for ERC20 input; null for native. */
  approvalAddress: EvmAddress.nullable(),
  tx: TxRequest.nullable(),
  expiresAt: z.number().int(),
  /** SwapChan's own fee on this route, in USD. 0 = this route pays us nothing. */
  ourFeeUsd: z.number().nonnegative().optional(),
  /** True when the provider confirmed our fee in its quote/tx (not just requested). */
  ourFeeVerified: z.boolean().optional(),
  /** Additive v1: "tx" = send `tx`; "order" = sign `order` typed data (CoW), no tx. Default "tx". */
  execution: z.enum(["tx", "order", "nonevm"]).optional(),
  /** EIP-712 order to sign when execution === "order". */
  order: TypedData.optional(),
  /** Additive v1: set when the origin chain is non-EVM (execution === "nonevm"). */
  nonEvmTx: NonEvmTx.optional(),
  /** Relay Protocol v2 order (orderId + orderData) the deposit commits to; verify with @relay-protocol/settlement-sdk. */
  relayOrder: z.object({ orderId: z.string(), orderData: z.any() }).optional(),
  /** Who receives SwapChan's fee on this route (address + chain), when known. */
  feeRecipient: z.object({ address: z.string(), chainId: ChainId }).optional(),
  /** Additive v1: true only when every guard check passed on this payload (needs taker). */
  verified: z.boolean().optional(),
  verification: Verification.optional(),
  /** THORChain LTC/DOGE/BCH/BTC origins: its current minimum estimate (base units + coin units); null if not given. */
  practicalMinimum: PracticalMinimum.optional(),
});
export type Quote = z.infer<typeof Quote>;

export const QuotesResponse = z.object({
  quotes: z.array(Quote),
  best: z.string().nullable(),
  errors: z.array(z.object({ provider: z.string(), message: z.string() })),
});
export type QuotesResponse = z.infer<typeof QuotesResponse>;

/** POST /build response: unsigned tx plus optional extras. Superset of TxRequest (additive). */
export const BuildResponse = TxRequest.extend({
  /** If set: sign this Permit2 typed data and pass the signature per provider docs instead of an approve tx. */
  permit2: TypedData.optional(),
  /** If set: send this approve tx first (ERC20 allowance missing/unknown). */
  approval: TxRequest.optional(),
  execution: z.enum(["tx", "order", "nonevm"]).optional(),
  order: TypedData.optional(),
  nonEvmTx: NonEvmTx.optional(),
  /** Relay Protocol v2 order (orderId + orderData) the deposit commits to; verify with @relay-protocol/settlement-sdk. */
  relayOrder: z.object({ orderId: z.string(), orderData: z.any() }).optional(),
  verified: z.boolean().optional(),
  verification: Verification.optional(),
  /** Set when the requested quote failed verification and a fallback route was built instead. */
  fallbackFrom: z
    .object({ quoteId: z.string(), provider: z.string(), reason: z.string() })
    .optional(),
  quoteId: z.string().optional(),
  provider: z.string().optional(),
  /** Where the swap output is paid (recipient, else the taker). */
  payoutTo: z.string().optional(),
  /** False when the output goes to a wallet other than the signer. */
  recipientIsTaker: z.boolean().optional(),
});
export type BuildResponse = z.infer<typeof BuildResponse>;

export const StatusRequest = z.object({
  provider: z.string(),
  /** EVM tx hash, Solana signature, Bitcoin txid or Tron txid. */
  txHash: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$|^[1-9A-HJ-NP-Za-km-z]{64,90}$/),
  fromChainId: z.coerce.number().pipe(ChainId),
  toChainId: z.coerce.number().pipe(ChainId),
});
export type StatusRequest = z.infer<typeof StatusRequest>;

export const StatusResponse = z.object({
  status: z.enum(["pending", "done", "failed", "not_found"]),
  receivingTxHash: z.string().nullable(),
  /** Provider-reported return of funds on the origin chain. */
  refundTxHash: z.string().optional(),
  tronRefund: z
    .object({
      status: z.literal("refunded"),
      recipient: z.string(),
      depositedSun: z.string(),
      returnedSun: z.string(),
    })
    .optional(),
  tronUsdcSettlement: z
    .object({
      status: z.enum(["settled", "awaiting_finality"]),
      sourceSignatureCount: z.number().int(),
      sourceAmountSun: z.string(),
      sourceFeeSun: z.string().nullable(),
      sourceBlock: z.number().int(),
      destinationBlock: z.string(),
      recipient: z.string(),
      paidMicroUsdc: z.string(),
      outboundExecutionFeeWei: z.string(),
    })
    .optional(),
});
export type StatusResponse = z.infer<typeof StatusResponse>;

/** Read-only THORChain progress of an inbound txid (GET /utxo/status). Plain states:
 *  waiting = THORChain has not seen it yet; seen = observed, waiting for confirmations; swapping = swap in progress;
 *  paid_out = output sent; refunded = sent back to the refund address; failed = THORChain reports an error. */
export const UtxoTrack = z.object({
  state: z.enum(["waiting", "seen", "swapping", "paid_out", "refunded", "failed"]),
  message: z.string(),
  thorchainUrl: z.string(),
  payout: z.object({ chain: z.string(), txid: z.string(), url: z.string().nullable() }).nullable(),
});
export type UtxoTrack = z.infer<typeof UtxoTrack>;

/** POST /utxo/deposit: everything needed to pay a THORChain vault from any LTC/DOGE/BCH wallet. */
export const UtxoDeposit = z.object({
  chain: z.string(),
  vault: z.string(),
  /** exact amount to send, in base units and as a decimal string */
  amount: z.string(),
  amountDisplay: z.string(),
  memo: z.string(),
  memoBytes: z.number(),
  memoLimit: z.number(),
  /** THORChain's minimum (dust_threshold), base units and decimal; sends at or below it are lost */
  minimum: z.string(),
  /** the larger of `minimum` and practicalMinimum, in coin units */
  minimumDisplay: z.string(),
  /** THORChain's current estimate of its minimum swap (recommended_min_amount_in); null when it gave none */
  practicalMinimum: PracticalMinimum.optional(),
  /** unix seconds after which the memo's quote is stale */
  expiresAt: z.number(),
  /** refund address the user gave ("" if none); in the memo only when refundInMemo */
  refund: z.string(),
  /** true: THORChain refunds to `refund` (named in the memo). false: refunds go to the address that sent the coins. */
  refundInMemo: z.boolean().default(true),
  refundTo: z.enum(["memo", "sender"]).default("memo"),
  expectedOut: z.string(),
  warnings: z.array(z.string()),
});
export type UtxoDeposit = z.infer<typeof UtxoDeposit>;

/** Decimal string -> base units. Exact; no float math. */
export const toBaseUnits = (amount: string, decimals: number): bigint =>
  parseUnits(amount, decimals);
export const fromBaseUnits = (amount: bigint | string, decimals: number): string =>
  formatUnits(BigInt(amount), decimals);

export * from "./across-payment.js";
export * from "./broadcast.js";
export * from "./chains.js";
export * from "./circle-payment.js";
export * from "./cow.js";
export * from "./payment-batch.js";
export * from "./payment-signing.js";
export * from "./playbook.js";

// Methods the calling wallet can actually use on each supported origin chain.
export const PaymentWalletMethods = z
  .object({
    "84532": z
      .array(z.enum(["eth_sendTransaction", "eth_signTypedData_v4", "wallet_sendCalls"]))
      .optional(),
    "11155420": z.array(z.enum(["eth_sendTransaction", "eth_signTypedData_v4"])).optional(),
  })
  .strict();

export const PaymentWalletCapabilities = z.record(
  z.string(),
  z.object({
    atomic: z.object({ status: z.enum(["supported", "ready", "unsupported"]) }).optional(),
  }),
);
