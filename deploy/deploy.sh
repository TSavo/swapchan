#!/usr/bin/env bash
# Deploy SwapChan to Battleaxe (docker context "battleaxe") behind the Cloudflare tunnel "swapchan". Idempotent.
#   deploy/deploy.sh             build and (re)start api, web, mcp, cloudflared
#   SERVICES="api web" deploy/deploy.sh   a subset
# Secrets come from Vault here and live only in this process's environment; compose hands them to the containers.
#   secret/swapchan/cloudflare  tunnel_token, tunnel_id     (required: written when the tunnel was created)
#   secret/swapchan/fees        recipient, bps, lifi_enabled              (integrator fee; unset = no fee)
#   secret/swapchan/providers   zerox, lifi, relay, etherscan, cryptoid, velora, jupiter, oneinch, debridge_referral  (API keys; unset = provider off / free tier)
#   secret/swapchan/fees        ... solana, bitcoin, tron, thorname (THORChain affiliate)
#   secret/swapchan/reown       project_id                  (wallet connect; unset = connect disabled)
#   secret/swapchan/analytics   measurement_id              (GA4; unset = no analytics)
#   secret/swapchan/api         keys                        (SWAPCHAN_API_KEYS; unset = API open)
#   secret/swapchan/mcp         keys                        (MCP_API_KEYS; unset = MCP open, rate-limited)
#   secret/swapchan/internal    key                         (SWAPCHAN_INTERNAL_KEY, shared by api+mcp; unset = MCP callers share one API rate bucket)
#   secret/swapchan/recover     link_secret                 (SWAPCHAN_RECOVER_LINK_SECRET, shared by api+web; unset = /recover to=/data= links fail closed)
set -euo pipefail
cd "$(dirname "$0")"
[ "$(docker context show)" = battleaxe ] || { echo "docker context is not battleaxe"; exit 1; }

# The Mac's Vault is plain http on loopback; default it so reads don't silently come back empty.
export VAULT_ADDR=${VAULT_ADDR:-http://127.0.0.1:8200}
need() {  # need <path under secret/swapchan/> <field>: the value, or exit 1 with why
  local v
  v=$(vault kv get -field="$2" "secret/swapchan/$1" 2>/dev/null) && [ -n "$v" ] \
    || { echo "Vault secret/swapchan/$1 $2 is empty or unreadable (VAULT_ADDR=$VAULT_ADDR): not deploying" >&2; return 1; }
  printf %s "$v"
}
opt() { vault kv get -field="$2" "secret/swapchan/$1" 2>/dev/null || true; }

TUNNEL_TOKEN=$(need cloudflare tunnel_token) || exit 1
export TUNNEL_TOKEN
export SWAPCHAN_FEE_RECIPIENT=$(opt fees recipient)
export SWAPCHAN_FEE_BPS=$(opt fees bps)
export SWAPCHAN_LIFI_FEE=$(opt fees lifi_enabled)   # 1 after portal.li.fi has the fee wallet
export ZEROX_API_KEY=$(opt providers zerox)
export LIFI_API_KEY=$(opt providers lifi)
export LIFI_INTEGRATOR=$(opt providers lifi_integrator)   # portal.li.fi integrator name (default myswapchan)
export RELAY_API_KEY=$(opt providers relay)
export CRYPTOID_API_KEY=$(opt providers cryptoid)   # chainz.cryptoid.info (old coins; keyless = 1 call / 10 s)
export JUPITER_API_KEY=$(opt providers jupiter)   # optional: developers.jup.ag/portal (keyless = 0.5 RPS)
export SWAPCHAN_FEE_RECIPIENT_SOLANA=$(opt fees solana)   # Jupiter platform fee owner
export VELORA_API_KEY=$(opt providers velora)
export ONEINCH_API_KEY=$(opt providers oneinch)   # business.1inch.com (unset = 1inch off)
export THORCHAIN_AFFILIATE=$(opt fees thorname)   # registered THORName for affiliate fees
export DEBRIDGE_REFERRAL_CODE=$(opt providers debridge_referral)
export ETHERSCAN_API_KEY=$(opt providers etherscan)   # full account history (Ethereum/Arbitrum/Polygon/Linea); find_money archaeology, wallet history, PnL
export ALCHEMY_API_KEY=$(opt providers alchemy)        # getAssetTransfers = interaction-native discovery on Base/Arbitrum (no free explorer)
export NEXT_PUBLIC_REOWN_PROJECT_ID=$(opt reown project_id)
export NEXT_PUBLIC_GA_ID=$(opt analytics measurement_id)   # GA4 (property 389907174)
export CROSSMINT_SERVER_KEY=$(opt crossmint api_key)             # card on-ramp: server order creation (api)
export NEXT_PUBLIC_CROSSMINT_CLIENT_KEY=$(opt crossmint client_key)  # card on-ramp: embedded checkout (web, build-time)
export MOONPAY_PUBLISHABLE_KEY=$(opt moonpay publishable_key)        # card on-ramp: pk_live_/pk_test_ in the signed widget URL (api)
export MOONPAY_SECRET_KEY=$(opt moonpay secret_key)                  # card on-ramp: sk_live_/sk_test_ HMAC-signs the widget URL (api)
export NEXT_PUBLIC_MOONPAY_PUBLISHABLE_KEY=$(opt moonpay publishable_key)  # card on-ramp: MoonPay Web SDK apiKey (web, build-time, public)
export SWAPCHAN_API_KEYS=$(opt api keys)
export MCP_API_KEYS=$(opt mcp keys)
export SWAPCHAN_INTERNAL_KEY=$(opt internal key)   # proves MCP->API calls so x-swapchan-client-ip is trusted
export SWAPCHAN_RECOVER_LINK_SECRET=$(opt recover link_secret)   # HMAC-signs /recover links (api) and verifies them (web)
export SWAPCHAN_SESSION_SECRET=$(opt smartwallet session_secret)   # HMAC key for the SmartWallet sign-to-view session cookie
export SWAPCHAN_COOKIE_DOMAIN=$(opt smartwallet cookie_domain)     # e.g. .swapchan.com so the cookie spans swapchan.com + api.swapchan.com
# SmartWallet agent brain: the OAuth token lives under nefariousplan, not swapchan, so read it directly.
# Unset = /chat + SSE still mount but no agent runs.
export CLAUDE_CODE_OAUTH_TOKEN=$(vault kv get -field=token secret/nefariousplan/claude-oauth 2>/dev/null || true)
# Smart-wallet agent model: Sonnet is the right tier here (conversational, tool-driven; no heavy
# reasoning). Override by exporting SWAPCHAN_AGENT_MODEL before the deploy.
export SWAPCHAN_AGENT_MODEL=${SWAPCHAN_AGENT_MODEL:-claude-sonnet-5-5}
if [ -z "$MCP_API_KEYS" ]; then export MCP_ALLOW_ANONYMOUS=1; else export MCP_ALLOW_ANONYMOUS=0; fi

SERVICES=${SERVICES:-api web mcp cloudflared}
docker compose up -d --build $SERVICES
docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
