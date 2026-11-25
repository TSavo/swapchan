import { API_URL } from "./api";

/**
 * SSE client for the smart-wallet channel (GET /chat/stream). It is a fetch-based reader (not
 * EventSource) so it can set headers and control reconnect. Reconnect = resync, not replay: it
 * tracks the last event id and reopens the stream from that cursor; the server dedups by id, so a
 * dropped connection never loses or doubles an event. A `ping` frame just advances the cursor.
 */

export interface LiveEvent {
  id: number;
  address: string;
  kind: string;
  data: unknown;
  created_at?: number;
}

export type StreamStatus = "connecting" | "open" | "retrying";

export interface StreamHandle {
  close: () => void;
}

export function streamSession(opts: {
  address: string;
  onEvent: (e: LiveEvent) => void;
  /** Transient partial text of the in-flight agent turn (cumulative message so far). */
  onDelta?: (text: string) => void;
  onStatus?: (s: StreamStatus) => void;
  /** Called when the server returns 401 (no valid session cookie for this address). The stream
   *  pauses; reopen it (call streamSession again) after the wallet has signed in. */
  onAuthRequired?: () => void;
  /** Start cursor; 0 replays the whole log for this address (resync). Default 0. */
  cursor?: number;
}): StreamHandle {
  let closed = false;
  let cursor = opts.cursor ?? 0;
  let ctrl: AbortController | null = null;

  const handleFrame = (frame: string) => {
    let ev = "message";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) ev = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trimStart();
    }
    if (ev === "ping") {
      const n = Number(data);
      if (Number.isFinite(n) && n > cursor) cursor = n;
      return;
    }
    if (ev === "agent_delta") {
      try {
        const { text } = JSON.parse(data) as { text: string };
        opts.onDelta?.(text);
      } catch {
        /* ignore */
      }
      return;
    }
    if (!data) return;
    try {
      const parsed = JSON.parse(data) as LiveEvent;
      if (typeof parsed.id === "number" && parsed.id > cursor) cursor = parsed.id;
      opts.onEvent(parsed);
    } catch {
      // ignore a malformed frame
    }
  };

  const run = async () => {
    while (!closed) {
      ctrl = new AbortController();
      opts.onStatus?.("connecting");
      try {
        const url = `${API_URL}/chat/stream?address=${encodeURIComponent(opts.address)}&cursor=${cursor}`;
        const res = await fetch(url, {
          headers: { accept: "text/event-stream" },
          credentials: "include",
          signal: ctrl.signal,
        });
        if (res.status === 401) {
          // No valid session cookie — pause and let the UI drive the sign-in, then reopen.
          opts.onAuthRequired?.();
          return;
        }
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        opts.onStatus?.("open");
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            handleFrame(buf.slice(0, idx));
            buf = buf.slice(idx + 2);
          }
        }
      } catch {
        // network error / abort → fall through to reconnect
      }
      if (closed) break;
      opts.onStatus?.("retrying");
      await new Promise((r) => setTimeout(r, 1500));
    }
  };

  void run();
  return {
    close: () => {
      closed = true;
      ctrl?.abort();
    },
  };
}

/** POST a client event (user message, or wallet result) to the channel. */
export async function postEvent(body: {
  address: string;
  kind: "user_message" | "wallet_result";
  data: unknown;
  idempotencyKey?: string;
}): Promise<{ ok: boolean; status: number; retryAfter?: number }> {
  const res = await fetch(`${API_URL}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  let retryAfter: number | undefined;
  if (res.status === 429) {
    try {
      retryAfter = (await res.json())?.retryAfter;
    } catch {
      /* ignore */
    }
  }
  return { ok: res.ok, status: res.status, retryAfter };
}

/**
 * Sign-to-view: ask the server for a nonce message, have the connected wallet sign it, and POST the
 * signature back. On success the server sets the session cookie and later /chat calls just work.
 * `signMessage` is wagmi's signer (returns the 0x signature for the given message string).
 */
export async function signInWallet(
  address: string,
  signMessage: (message: string) => Promise<string>,
): Promise<{ ok: boolean; error?: string }> {
  const nres = await fetch(`${API_URL}/wallet-auth/nonce?address=${encodeURIComponent(address)}`, {
    credentials: "include",
  });
  if (!nres.ok) return { ok: false, error: `nonce ${nres.status}` };
  const { message } = (await nres.json()) as { message: string };
  let signature: string;
  try {
    signature = await signMessage(message);
  } catch {
    return { ok: false, error: "rejected" }; // user declined the signature
  }
  const vres = await fetch(`${API_URL}/wallet-auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ address, signature }),
  });
  if (!vres.ok) {
    let error = `verify ${vres.status}`;
    try {
      error = (await vres.json())?.error ?? error;
    } catch {
      /* ignore */
    }
    return { ok: false, error };
  }
  return { ok: true };
}
