# @swapchan/mcp — SwapChan MCP server

Swap-chan for AI agents: best-price **same-chain and cross-chain** EVM swap quotes, route comparison and
**unsigned** swap transactions over the [Model Context Protocol](https://modelcontextprotocol.io).
- Official MCP TypeScript SDK **v2** (`@modelcontextprotocol/server` 2.3.1, spec 2026-07-28; stateless, also serves 2025-era clients).
- Transports: **Streamable HTTP** at `/mcp` (remote, API-key auth + per-key rate limits) and **stdio** (`--stdio`, local).
- Talks to `apps/api` over HTTP using the frozen contract in `packages/shared/README.md`. No chain keys, no signing, no custody, ever. `broadcast_tx` only relays a transaction the user already signed locally, unchanged; it cannot alter it.

## Tools

| Tool                      | What it does                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `get_supported_chains`    | Chains + their chain-chan mascots                                                                                                      |
| `contract_abi`            | Contract ABI from Sourcify / Etherscan (or pasted), proxies followed (5 kinds)                                                         |
| `contract_read`           | eth_call a view function and decode it (failed read = error, never zero)                                                               |
| `contract_encode_call`    | Unsigned call data + decoded view for your own wallet to send                                                                          |
| `contract_approve_call`   | Pre-signing verdict (blocktools approve + verifyTx); do not send on fail                                                               |
| `contract_build_creation` | Unsigned contract creation: initcode, keccak, predicted address                                                                        |
| `get_supported_tokens`    | Token list, optional `chainId` / `search`                                                                                              |
| `get_quote`               | Single best route (net USD after gas + fees)                                                                                           |
| `compare_routes`          | All routes ranked; `alsoToChainIds` compares same-chain vs cross-chain destinations                                                    |
| `build_swap_tx`           | Unsigned tx for best/chosen route + exact-amount ERC-20 approve tx if needed + `eth_call` simulation (when `RPC_URL_<chainId>` is set) |
| `get_route_status`        | `pending` / `done` / `failed` / `not_found` + destination tx hash                                                                      |

Amounts: pass `amount` as a decimal **string** (`"1.5"`, converted with token decimals) or `amountBaseUnits` (wei). Slippage is in bps,
default 50, hard-capped by `MCP_MAX_SLIPPAGE_BPS` (default 300). All failures come back as `isError` tool results with a readable reason.

`permit2` is currently always `null`: the API contract v1 has no Permit2 typed data yet. When `apps/api` adds it, it will be passed through.

## Run

```bash
pnpm --filter @swapchan/mcp build
SWAPCHAN_API_URL=http://localhost:8787 MCP_API_KEYS=key1,key2 pnpm --filter @swapchan/mcp start   # http://127.0.0.1:8788/mcp
SWAPCHAN_API_URL=http://localhost:8787 node apps/mcp/dist/index.js --stdio                         # stdio
node apps/mcp/dist/mockApi.js                                                                      # fake API on :8787 for local play
```

| Env                                                 | Default                 |                                                                                        |
| --------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `SWAPCHAN_API_URL`                                  | `http://localhost:8787` | apps/api base URL (falls back to `NEXT_PUBLIC_API_URL`)                                |
| `SWAPCHAN_API_KEY`                                  | –                       | sent upstream as `x-api-key` if set                                                    |
| `MCP_HOST` / `MCP_PORT`                             | `127.0.0.1` / `8788`    | set `MCP_HOST=0.0.0.0` behind a TLS proxy in prod                                      |
| `MCP_API_KEYS`                                      | –                       | comma-separated keys; clients send `x-api-key: <key>` or `Authorization: Bearer <key>` |
| `MCP_ALLOW_ANONYMOUS`                               | off                     | allow keyless HTTP (rate-limited per IP)                                               |
| `MCP_RATE_LIMIT_PER_MIN`                            | `60`                    | per key token bucket; 429 + `Retry-After`                                              |
| `MCP_MAX_SLIPPAGE_BPS` / `MCP_DEFAULT_SLIPPAGE_BPS` | `300` / `50`            |                                                                                        |
| `RPC_URL_<chainId>`                                 | –                       | enables allowance check + simulation in `build_swap_tx`                                |

## Client config

**Claude Code**
```bash
claude mcp add --transport http swapchan https://mcp.swapchan.com/mcp --header "x-api-key: YOUR_KEY"
```

**Claude Desktop** (`claude_desktop_config.json`, local stdio)
```json
{
  "mcpServers": {
    "swapchan": {
      "command": "node",
      "args": ["/path/to/SwapChan/apps/mcp/dist/index.js", "--stdio"],
      "env": { "SWAPCHAN_API_URL": "https://api.swapchan.com" }
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "swapchan": { "url": "https://mcp.swapchan.com/mcp", "headers": { "x-api-key": "YOUR_KEY" } }
  }
}
```

**MCP Inspector**
```bash
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8788/mcp --transport http --header "x-api-key: key1" --method tools/list
```

## Registry

`server.json` (schema 2025-12-11, validated) publishes the remote as `io.github.TSavo/swapchan` via `mcp-publisher publish`.
Hosted at `https://mcp.swapchan.com/mcp`.

## Payment review

Base Sepolia quotes include USDC, WETH and native ETH balances at the quote block. When existing WETH cannot cover the swap, `wrapNativeWei` specifies the ETH to wrap inside the signed batch. That amount contributes to `maxWethWei`, the total router spend cap. Unused WETH stays with the sender. Gas is collected in USDC. An underfunded wallet receives a `quote_only` review with the additional WETH or alternative USDC amount required. Request a fresh quote after funding before building.

For a Base Sepolia payment, call `pay` with the intent, review the returned limits, then call `pay` with the same destination chain and the chosen `quoteId`. This second call builds the operation and runs `verify_bundle`'s checks against the exact operation and delegation. It returns the verifier's EIP-712 signing data and the verified payout, sender, recipient, fee limits and expiry. The connected wallet signs after approval.

## Exact USDC payments

For an exact Optimism Sepolia payment (`chainId: 11155420`), omit `intent.sourceChainId` in `pay` to compare available funding routes. The default comparison prices a local USDC transfer, an Across deposit, and a Circle burn with destination forwarding. Set the source to `84532` to compare Across and Circle using Base Sepolia funds, or supply both `sourceChainId: 84532` and `provider: "circle_cctp"` for Circle. Set the source to `11155420` for a local transfer. An explicit source restricts the quote to that chain. A bridge result with `depositLimitIssue: "below_minimum"` is ineligible for execution.

With Circle, the quoted USDC spend includes the exact payout and the forwarding fee. Origin gas is priced in Base Sepolia ETH. Build the selected quote with `pay`. If the build returns an approval, wait for its successful receipt before requesting the burn. After broadcasting the burn, add its hash to the returned `payment_status.circle` arguments. A settled response verifies the original burn and the recipient’s exact USDC gain on Optimism Sepolia after both blocks finalize.

For Solana devnet, the following `pay` intent compares the total cost of spending local USDC and forwarding USDC from Base Sepolia. Supply addresses whose wallets you can ask to sign.

```json
{
  "chainId": "solana:devnet",
  "intent": {
    "recipient": "<Solana recipient>",
    "amountMicroUsdc": "1",
    "fundingAddresses": { "solana": "<Solana owner>", "evm": "<Base Sepolia owner>" }
  }
}
```

Call `pay` a second time with the same destination chain and the returned `reviewId` to build the recommended route. A local transfer uses Wallet Standard. To cover SOL fees from another wallet, add `intent.feePayer`. The owner signs first. Return its signed bytes in `senderSignedTransaction` with the quote ID so the fee payer can sign and send. Track the signature with `payment_status.solanaDevnet`. On the Circle route, the Base wallet approves the exact input if needed and submits the burn. Track the returned quote ID and burn hash with `payment_status.circleSolana`. The destination wallet can receive USDC with zero SOL.

For a leftover Base Sepolia paymaster allowance, call `build_revoke_tx` with the token and spender from the receipt. Add `relayedPaymaster: { owner, relayer }` if another account will pay gas. The owner signs the zero-value USDC permit. Repeat the call with its `nonce`, `deadline`, and `signature` in `relayedPaymaster.signed`. The relayer receives the simulated transaction and estimated fee. Calling again after confirmation returns `already_revoked`.
## Tests

Run `pnpm --filter @swapchan/mcp e2e:payments` against a running MCP server and API to check the live payment flow. Set `MCP_URL` if the server uses a different URL from `http://127.0.0.1:8788/mcp`, and set `MCP_KEY` if it requires authentication. The check compares the three Optimism Sepolia funding routes through `pay` and `quote_payment`. It verifies a historical finalized Base-to-Optimism transfer and reports the settlement states of the roadmap’s Across deposit and Circle burn. It uses public wallet addresses and requires no signing key.

`pnpm --filter @swapchan/mcp test` boots a mock of the API contract (`src/mockApi.ts`) and drives the real HTTP server with the SDK
`Client` over Streamable HTTP: tool listing, every tool, auth 401s, 429 rate limiting, slippage cap, input validation and upstream errors.
