import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { chatRoutes } from "./chat.js";
import { appendEvent, SessionBus } from "./session-bus.js";
import { openSessionStore, type SessionEvent } from "./sessions.js";
import { sessionCookieHeader } from "./siwe.js";

const A = "0x803b80fC7f3C67f9aCE73750239C60dd764B2ce5";
// Sign-to-view is enforced; these tests act as an already-signed-in session for A by presenting a
// valid session cookie (what /verify sets). Minting it still needs the server secret.
const ENV = { SWAPCHAN_SESSION_SECRET: "chat-test-secret-0123456789" };
const COOKIE = sessionCookieHeader(ENV.SWAPCHAN_SESSION_SECRET, A);

function setup() {
  const store = openSessionStore(":memory:");
  const bus = new SessionBus();
  const app = new Hono().route("/chat", chatRoutes(store, bus, ENV));
  return { store, bus, app };
}

/** Read `want` SSE event frames (ignoring pings) from a streaming Response, then cancel. */
async function readFrames(res: Response, want: number): Promise<SessionEvent[]> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  const out: SessionEvent[] = [];
  let buf = "";
  let guard = 0;
  while (out.length < want && guard++ < 50) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const f of frames) {
      if (/(^|\n)event: ping(\n|$)/.test(f)) continue;
      const m = f.match(/(^|\n)data: (.*)/);
      if (m) out.push(JSON.parse(m[2]) as SessionEvent);
    }
  }
  await reader.cancel();
  return out;
}

describe("session bus", () => {
  it("publishes to subscribers and unsubscribe stops delivery", () => {
    const bus = new SessionBus();
    const got: string[] = [];
    const unsub = bus.subscribe(A, (e) => got.push((e.data as { text: string }).text));
    bus.publish(A, {
      id: 1,
      address: A.toLowerCase(),
      kind: "user_message",
      data: { text: "x" },
      idempotencyKey: null,
      createdAt: 0,
    });
    unsub();
    bus.publish(A, {
      id: 2,
      address: A.toLowerCase(),
      kind: "user_message",
      data: { text: "y" },
      idempotencyKey: null,
      createdAt: 0,
    });
    expect(got).toEqual(["x"]);
  });

  it("appendEvent persists AND notifies", () => {
    const store = openSessionStore(":memory:");
    const bus = new SessionBus();
    const seen: SessionEvent[] = [];
    bus.subscribe(A, (e) => seen.push(e));
    const ev = appendEvent(store, bus, { address: A, kind: "user_message", data: { text: "hi" } });
    expect(store.all(A).map((e) => e.id)).toEqual([ev.id]);
    expect(seen.map((e) => e.id)).toEqual([ev.id]);
    store.close();
  });
});

describe("chat route", () => {
  it("POST /chat appends and returns the event + cursor", async () => {
    const { store, app } = setup();
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: COOKIE },
      body: JSON.stringify({ address: A, kind: "user_message", data: { text: "swap my bnb" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { event: SessionEvent; cursor: number };
    expect(body.event.kind).toBe("user_message");
    expect(body.cursor).toBe(body.event.id);
    expect(store.all(A).length).toBe(1);
  });

  it("POST is idempotent for a wallet result with an idempotencyKey", async () => {
    const { store, app } = setup();
    const post = () =>
      app.request("/chat", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: COOKIE },
        body: JSON.stringify({
          address: A,
          kind: "wallet_result",
          data: { action_id: "act-1", status: "sent", hash: "0xabc" },
          idempotencyKey: "0xabc",
        }),
      });
    const a = (await (await post()).json()) as { cursor: number };
    const b = (await (await post()).json()) as { cursor: number };
    expect(b.cursor).toBe(a.cursor); // same event
    expect(store.all(A).length).toBe(1); // no double-append
  });

  it("POST rejects a client trying to forge a server-only kind", async () => {
    const { app } = setup();
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: COOKIE },
      body: JSON.stringify({ address: A, kind: "settled", data: { hash: "0x1" } }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /stream catches up prior events from the cursor", async () => {
    const { store, bus, app } = setup();
    appendEvent(store, bus, { address: A, kind: "user_message", data: { text: "1" } });
    appendEvent(store, bus, { address: A, kind: "agent_message", data: { text: "2" } });
    const res = await app.request(`/chat/stream?address=${A}&cursor=0`, {
      headers: { cookie: COOKIE },
    });
    const frames = await readFrames(res, 2);
    expect(frames.map((e) => e.kind)).toEqual(["user_message", "agent_message"]);
  });

  it("GET /stream live-tails events appended after connect", async () => {
    const { store, bus, app } = setup();
    const res = await app.request(`/chat/stream?address=${A}&cursor=0`, {
      headers: { cookie: COOKIE },
    });
    const framesP = readFrames(res, 1);
    // append after the stream is open
    appendEvent(store, bus, { address: A, kind: "agent_message", data: { text: "live" } });
    const frames = await framesP;
    expect(frames[0]?.data).toEqual({ text: "live" });
  });
});
