#!/usr/bin/env bash
# Deploy SwapChan behind the Cloudflare tunnel "swapchan". Idempotent.
#   BUILT on Battleaxe   (docker context "battleaxe": the fast CPU, a LAN hop from this checkout)
#   RUN on the droplet   (docker context "arb-nyc" = ssh://arb-nyc-root, DigitalOcean arb-engine-nyc)
#   carried between them by ghcr.io/tsavo/swapchan-{api,web,mcp}:<git sha>
# Why a registry: Battleaxe's uplink is ~1 MB/s, and a push sends only the layers that changed, where piping
# `docker save` across would resend all ~2.5 GB on every deploy. Registry auth is the Mac's own
# `docker login ghcr.io`; the docker CLI sends it with each push and pull, so neither box stores a token.
#
#   deploy/deploy.sh                                   build, push, pull, (re)start api web mcp cloudflared
#   SERVICES="api web" deploy/deploy.sh                a subset
#   SKIP_BUILD=1 SWAPCHAN_TAG=<sha> deploy/deploy.sh   redeploy or roll back to an image already in the registry
#
# One-time setup on the Mac:
#   docker context create arb-nyc --docker host=ssh://arb-nyc-root
#   gh auth token | docker login ghcr.io -u <github login> --password-stdin    (the token needs write:packages)
#
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
BUILD_CTX=${BUILD_CTX:-battleaxe}
RUN_CTX=${RUN_CTX:-arb-nyc}
for ctx in "$BUILD_CTX" "$RUN_CTX"; do
  docker context inspect "$ctx" >/dev/null 2>&1 \
    || { echo "docker context $ctx does not exist (one-time setup is at the top of $0)" >&2; exit 1; }
done
export SWAPCHAN_REGISTRY=${SWAPCHAN_REGISTRY:-ghcr.io/tsavo}
if [ -z "${SWAPCHAN_TAG:-}" ]; then
  SWAPCHAN_TAG=$(git rev-parse --short=7 HEAD)
  # A tag names the commit its image was built from; an uncommitted tree must never overwrite that image.
  git diff --quiet HEAD || SWAPCHAN_TAG="$SWAPCHAN_TAG-dirty-$(date +%Y%m%d%H%M%S)"
fi
export SWAPCHAN_TAG

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
BUILT=""; for s in $SERVICES; do case $s in api|web|mcp) BUILT="$BUILT $s" ;; esac; done
echo "deploying $SWAPCHAN_REGISTRY/swapchan-*:$SWAPCHAN_TAG ($SERVICES): build on $BUILD_CTX, run on $RUN_CTX"
if [ -n "$BUILT" ]; then
  if [ -z "${SKIP_BUILD:-}" ]; then
    docker --context "$BUILD_CTX" compose build $BUILT
    docker --context "$BUILD_CTX" compose push $BUILT
  fi
  docker --context "$RUN_CTX" compose pull $BUILT
fi

# ONE TUNNEL CONNECTOR. Cloudflare spreads a tunnel's requests over every connector running its token, so a
# cloudflared still up on the other box would serve part of the traffic from a second copy of api-data (short
# links, sessions, partners) and the two would silently diverge. Checked here, after the slow build/push/pull,
# so that work can run while the other box is still live; only starting containers waits for it to be stopped.
for ctx in battleaxe arb-nyc; do
  [ "$ctx" = "$RUN_CTX" ] && continue
  if docker --context "$ctx" ps -q --filter label=com.docker.compose.project=swapchan \
       --filter label=com.docker.compose.service=cloudflared 2>/dev/null | grep -q .; then
    echo "a SwapChan tunnel connector is still RUNNING on $ctx: stop that stack before starting it on $RUN_CTX" >&2
    exit 1
  fi
done

docker --context "$RUN_CTX" compose up -d --no-build $SERVICES
docker --context "$RUN_CTX" compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.State}}\t{{.Status}}'

# The droplet's disk is shared with other services: keep the three newest builds of each image there. Older ones
# stay in the registry (roll back with SKIP_BUILD=1 SWAPCHAN_TAG=<sha>). docker refuses to remove an image in use.
for s in $BUILT; do
  docker --context "$RUN_CTX" images "$SWAPCHAN_REGISTRY/swapchan-$s" --format '{{.Repository}}:{{.Tag}}' \
    | sed -n '4,$p' | while read -r img; do docker --context "$RUN_CTX" rmi "$img" >/dev/null 2>&1 || true; done
done
