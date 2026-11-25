import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Smart-wallet session store: a per-address, append-only event log.
 *
 * This is THE source of truth for a conversational wallet session. The log is keyed by the
 * connected wallet address (the web works with one address at a time), and it is simultaneously:
 *   - the durable state,
 *   - the agent's context (rebuilt by replaying the log into the model session),
 *   - the source of the SSE stream to the client.
 *
 * Three writers append to one channel — the user/wallet, the blockchain (settlements), and the
 * agent — and to the agent a chain settlement is the same KIND of thing as a user message: the
 * next event in context.
 *
 * Two correctness properties the whole design depends on (paperclip's hard-won lessons):
 *   1. Monotonic ordering: every event gets a strictly-increasing global id, which doubles as the
 *      reconnect cursor (a client asks for events after its last id — resync, not lossless replay).
 *   2. Idempotent append: at-least-once delivery (retried wallet-result POSTs, re-delivered chain
 *      confirmations, reconnect storms) must never double-append. An event carrying an
 *      idempotencyKey is written at most once per address; a duplicate returns the original.
 *
 * The private key never touches this store (or the server). Signing authority stays in the wallet.
 */

export type EventKind =
  // user/wallet writer
  | "user_message" // { text }
  | "wallet_result" // { action_id, status: "sent" | "rejected", hash? }
  // agent writer
  | "agent_message" // { text }  — the turn's final answer
  | "agent_say" // { text }  — an interim line the agent speaks mid-turn (persists as dialogue)
  | "agent_activity" // { text }  — a per-tool action line ("Getting a quote…"); persists, shown muted
  | "action_proposed" // { action_id, action: WalletAction }
  // blockchain writer
  | "settled"; // { action_id, hash, received?, verdict: "met" | "below_expected" | "reverted" }

export interface SessionEvent {
  id: number; // global monotonic; also the reconnect cursor
  address: string; // the log key (normalized)
  kind: EventKind;
  data: unknown; // JSON payload, shape depends on kind
  idempotencyKey: string | null;
  createdAt: number; // epoch ms
}

interface EventRow {
  id: number;
  address: string;
  kind: string;
  data: string;
  idempotency_key: string | null;
  created_at: number;
}

export interface SessionStore {
  db: DatabaseSync;
  /**
   * Append an event to an address's log. If `idempotencyKey` is given and an event with that key
   * already exists for the address, no row is inserted and the original event is returned (so a
   * re-delivered settlement or retried wallet result is a no-op, not a double-append).
   */
  append(input: {
    address: string;
    kind: EventKind;
    data: unknown;
    idempotencyKey?: string | null;
  }): SessionEvent;
  /** Events for an address with id strictly greater than `cursor`, in order. cursor=0 → from start. */
  since(address: string, cursor: number): SessionEvent[];
  /** The full ordered log for an address (used to rebuild the agent's context). */
  all(address: string): SessionEvent[];
  /** The latest event id for an address (0 if none) — the current cursor. */
  latestCursor(address: string): number;
  /** The agent's SDK session for an address: its resumable session id + the last event id sent to it. */
  getSessionMeta(address: string): { sessionId: string; lastSentId: number } | undefined;
  /** Persist the agent's SDK session id + last-sent cursor for an address (survives restarts). */
  setSessionMeta(address: string, sessionId: string, lastSentId: number): void;
  close(): void;
}

/** Normalize the log key. The address is the identity; lowercase so casing can't fork a session. */
export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

function toEvent(row: EventRow): SessionEvent {
  return {
    id: row.id,
    address: row.address,
    kind: row.kind as EventKind,
    data: JSON.parse(row.data),
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

export function openSessionStore(file: string): SessionStore {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL,
      kind TEXT NOT NULL,
      data TEXT NOT NULL,
      idempotency_key TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS se_addr_id ON session_events(address, id);
    -- NULL idempotency keys are distinct in SQLite, so un-keyed events are never deduped;
    -- keyed events are unique per address, giving idempotent append.
    CREATE UNIQUE INDEX IF NOT EXISTS se_addr_idem
      ON session_events(address, idempotency_key) WHERE idempotency_key IS NOT NULL;
    -- The agent's SDK session per address: its resumable session id + the last event id it has seen.
    CREATE TABLE IF NOT EXISTS session_meta (
      address TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      last_sent_id INTEGER NOT NULL
    );
  `);

  const insert = db.prepare(
    `INSERT INTO session_events (address, kind, data, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(address, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id`,
  );
  const selectById = db.prepare(`SELECT * FROM session_events WHERE id = ?`);
  const selectByIdem = db.prepare(
    `SELECT * FROM session_events WHERE address = ? AND idempotency_key = ?`,
  );
  const selectSince = db.prepare(
    `SELECT * FROM session_events WHERE address = ? AND id > ? ORDER BY id ASC`,
  );
  const selectAll = db.prepare(`SELECT * FROM session_events WHERE address = ? ORDER BY id ASC`);
  const selectMaxId = db.prepare(
    `SELECT COALESCE(MAX(id), 0) AS cursor FROM session_events WHERE address = ?`,
  );
  const selectMeta = db.prepare(
    `SELECT session_id, last_sent_id FROM session_meta WHERE address = ?`,
  );
  const upsertMeta = db.prepare(
    `INSERT INTO session_meta (address, session_id, last_sent_id) VALUES (?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET session_id = excluded.session_id, last_sent_id = excluded.last_sent_id`,
  );

  return {
    db,
    append({ address, kind, data, idempotencyKey = null }) {
      const addr = normalizeAddress(address);
      const now = Date.now();
      const payload = JSON.stringify(data ?? null);
      const row = insert.get(addr, kind, payload, idempotencyKey, now) as
        | { id: number }
        | undefined;
      if (row) return toEvent(selectById.get(row.id) as unknown as EventRow);
      // Conflict: an event with this idempotency key already exists — return the original.
      const existing = selectByIdem.get(addr, idempotencyKey) as unknown as EventRow | undefined;
      if (!existing) throw new Error("append: conflict but no existing row (should be impossible)");
      return toEvent(existing);
    },
    since(address, cursor) {
      return (selectSince.all(normalizeAddress(address), cursor) as unknown as EventRow[]).map(
        toEvent,
      );
    },
    all(address) {
      return (selectAll.all(normalizeAddress(address)) as unknown as EventRow[]).map(toEvent);
    },
    latestCursor(address) {
      return (selectMaxId.get(normalizeAddress(address)) as { cursor: number }).cursor;
    },
    getSessionMeta(address) {
      const r = selectMeta.get(normalizeAddress(address)) as
        | { session_id: string; last_sent_id: number }
        | undefined;
      return r ? { sessionId: r.session_id, lastSentId: r.last_sent_id } : undefined;
    },
    setSessionMeta(address, sessionId, lastSentId) {
      upsertMeta.run(normalizeAddress(address), sessionId, lastSentId);
    },
    close() {
      db.close();
    },
  };
}
