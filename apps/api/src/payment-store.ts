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
  const insert = db.prepare("INSERT OR IGNORE INTO payment_intents(hash,quote) VALUES (?,?)");
  const read = db.prepare("SELECT quote, relayed FROM payment_intents WHERE hash=?");
  const relay = db.prepare("UPDATE payment_intents SET relayed=1 WHERE hash=?");
  return {
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
