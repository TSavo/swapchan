#!/usr/bin/env bash
# Off-box backup of SwapChan's permanent data (links.db = short URLs, "URLs are forever"; partners.db; watches.db = price watches + the pre-6539e94 stray short links; batches.db = find_money_batch jobs, 6h).
# Runs nightly at 03:17 from the Mac via launchd (~/Library/LaunchAgents/com.swapchan.backup-links.plist).
#   1. VACUUM INTO a consistent snapshot inside the api container (the droplet, docker context arb-nyc, volume api-data)
#   2. copy it to the Mac: ~/Backups/swapchan/<db>-YYYY-MM-DD.db (keep 90 days)
#   3. upload it to Cloudflare R2: swapchan-backups/<db>/<date>.db and <db>/latest.db (token: secret/shared/cloudflare r2_edit)
set -euo pipefail
export PATH=/usr/local/bin:/opt/homebrew/bin:$PATH
export VAULT_ADDR=${VAULT_ADDR:-http://127.0.0.1:8200}
CTX=${SWAPCHAN_CTX:-arb-nyc}; C=swapchan-api-1; OUT=$HOME/Backups/swapchan; D=$(date +%F)
mkdir -p "$OUT"
T=$(vault kv get -field=r2_edit secret/shared/cloudflare 2>/dev/null || true)
A=$(vault kv get -field=account_id secret/swapchan/cloudflare 2>/dev/null || true)
for db in links partners watches batches; do
  docker --context $CTX exec $C node -e "
    const {DatabaseSync}=require('node:sqlite');const fs=require('node:fs');
    fs.rmSync('/tmp/$db-offbox.db',{force:true});
    new DatabaseSync('/data/$db.db').exec(\"VACUUM INTO '/tmp/$db-offbox.db'\")"
  docker --context $CTX cp "$C:/tmp/$db-offbox.db" "$OUT/$db-$D.db"
  n=$(sqlite3 "$OUT/$db-$D.db" "PRAGMA integrity_check" 2>/dev/null || echo unknown)
  echo "$(date '+%F %T %Z') $db -> $OUT/$db-$D.db ($(wc -c <"$OUT/$db-$D.db") bytes, integrity=$n)"
  if [ -n "$T" ] && [ -n "$A" ]; then
    for key in "$db/$D.db" "$db/latest.db"; do
      curl -sf -X PUT -H "Authorization: Bearer $T" --data-binary @"$OUT/$db-$D.db" \
        "https://api.cloudflare.com/client/v4/accounts/$A/r2/buckets/swapchan-backups/objects/$key" >/dev/null \
        && echo "  r2 swapchan-backups/$key ok" || echo "  r2 upload $key FAILED"
    done
  fi
done
find "$OUT" -name '*.db' -mtime +90 -delete
