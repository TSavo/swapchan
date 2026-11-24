import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PaymentQuote } from "@swapchan/shared";

/** Only public settlement expectations are persisted. Status always rechecks chain receipts. */
export function openPaymentStore(file = ":memory:") {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS payment_intents(
      hash TEXT PRIMARY KEY, quote TEXT NOT NULL, relayed INTEGER NOT NULL DEFAULT 0
    )`);
  db.exec(`CREATE TABLE IF NOT EXISTS payment_reviews(kind TEXT NOT NULL,id TEXT NOT NULL,expires INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id));
  CREATE INDEX IF NOT EXISTS payment_reviews_expiry ON payment_reviews(expires)`);
  const lookup = db.prepare(
    "SELECT payload FROM payment_reviews WHERE kind=? AND id=? AND expires>?",
  );
  const save = db.prepare(
    "INSERT OR REPLACE INTO payment_reviews(kind,id,expires,payload) VALUES(?,?,?,?)",
  );
  const expire = db.prepare("DELETE FROM payment_reviews WHERE expires<=?");
  const capacity = db.prepare("SELECT count(*) AS n FROM payment_reviews WHERE kind=?");
  const insert = db.prepare("INSERT OR IGNORE INTO payment_intents(hash,quote) VALUES (?,?)");
  const read = db.prepare("SELECT quote, relayed FROM payment_intents WHERE hash=?");
  const relay = db.prepare("UPDATE payment_intents SET relayed=1 WHERE hash=?");
  return {
    cache<T>(kind: string, expiry: (value: T) => number) {
      return {
        get(id: string): T | undefined {
          const row = lookup.get(kind, id, Date.now() / 1000);
          return row ? (JSON.parse(String(row.payload)) as T) : undefined;
        },
        set(id: string, value: T) {
          db.exec("BEGIN IMMEDIATE");
          try {
            const now = Date.now() / 1000;
            expire.run(now);
            if (Number(capacity.get(kind)?.n) >= 2048 && !lookup.get(kind, id, now))
              throw Error("review capacity reached");
            save.run(kind, id, expiry(value), JSON.stringify(value));
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        },
      };
    },
    remember(hash: string, quote: PaymentQuote) {
      insert.run(hash, JSON.stringify(quote));
    },
    markRelayed(hash: string) {
      relay.run(hash);
    },
    get(hash: string) {
      const row = read.get(hash);
      return row
        ? { quote: JSON.parse(String(row.quote)) as PaymentQuote, relayed: row.relayed === 1 }
        : undefined;
    },
    close() {
      db.close();
    },
  };
}
