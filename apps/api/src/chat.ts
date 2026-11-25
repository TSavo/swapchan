import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { appendEvent, type SessionBus } from "./session-bus.js";
import {
  type EventKind,
  normalizeAddress,
  type SessionEvent,
  type SessionStore,
} from "./sessions.js";
import { requireWalletAuth } from "./siwe.js";

/**
 * Token-bucket rate limiter. Every user message triggers a (paid) agent run, so we cap how often a
 * given wallet can start one. Wallet results (confirmed/switched/rejected…) are NOT limited — they
 * must always flow so an in-flight action can settle. Default: 1 message / 60s per address.
 */
class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly perMinute: number) {}
  /** 0 if allowed, else seconds to wait. */
  take(key: string): number {
    if (this.perMinute <= 0) return 0;
    const t = Date.now();
    const rate = this.perMinute / 60_000;
    const b = this.buckets.get(key) ?? { tokens: this.perMinute, at: t };
    b.tokens = Math.min(this.perMinute, b.tokens + (t - b.at) * rate);
    b.at = t;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) this.buckets.delete(this.buckets.keys().next().value as string);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - b.tokens) / rate / 1000);
  }
}

const CHAT_MSGS_PER_MIN = Number(process.env.SWAPCHAN_CHAT_RATE_PER_MIN ?? "2");

/**
 * Smart-wallet chat transport: one channel per connected address.
 *
 *   POST /chat        — a client writer appends an event (a user message, or a wallet result).
 *   GET  /chat/stream — the SSE projection of that address's log: catch-up from the client's
 *                       cursor (resync), then live-tail new events.
 *
 * Client→server is POST; server→client is SSE. The private key never passes through here —
 * the client posts its wallet RESULT (hash/rejected), never a key. Reads are public; the address
 * is the log key.
 */

// The only event kinds a browser client is allowed to write. The agent and the chain watcher
// write their own kinds server-side; a client cannot forge an `action_proposed` or `settled`.
const ClientKind = z.enum(["user_message", "wallet_result"]);

const PostBody = z.object({
  address: z.string().trim().min(1),
  kind: ClientKind,
  data: z.unknown(),
  // Idempotency: a retried wallet-result POST (double-click, network retry) must be a no-op.
  idempotencyKey: z.string().trim().min(1).optional(),
});

const SSE_PING_MS = 25_000;

export function chatRoutes(
  store: SessionStore,
  bus: SessionBus,
  env: Record<string, string | undefined> = process.env,
): Hono {
  const app = new Hono();
  const limiter = new RateLimiter(CHAT_MSGS_PER_MIN);
  // Sign-to-view: no valid session cookie for this address → 401 auth_required (the UI then prompts
  // the wallet to sign). History and the stream are private; the gate is per-address.
  const gate = requireWalletAuth(env);

  app.post("/", gate, async (c) => {
    const parsed = PostBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: "bad_request", detail: parsed.error?.message }, 400);
    const { address, kind, data, idempotencyKey } = parsed.data;
    // Rate-limit only new user messages (each starts a paid agent run); never wallet results.
    if (kind === "user_message") {
      const wait = limiter.take(normalizeAddress(address));
      if (wait > 0) return c.json({ error: "rate_limited", retryAfter: wait }, 429);
    }
    const event = appendEvent(store, bus, {
      address,
      kind: kind as EventKind,
      data,
      idempotencyKey: idempotencyKey ?? null,
    });
    return c.json({ event, cursor: event.id });
  });

  app.get("/stream", gate, (c) => {
    const address = c.req.query("address");
    if (!address) return c.text("address required", 400);
    const cursor = Math.max(0, Number(c.req.query("cursor") ?? "0") || 0);

    return streamSSE(c, async (stream) => {
      // Subscribe FIRST, then catch up — so an event appended during catch-up lands in the queue
      // and is replayed (deduped by id) rather than lost in the gap between read and subscribe.
      const queue: SessionEvent[] = [];
      const deltas: string[] = [];
      let wake: (() => void) | null = null;
      const unsub = bus.subscribe(address, (e) => {
        queue.push(e);
        wake?.();
      });
      // Transient streaming text for the in-flight turn — relayed as `agent_delta`, never persisted.
      // (Her mid-turn dialogue and per-tool activity are DURABLE events on the normal queue above.)
      const unsubDelta = bus.subscribeDelta(address, (text) => {
        deltas.push(text);
        wake?.();
      });
      stream.onAbort(() => {
        unsub();
        unsubDelta();
        wake?.();
      });

      let last = cursor;
      const send = async (e: SessionEvent) => {
        if (e.id <= last) return; // dedup: already delivered (catch-up/live overlap)
        await stream.writeSSE({ id: String(e.id), event: e.kind, data: JSON.stringify(e) });
        last = e.id;
      };

      try {
        // Catch-up from the durable log (the resync path).
        for (const e of store.since(address, cursor)) await send(e);
        // Live-tail.
        while (!stream.aborted) {
          if (queue.length === 0 && deltas.length === 0) {
            await Promise.race([
              new Promise<void>((r) => {
                wake = r;
              }),
              stream.sleep(SSE_PING_MS),
            ]);
            wake = null;
            if (queue.length === 0 && deltas.length === 0 && !stream.aborted) {
              await stream.writeSSE({ event: "ping", data: String(last) }); // keepalive + cursor
            }
          }
          // Streaming deltas carry no id and are never persisted — they don't move the cursor.
          while (deltas.length) {
            await stream.writeSSE({
              event: "agent_delta",
              data: JSON.stringify({ text: deltas.shift() }),
            });
          }
          while (queue.length) await send(queue.shift() as SessionEvent);
        }
      } finally {
        unsub();
        unsubDelta();
      }
    });
  });

  return app;
}
