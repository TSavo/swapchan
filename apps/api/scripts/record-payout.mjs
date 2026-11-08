#!/usr/bin/env node
// Record a manual partner payout in the widget partner DB.
// On the droplet, from the Mac:  cd deploy && docker --context arb-nyc compose exec api node scripts/record-payout.mjs <partnerId> <amountUsd> <txHash> [note]
import { DatabaseSync } from "node:sqlite";

const [id, amount, tx, ...note] = process.argv.slice(2);
const usd = Number(amount);
if (!id || !(usd > 0) || !tx) {
  console.error("usage: record-payout.mjs <partnerId> <amountUsd> <txHash> [note]");
  process.exit(1);
}
const db = new DatabaseSync(`${process.env.SWAPCHAN_DATA_DIR ?? "/data"}/partners.db`);
if (!db.prepare("SELECT 1 FROM partners WHERE id = ?").get(id)) {
  console.error(`unknown partner: ${id}`);
  process.exit(1);
}
db.prepare(
  "INSERT INTO partner_payouts (partner_id, amount_usd, tx_hash, note, created_at) VALUES (?, ?, ?, ?, ?)",
).run(id, usd, tx, note.join(" ") || null, Date.now());
console.log(`recorded $${usd} payout to ${id} (${tx})`);
