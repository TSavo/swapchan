import {
  Address,
  API_VERSION,
  BuildResponse,
  isEvmChain,
  isReceiveOnly,
  type Quote,
  QuoteRequest,
  StatusRequest,
  SUPPORTED_CHAINS,
  sameAddressSpace,
  tokenList,
  vmOf,
} from "@swapchan/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { makeVerifyGuard } from "./agent-guard.js";
import { AgentOrchestrator, type Guard, type Respond } from "./agent-runner.js";
import { makeSdkRespond } from "./agent-sdk.js";
import { fanOut, logGuardFailure } from "./aggregate.js";
import { apiKeyAuth, parseKeys } from "./auth.js";
import { mempoolUtxos } from "./btc.js";
import { ChainWatcher, type Track } from "./chain-watcher.js";
import { chatRoutes } from "./chat.js";
import { contractRoutes } from "./contracttool.js";
import { devToolRoutes } from "./devtools.js";
import {
  buildPayload,
  failures,
  type GuardCtx,
  liveGuardCtx,
  verifyPayload,
} from "./guard/index.js";
import { intelRoutes, linkRoutes, migrateStrayLinks } from "./intel.js";
import { limitRoutes } from "./limit.js";
import { type BestOut, onchainRoutes, openWatchDb } from "./onchain.js";
import { onrampRoutes } from "./onramp.js";
import {
  getPartner,
  openPartnerStore,
  type PartnerStore,
  partnerRoutes,
  recordQuote,
} from "./partners.js";
import { paymentRoutes } from "./payment.js";
import { openPaymentStore } from "./payment-store.js";
import { llamaPricer, type Pricer } from "./pricing.js";
import { across } from "./providers/across.js";
import { cow } from "./providers/cow.js";
import { debridge } from "./providers/debridge.js";
import { jupiter } from "./providers/jupiter.js";
import { kyberswap } from "./providers/kyberswap.js";
import { lifi } from "./providers/lifi.js";
import { oneinch } from "./providers/oneinch.js";
import { relay } from "./providers/relay.js";
import { type ThorAdapter, thorchain } from "./providers/thorchain.js";
import type { Fetch, ProviderAdapter } from "./providers/types.js";
import { velora } from "./providers/velora.js";
import { zerox } from "./providers/zerox.js";
import { scheduleSweep, sweepLinks, sweepPartnerSwaps, sweepWatches } from "./retention.js";
import { health } from "./scanctx.js";
import { scannerRoutes } from "./scanner.js";
import { buildSend } from "./send.js";
import { openSeoStore, seoRoutes, startSeoJob } from "./seo.js";
import { SessionBus } from "./session-bus.js";
import { openSessionStore } from "./sessions.js";
import { createSimulator, type Simulator } from "./simulate.js";
import { authRoutes } from "./siwe.js";
import {
  jupiterTokenReader,
  onchainReader,
  type SolanaReader,
  type TokenReader,
  tokenResolver,
} from "./tokens.js";
import { gateUtxoRoute, RouteRefused, validateUtxoRecipient } from "./utxodest.js";

export { fanOut, rank } from "./aggregate.js";
export type { ProviderAdapter } from "./providers/types.js";

let sharedPricer: Pricer | undefined;
/** One DefiLlama pricer per process, shared by providers and ranking (same price for every route). */
export function defaultPricer(env: NodeJS.ProcessEnv = process.env): Pricer {
  sharedPricer ??= llamaPricer(fetch, 60_000, async (chainId, address) => {
    const t = await tokenResolver(onchainReader(env), jupiterTokenReader(env))(chainId, address);
    return t?.decimals ?? null;
  });
  return sharedPricer;
}

export function defaultProviders(
  env: NodeJS.ProcessEnv = process.env,
  pricer: Pricer = defaultPricer(env),
): ProviderAdapter[] {
  return [
    lifi(env),
    zerox(env, pricer),
    cow(pricer, fetch, env),
    velora(pricer, env),
    across(pricer, fetch, env),
    relay(env),
    jupiter(pricer, env),
    kyberswap(pricer, env),
    oneinch(pricer, env),
    debridge(pricer, env),
    thorchain(pricer, env, fetch, mempoolUtxos()),
  ];
}

export interface AppOptions {
  paymentStoreFile?: string;
  env?: NodeJS.ProcessEnv;
  simulator?: Simulator | null;
  /** On-chain ERC-20 metadata reader for pasted (unlisted) addresses. */
  tokenReader?: TokenReader;
  /** SPL mint metadata reader (Jupiter token API) for pasted Solana mints. */
  solanaReader?: SolanaReader;
  /** Scanner upstream fetch (tests inject); null disables /scanner routes. */
  scannerFetch?: typeof fetch | null;
  /** Prices every route's output for ranking; never trust provider-reported USD. */
  pricer?: Pricer | null;
  /** fetch used for CoW limit-order calls (tests inject a mock). */
  cowFetch?: Fetch;
  /** Widget partner store; null disables /partners. Default: SQLite at $SWAPCHAN_DATA_DIR/partners.db (in-memory when unset). */
  partners?: PartnerStore | null;
  /** Payload guard (router allowlist + calldata checks). Default: live THORChain/Relay/0x data. */
  guard?: GuardCtx;
  /** SEO trending-token store; null disables /seo. Default: $SWAPCHAN_DATA_DIR/seo.db + 30-min job. */
  seo?: import("node:sqlite").DatabaseSync | null;
  /**
   * Smart-wallet agent brain (injectable for tests). Default: the Agent SDK adapter when
   * ANTHROPIC_API_KEY is set; null (or no key) mounts /chat + SSE but runs no agent. The /chat
   * routes always mount so the channel works; only the orchestrator depends on the model.
   */
  agentRespond?: Respond | null;
  /** Settlement tracker for the chain watcher (injectable for tests). Default: provider.status polling. */
  agentTrack?: Track | null;
}

export function createApp(
  providers: ProviderAdapter[] = defaultProviders(),
  opts: AppOptions = {},
) {
  const env = opts.env ?? process.env;
  const simulator = opts.simulator !== undefined ? opts.simulator : createSimulator(env);
  const cache = new Map<string, Quote>();
  /** quoteId -> ranked sibling quote ids from the same /quotes call (build fallback order). */
  const siblings = new Map<string, string[]>();
  const guard = opts.guard ?? liveGuardCtx(env);
  const pricer = opts.pricer === undefined ? defaultPricer(env) : opts.pricer;
  const resolveToken = tokenResolver(
    opts.tokenReader ?? onchainReader(env),
    opts.solanaReader ?? jupiterTokenReader(env),
  );
  const app = new Hono();
  // The public API (quotes, find_money, MCP) stays open to any origin, but WITHOUT credentials, so
  // no third-party site can make a credentialed (cookie-bearing) request and read the response.
  // Credentials (the SmartWallet session cookie) are allowed ONLY for our own first-party origins
  // — swapchan.com and its subdomains, and localhost in dev — so the cookie flows same-site while a
  // cross-origin attacker gets neither the cookie nor a credentialed response.
  const CRED_ORIGIN =
    /^https?:\/\/(?:[a-z0-9-]+\.)*swapchan\.com$|^http:\/\/localhost(?::\d+)?$|^http:\/\/127\.0\.0\.1(?::\d+)?$/i;
  app.use("*", (c, next) => {
    const origin = c.req.header("origin");
    const creds = !!origin && CRED_ORIGIN.test(origin);
    return cors({ origin: origin ?? "*", credentials: creds })(c, next);
  });
  // Access log: one line per request (method, path, status, ms). Skips the health probe and the
  // long-lived SSE stream to avoid noise. This is what lets us see what actually happened.
  app.use("*", async (c, next) => {
    const t0 = Date.now();
    await next();
    const p = new URL(c.req.url).pathname;
    if (p !== "/healthz" && p !== "/health" && !p.startsWith("/chat"))
      console.log(`[req] ${c.req.method} ${p} ${c.res.status} ${Date.now() - t0}ms`);
  });
  app.use("*", apiKeyAuth(parseKeys(env.SWAPCHAN_API_KEYS)));
  app.onError((err, c) => {
    if (err instanceof z.ZodError)
      return c.json({ error: "invalid request", issues: err.issues }, 400);
    if (err instanceof RouteRefused) return c.json({ error: err.message }, 400);
    // Never leak internal/agent error details to the browser; log the detail server-side only.
    console.error("unhandled API error:", err);
    return c.json({ error: "internal error" }, 500);
  });

  // liveness for the docker healthcheck / watchdog: 503 when scans time out en masse, heap is near the limit or the loop is stalled
  app.get("/healthz", (c) => {
    const h = health();
    return c.json(h, h.ok ? 200 : 503);
  });
  app.get("/health", (c) =>
    c.json({
      ok: true,
      version: API_VERSION,
      providers: providers.filter((p) => p.enabled()).map((p) => p.name),
    }),
  );
  app.get("/chains", (c) =>
    c.json(
      Object.entries(SUPPORTED_CHAINS).map(([id, v]) => ({
        id: Number(id),
        ...v,
        vm: vmOf(Number(id)),
        ...(isReceiveOnly(Number(id))
          ? { receiveOnly: false, thorchainOnly: true, canSend: true, canReceive: true }
          : {}),
      })),
    ),
  );
  app.get("/tokens", (c) => {
    const id = c.req.query("chainId");
    return c.json(id ? tokenList.filter((t) => t.chainId === Number(id)) : tokenList);
  });
  // Any ERC-20 by address: listed tokens come back verified, others are read on-chain (unverified).
  app.get("/token", async (c) => {
    const q = z
      .object({ chainId: z.coerce.number().int().positive(), address: Address })
      .parse(c.req.query());
    const t = await resolveToken(q.chainId, q.address);
    return t ? c.json(t) : c.json({ error: "not a token on this chain" }, 404);
  });
  if (opts.scannerFetch !== null)
    app.route("/scanner", scannerRoutes(opts.scannerFetch ?? fetch, env));
  if (opts.scannerFetch !== null && opts.seo !== null) {
    const seoDb =
      opts.seo ??
      openSeoStore(env.SWAPCHAN_DATA_DIR ? `${env.SWAPCHAN_DATA_DIR}/seo.db` : ":memory:");
    app.route("/seo", seoRoutes(seoDb, opts.scannerFetch ?? fetch));
    if (opts.seo === undefined && env.SWAPCHAN_DATA_DIR && env.SWAPCHAN_SEO_JOB !== "0")
      startSeoJob(seoDb, opts.scannerFetch ?? fetch, env);
  }
  const partners =
    opts.partners !== undefined
      ? opts.partners
      : openPartnerStore(
          env.SWAPCHAN_DATA_DIR ? `${env.SWAPCHAN_DATA_DIR}/partners.db` : ":memory:",
          Number(env.SWAPCHAN_PARTNER_SHARE_BPS ?? 5000),
        );
  if (partners && opts.partners === undefined)
    scheduleSweep(env, "partner_swaps", "redacted", () => sweepPartnerSwaps(partners.db));
  const quotePartner = new Map<string, string>();
  if (partners) app.route("/partners", partnerRoutes(partners, cache, quotePartner));
  const quotes = async (query: Record<string, string>) => {
    const { partner, ...rest } = query;
    const req = gateUtxoRoute(QuoteRequest.parse(rest));
    const res = await fanOut(providers, req, 8000, undefined, pricer, guard);
    const ids = res.quotes.map((q) => q.id);
    for (const q of res.quotes) {
      cache.set(q.id, q);
      siblings.set(q.id, ids);
    }
    if (cache.size > 100_000) {
      cache.clear();
      siblings.clear();
    }
    // Widget attribution: ?partner=<id> tags these quotes for that partner's revenue share.
    const p = partners && partner ? getPartner(partners, partner) : undefined;
    if (partners && p) {
      for (const q of res.quotes) quotePartner.set(q.id, p.id);
      if (res.quotes[0]) recordQuote(partners, p.id, res.quotes[0]);
      if (quotePartner.size > 50_000) quotePartner.clear();
    }
    return res;
  };
  const quoteExpired = (q: Quote) =>
    (q.expiresAt < 1e12 ? q.expiresAt * 1000 : q.expiresAt) <= Date.now();
  app.get("/quotes", async (c) => {
    const { quoteId, ...query } = c.req.query();
    if (quoteId === undefined) return c.json(await quotes(query));
    const q = cache.get(quoteId);
    if (!q || quoteExpired(q))
      return c.json({ error: "Quote expired or unavailable. Review a new quote." }, 410);
    const requested = gateUtxoRoute(QuoteRequest.parse(query));
    const matchesAddress = (chain: number, a?: string, b?: string) =>
      isEvmChain(chain) ? a?.toLowerCase() === b?.toLowerCase() : a === b;
    const reviewed = q.request;
    if (
      reviewed.fromChainId !== requested.fromChainId ||
      reviewed.toChainId !== requested.toChainId ||
      reviewed.amount !== requested.amount ||
      reviewed.slippageBps !== requested.slippageBps ||
      !matchesAddress(reviewed.fromChainId, reviewed.fromToken, requested.fromToken) ||
      !matchesAddress(reviewed.toChainId, reviewed.toToken, requested.toToken) ||
      !matchesAddress(reviewed.toChainId, reviewed.recipient, requested.recipient) ||
      (reviewed.taker && !matchesAddress(reviewed.fromChainId, reviewed.taker, requested.taker))
    )
      return c.json({ error: "Request differs from the reviewed quote. Review a new quote." }, 409);
    return c.json({ quotes: [q], best: q.id, errors: [] });
  });
  app.get("/quote", async (c) => {
    const res = await quotes(c.req.query());
    const best = res.quotes[0];
    return best ? c.json(best) : c.json({ error: "no route", errors: res.errors }, 404);
  });
  if (opts.scannerFetch !== null) {
    const watchDb = openWatchDb(
      env.SWAPCHAN_DATA_DIR ? `${env.SWAPCHAN_DATA_DIR}/watches.db` : ":memory:",
    );
    // Watches compare the best route's raw output (base units of toToken) between checks.
    const bestOut: BestOut = async (q) => {
      const res = await quotes({
        fromChainId: String(q.fromChainId),
        toChainId: String(q.toChainId),
        fromToken: q.fromToken,
        toToken: q.toToken,
        amount: q.amount,
      });
      const best = res.quotes[0];
      return best ? Number(best.toAmount) : null;
    };
    const quoteFn = async (q: {
      fromChainId: number;
      fromToken: string;
      toChainId: number;
      toToken: string;
      amount: string;
    }) => {
      const res = await quotes({
        fromChainId: String(q.fromChainId),
        toChainId: String(q.toChainId),
        fromToken: q.fromToken,
        toToken: q.toToken,
        amount: q.amount,
      });
      const b = res.quotes[0];
      return b
        ? {
            id: b.id,
            provider: b.provider,
            toAmount: b.toAmount,
            netUsd: (b as { netUsd?: number | null }).netUsd ?? null,
          }
        : null;
    };
    // Short links (ids never reused; idle 12 months -> deleted): $SWAPCHAN_DATA_DIR/links.db.
    const linksDb = openWatchDb(
      env.SWAPCHAN_DATA_DIR ? `${env.SWAPCHAN_DATA_DIR}/links.db` : ":memory:",
    );
    migrateStrayLinks(watchDb, linksDb);
    scheduleSweep(env, "links", "removed", () => sweepLinks(linksDb));
    scheduleSweep(env, "watches", "removed", () => sweepWatches(watchDb));
    app.route("/onchain", intelRoutes(opts.scannerFetch ?? fetch, env, watchDb, quoteFn, linksDb));
    app.route("/links", linkRoutes(opts.scannerFetch ?? fetch, env, linksDb));
    app.route("/onchain", onchainRoutes(opts.scannerFetch ?? fetch, env, watchDb, bestOut));
  }
  // Card on-ramp (Crossmint): always mounted; the handler 503s when CROSSMINT_SERVER_KEY is unset.
  app.route("/onramp", onrampRoutes(opts.scannerFetch ?? fetch, env));
  app.post("/build", async (c) => {
    const body = z
      .object({
        quoteId: z.string(),
        strictRoute: z.boolean().optional(),
        taker: Address,
        recipient: Address.optional(),
        allowForeignRecipient: z.boolean().optional(),
      })
      .parse(await c.req.json());
    const { quoteId, taker } = body;
    const q = cache.get(quoteId);
    const p = q && providers.find((x) => x.name === q.provider);
    if (!q || !p) return c.json({ error: "unknown or expired quote" }, 404);
    if (body.strictRoute && quoteExpired(q))
      return c.json({ error: "Quote expired. Review a new quote." }, 410);
    const pin = payoutFor(q.request, taker, body.recipient, body.allowForeignRecipient === true);
    if ("error" in pin) return c.json({ error: pin.error, verified: false }, 400);
    let recipient = pin.recipient;
    if (isReceiveOnly(q.request.toChainId) && recipient) {
      const v = validateUtxoRecipient(q.request.toChainId, recipient);
      if (!v.ok) return c.json({ error: `recipient: ${v.reason}`, verified: false }, 400);
      recipient = v.address;
    }
    const req = {
      ...q.request,
      taker,
      ...(recipient ? { recipient: recipient as `0x${string}` } : {}),
    };
    if (!recipient) delete (req as { recipient?: string }).recipient;
    // Build the requested route; if its payload fails verification, fall back to the next
    // best route from the same /quotes call. Nothing unverified is ever returned.
    const order = [
      q,
      ...(body.strictRoute ? [] : (siblings.get(quoteId) ?? []))
        .map((id) => cache.get(id)!)
        .filter((x) => x && x.id !== q.id),
    ];
    let first: { quoteId: string; provider: string; reason: string } | undefined;
    for (const cand of order) {
      const prov = providers.find((x) => x.name === cand.provider);
      if (!prov) continue;
      const creq = {
        ...req,
        ...cand.request,
        taker,
        ...(recipient ? { recipient: recipient as `0x${string}` } : {}),
      };
      // Payout is pinned: never inherit a recipient from the cached quote.
      if (!recipient) delete (creq as { recipient?: string }).recipient;
      let out: BuildResponse | null;
      try {
        out = await buildOne(prov, creq);
      } catch (e) {
        if (cand === q) throw e;
        continue;
      }
      if (!out) {
        if (cand === q) return c.json({ error: "provider returned no tx" }, 502);
        continue;
      }
      const v = await verifyPayload(buildPayload(cand, creq, out), guard);
      if (!v.verified) {
        const reason = v.checks.some((x) => !x.ok) ? failures(v) : `not verified (${v.level})`;
        logGuardFailure("build", cand.provider, creq.fromChainId, reason);
        first ??= { quoteId: cand.id, provider: cand.provider, reason };
        continue;
      }
      if (simulator && out.execution === "tx" && isEvmChain(out.chainId))
        out = { ...out, simulation: await simulator(out, taker) };
      if (body.strictRoute && quoteExpired(q))
        return c.json({ error: "Quote expired during the build. Review a new quote." }, 410);
      return c.json(
        BuildResponse.parse({
          ...out,
          verified: true,
          verification: v,
          quoteId: cand.id,
          provider: cand.provider,
          payoutTo: recipient ?? taker,
          recipientIsTaker: !recipient || recipient.toLowerCase() === taker.toLowerCase(),
          ...(first ? { fallbackFrom: first } : {}),
        }),
      );
    }
    return c.json(
      { error: "no route passed payload verification", rejected: first ?? null, verified: false },
      502,
    );
  });
  async function buildOne(p: ProviderAdapter, req: QuoteRequest): Promise<BuildResponse | null> {
    const signal = AbortSignal.timeout(10_000);
    if (p.build) return p.build(req, signal);
    const fresh = await p.quote(req, signal);
    if (fresh.execution === "order" && fresh.order)
      // CoW: nothing to send; return order typed data (tx fields point at settlement for reference).
      return {
        chainId: req.fromChainId,
        to: fresh.order.domain.verifyingContract as `0x${string}`,
        data: "0x",
        value: "0",
        execution: "order",
        order: fresh.order,
      };
    if (fresh.nonEvmTx)
      // Non-EVM origin: hand back the provider's payload for the Solana/Bitcoin/Tron wallet.
      return {
        chainId: req.fromChainId,
        to: "0x0000000000000000000000000000000000000000",
        data: "0x",
        value: "0",
        execution: "nonevm",
        nonEvmTx: fresh.nonEvmTx,
      };
    if (fresh.tx)
      return {
        ...fresh.tx,
        execution: "tx",
        ...(fresh.relayOrder ? { relayOrder: fresh.relayOrder } : {}),
      };
    return null;
  }
  app.route("/limit", limitRoutes(opts.cowFetch ?? fetch, env));
  app.route(
    "/payments",
    paymentRoutes(
      opts.scannerFetch ?? fetch,
      openPaymentStore(
        opts.paymentStoreFile ??
          (env.SWAPCHAN_DATA_DIR ? `${env.SWAPCHAN_DATA_DIR}/payments.db` : ":memory:"),
      ),
      env.SWAPCHAN_TESTNET_PAYMENTS === "1",
    ),
  );
  // pure blocktools developer tools on public input (no body logging, size-capped, per-client rate limit)
  app.route("/tools", devToolRoutes());
  // Read/Write Contract (/tools/contract): ABI lookup, eth_call reads, unsigned calldata. Never signs or sends.
  app.route("/contract-tool", contractRoutes({ f: opts.scannerFetch ?? fetch, env }));
  // Plain send: build an unsigned transfer of a token/native coin to an arbitrary recipient (EVM live;
  // UTXO/Solana/Tron coming). SwapChan never signs or broadcasts; the user's wallet does. verifyTx-guarded.
  app.post("/send", async (c) => {
    let body: {
      chain: string;
      to: string;
      amount: string;
      token?: string | undefined;
      from?: string | undefined;
    };
    try {
      body = z
        .object({
          chain: z.coerce.string().min(1).max(40),
          to: z.string().min(1).max(200),
          amount: z.string().min(1).max(100),
          token: z.string().max(100).optional(),
          from: z.string().max(100).optional(),
        })
        .parse(await c.req.json());
    } catch {
      return c.json({ error: "chain, to and amount are required", verified: false }, 400);
    }
    try {
      return c.json(await buildSend(opts.scannerFetch ?? fetch, env, body));
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "send build failed", verified: false },
        400,
      );
    }
  });
  // LTC/DOGE/BCH deposit-address flow (THORChain only): vault, exact amount, memo, minimum. refund is optional.
  app.post("/utxo/deposit", async (c) => {
    const body = z
      .object({ refund: z.string().max(120).optional() })
      .passthrough()
      .parse(await c.req.json());
    const req = gateUtxoRoute(QuoteRequest.parse(body));
    if (!isReceiveOnly(req.fromChainId))
      return c.json({ error: "deposit addresses are for sending LTC, DOGE or BCH" }, 400);
    const thor = providers.find((x) => x.name === "thorchain") as ThorAdapter | undefined;
    if (!thor?.deposit) return c.json({ error: "THORChain is not available" }, 503);
    return c.json(await thor.deposit(req, body.refund, AbortSignal.timeout(10_000)));
  });
  // Read-only THORChain progress of an LTC/DOGE/BCH (or any) inbound txid.
  app.get("/utxo/status", async (c) => {
    const { txid } = z
      .object({ txid: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/) })
      .parse(c.req.query());
    const thor = providers.find((x) => x.name === "thorchain") as ThorAdapter | undefined;
    if (!thor?.track) return c.json({ error: "THORChain is not available" }, 503);
    return c.json(await thor.track(txid, AbortSignal.timeout(8000)));
  });
  app.get("/status", async (c) => {
    const req = StatusRequest.parse(c.req.query());
    const p = providers.find((x) => x.name === req.provider);
    if (!p?.status) return c.json({ error: "status unsupported for provider" }, 400);
    return c.json(await p.status(req, AbortSignal.timeout(8000)));
  });

  // Smart wallet (swapchan.com/smartwallet): one append-only event log per connected address IS
  // the state, the agent's context, and the SSE source. The channel (POST in + SSE out) always
  // mounts; the agent brain runs only with a model. Pipeline per address:
  //   web SSE -> web server (/chat) -> agent -> SwapChan MCP (build) -> response -> web SSE -> wallet
  {
    const store = openSessionStore(
      env.SWAPCHAN_DATA_DIR ? `${env.SWAPCHAN_DATA_DIR}/sessions.db` : ":memory:",
    );
    const bus = new SessionBus();
    // Sign-to-view auth lives at its own prefix (never behind the chat gate) so the nonce/verify
    // calls are reachable without a cookie.
    app.route("/wallet-auth", authRoutes(env));
    app.route("/chat", chatRoutes(store, bus, env));

    const respond =
      opts.agentRespond !== undefined
        ? opts.agentRespond
        : env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN
          ? makeSdkRespond({
              mcpUrl: env.SWAPCHAN_MCP_URL ?? "http://mcp:8788/mcp",
              testPayments: env.SWAPCHAN_TESTNET_PAYMENTS === "1",
              store,
              ...(env.SWAPCHAN_AGENT_MODEL ? { model: env.SWAPCHAN_AGENT_MODEL } : {}),
            })
          : null;
    const guard: Guard = makeVerifyGuard(opts.scannerFetch ?? fetch, env);
    if (respond)
      new AgentOrchestrator(
        store,
        bus,
        respond,
        guard,
        env.SWAPCHAN_TESTNET_PAYMENTS === "1",
      ).start();

    // Third writer: on a broadcast, poll settlement and append a `settled` event (re-wakes the
    // agent for the next step). Default tracker uses the signed route's provider.status; the browser
    // carries provider + chains on the wallet_result from the /build it signed.
    const track: Track =
      opts.agentTrack !== undefined
        ? (opts.agentTrack ?? (async () => null))
        : async (req) => {
            if (!req.provider || req.fromChainId === undefined || req.toChainId === undefined)
              return null; // not enough route context yet → keep polling
            const p = providers.find((x) => x.name === req.provider);
            if (!p?.status) return null;
            try {
              const r = await p.status(
                {
                  provider: req.provider,
                  txHash: req.hash,
                  fromChainId: req.fromChainId,
                  toChainId: req.toChainId,
                },
                AbortSignal.timeout(8000),
              );
              if (r.status === "done")
                return { status: "done", receivingTxHash: r.receivingTxHash };
              if (r.status === "failed") return { status: "failed" };
              return null; // pending / not_found → keep polling
            } catch {
              return null;
            }
          };
    if (opts.agentTrack !== null) new ChainWatcher(store, bus, track).start();
  }

  return app;
}

/**
 * Pin the swap payout (audit finding: /build accepted a foreign recipient and called it verified).
 * Same-VM: payout goes to the taker unless the caller names another recipient AND sets
 * allowForeignRecipient. Cross-VM: a recipient is required (body, else the quote's own one).
 */
export function payoutFor(
  qreq: { fromChainId: number; toChainId: number; recipient?: string | undefined },
  taker: string,
  recipient: string | undefined,
  allowForeign: boolean,
): { recipient: string | undefined } | { error: string } {
  // LTC/DOGE/BCH share the "uvm" tag but not addresses, so LTC -> DOGE needs a recipient like any cross-VM route.
  const cross = !sameAddressSpace(qreq.fromChainId, qreq.toChainId);
  if (cross) {
    const r = recipient ?? qreq.recipient;
    return r ? { recipient: r } : { error: "cross-VM route: pass recipient" };
  }
  if (!recipient || recipient.toLowerCase() === taker.toLowerCase())
    return { recipient: undefined };
  if (!allowForeign)
    return {
      error:
        "recipient differs from taker: the payout would go to another wallet. Pass allowForeignRecipient: true only if the user named this recipient.",
    };
  return { recipient };
}
