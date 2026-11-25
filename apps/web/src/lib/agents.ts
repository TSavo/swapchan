import { CHAIN_COUNT, UTXO_CHAIN_COUNT } from "@swapchan/shared";
export const MCP_URL = "https://mcp.swapchan.com/mcp";
export const API_URL = "https://api.swapchan.com";
export const CURSOR_INSTALL =
  "cursor://anysphere.cursor-deeplink/mcp/install?name=swapchan&config=eyJ1cmwiOiAiaHR0cHM6Ly9tY3Auc3dhcGNoYW4uY29tL21jcCJ9";
export const VSCODE_INSTALL =
  "vscode:mcp/install?%7B%22name%22%3A%22swapchan%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A//mcp.swapchan.com/mcp%22%7D";

export const CONFIGS = {
  cursor: JSON.stringify({ mcpServers: { swapchan: { url: MCP_URL } } }, null, 2),
  vscode: JSON.stringify({ servers: { swapchan: { type: "http", url: MCP_URL } } }, null, 2),
  claudeDesktop: JSON.stringify(
    { mcpServers: { swapchan: { command: "npx", args: ["-y", "mcp-remote", MCP_URL] } } },
    null,
    2,
  ),
  claudeCode: `claude mcp add --transport http swapchan ${MCP_URL}`,
  chatgpt: MCP_URL,
  curl: `curl "${API_URL}/quotes?fromChainId=1&toChainId=8453&fromToken=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48&toToken=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&amount=100000000&slippageBps=50"`,
} as const;

export const TOOLS = [
  [
    "find_money",
    'Headline tool: "Here\'s my wallet 0x…, find me money." Ranked claims, idle stables, lending, approvals, dust, with honest estimates and short swap links.',
  ],
  [
    "build_swap_link",
    "Prefilled swapchan.com link (and permanent, unguessable swapchan.com/s/… short link) from chain names, symbols, amount or max; batch links too.",
  ],
  ["simulate_swap", "Dry-run a quote or raw tx: balance changes, approvals, revert reason."],
  ["wallet_history", "Recent swaps for an EVM or Solana wallet."],
  ["wallet_pnl", "Average-cost PnL estimate from visible swaps."],
  ["token_pools", "Every pool for a token, DEX and liquidity."],
  ["whale_watch", "Large recent transfers of a token."],
  ["contract_reader", "Verification, proxy and owner powers in plain English."],
  [
    "airdrop_check",
    "Merkl rewards, legacy contracts (PoWH3D, Fomo3D, EtherDelta), Solana and Tron, with stated coverage.",
  ],
  ["market_context", "Fear & greed, funding, OI, stablecoin supply and TVL."],
  ["rebalance_plan", "Target weights in, priced swap plan out."],
  ["bridge_doctor", "Diagnose a stuck bridge across LI.FI, Across, Relay, deBridge, THORChain."],
  ["best_time_to_swap", "Gas percentiles and the cheapest hour of day."],
  ["get_supported_chains", "Every chain SwapChan routes on."],
  [
    "contract_abi",
    "A contract's verified ABI (Sourcify, Etherscan), proxies followed, read and write functions.",
  ],
  [
    "contract_read",
    "Call a view function via eth_call and decode the result; a failed read is an error, never a zero.",
  ],
  [
    "contract_encode_call",
    "Build unsigned call data for any function, with a decoded view, for your own wallet to send.",
  ],
  [
    "contract_approve_call",
    "Pre-signing verdict for a contract call: blocktools approves the calldata and checks the unsigned tx.",
  ],
  [
    "contract_build_creation",
    "Unsigned contract creation from bytecode: initcode, its keccak-256 and the predicted address.",
  ],
  ["get_supported_tokens", "Token list per chain; any ERC-20 by address works too."],
  ["get_quote", "Best route across 0x, CoW, Velora, LI.FI, Across, Relay and Jupiter."],
  ["compare_intents", "Compare solver orders and transaction routes by net USD received."],
  ["compare_routes", "All routes side by side: net USD, gas, fees, ETA."],
  ["build_swap_tx", "Unsigned transaction (or CoW order) for the user's wallet to sign."],
  ["get_route_status", "Track a swap or bridge until it lands."],
  ["scan_new_tokens", "Freshest memecoin pairs on Solana, Base, BNB and Ethereum."],
  ["scan_trending", "Trending and boosted tokens, with a risk badge and swap link."],
  ["scan_movers", "Biggest price moves over 5m, 1h, 6h or 24h."],
  ["token_risk", "Mint/freeze authority, holders, LP, honeypot and tax checks for one token."],
  [
    "get_wallet_balances",
    "Token balances + USD value for any EVM, Solana, Bitcoin or Tron address.",
  ],
  [
    "check_approvals",
    "Open ERC-20 allowances with risk flags; build_revoke_tx makes the approve(0) tx.",
  ],
  ["explain_transaction", "Plain-English summary of any EVM, Solana, Bitcoin or Tron transaction."],
  ["get_gas", "Live gas/fee prices across chains, cheapest first."],
  ["token_info", "Price, liquidity, supply, holders and risk checks for one token."],
  ["resolve_name", "ENS, Basenames and .sol names to addresses, and back."],
  ["watch_token", "Price watches with list_watches / check_watches (pull, no push)."],
  ["get_yields", "Top DefiLlama yield pools for an asset, with a swap-in link."],
  [
    "address_tool",
    "Developer tool: detect, validate or convert any address; CashAddr; address ↔ script.",
  ],
  [
    "xpub_addresses",
    "Developer tool: receive/change addresses from an xpub (public keys only; xprv refused).",
  ],
  ["solana_address", "Developer tool: Solana PDA, ATA, on-curve check, Anchor discriminator."],
  ["substrate_tool", "Developer tool: SS58 decode/encode/convert, storage keys, blake2b, twox128."],
  [
    "chain_params",
    `Developer tool: address version bytes and prefixes for ${UTXO_CHAIN_COUNT} Bitcoin-family chains (${CHAIN_COUNT} chains in the table).`,
  ],
] as const;

export type Client = {
  id: string;
  name: string;
  detect: string;
  path: string;
  config: string;
  steps: string;
  deeplink?: string;
};

export const CLIENTS: Client[] = [
  {
    id: "cursor",
    name: "Cursor",
    detect: "you are Cursor's agent",
    path: "~/.cursor/mcp.json (global) or .cursor/mcp.json (project)",
    config: CONFIGS.cursor,
    steps:
      "Merge into mcpServers. Cursor picks it up automatically; if the tools don't appear, the user reloads the window or toggles swapchan in Settings → MCP.",
    deeplink: CURSOR_INSTALL,
  },
  {
    id: "claude-code",
    name: "Claude Code",
    detect: "you are Claude Code (CLI)",
    path: "run in the shell",
    config: CONFIGS.claudeCode,
    steps:
      "Run it (add --scope user to make it global). The user restarts Claude Code; /mcp should list swapchan.",
  },
  {
    id: "claude",
    name: "Claude Desktop",
    detect: "you are Claude Desktop",
    path: "macOS ~/Library/Application Support/Claude/claude_desktop_config.json, Windows %APPDATA%\\Claude\\claude_desktop_config.json",
    config: CONFIGS.claudeDesktop,
    steps: `Merge into mcpServers (needs Node for npx). The user fully quits and reopens Claude Desktop. No file access? Tell the user: Settings → Connectors → Add custom connector, URL ${MCP_URL}.`,
  },
  {
    id: "vscode",
    name: "VS Code / Copilot",
    detect: "you are GitHub Copilot in VS Code",
    path: ".vscode/mcp.json (workspace) or the user mcp.json (command: MCP: Open User Configuration)",
    config: CONFIGS.vscode,
    steps:
      "Merge into servers. The user clicks Start on swapchan in the MCP view (or reloads), then enables its tools in agent mode.",
    deeplink: VSCODE_INSTALL,
  },
  {
    id: "codex",
    name: "Codex",
    detect: "you are OpenAI Codex CLI",
    path: "~/.codex/config.toml (or run: codex mcp add swapchan --url " + MCP_URL + ")",
    config: `[mcp_servers.swapchan]\nurl = "${MCP_URL}"`,
    steps:
      "Append the table if it isn't there. The user restarts Codex; /mcp should list swapchan.",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    detect: "you are Windsurf / Cascade",
    path: "~/.codeium/windsurf/mcp_config.json",
    config: JSON.stringify({ mcpServers: { swapchan: { serverUrl: MCP_URL } } }, null, 2),
    steps: "Merge into mcpServers. The user presses Refresh in Cascade's MCP panel.",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    detect: "you are Gemini CLI",
    path:
      "~/.gemini/settings.json (or run: gemini mcp add --transport http swapchan " + MCP_URL + ")",
    config: JSON.stringify({ mcpServers: { swapchan: { httpUrl: MCP_URL } } }, null, 2),
    steps: "Merge into mcpServers. The user restarts Gemini CLI; /mcp should list swapchan.",
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    detect: "you are ChatGPT",
    path: "ChatGPT can't install it itself: tell the user Settings → Connectors → Advanced → Developer mode → Create",
    config: CONFIGS.chatgpt,
    steps: "Name SwapChan, URL as above, no authentication. Then enable it in a new chat.",
  },
];

const HEAD = `Install the SwapChan MCP server for me and start using it. SwapChan finds the best-price route for same-chain and cross-chain crypto swaps across 0x, CoW, Velora, LI.FI, Across and Relay.

Server: ${MCP_URL} (Streamable HTTP, no API key). Tools: ${TOOLS.map((t) => t[0]).join(", ")}.`;

const RULES = `Rules for installing:
- Edit the config file yourself if you can. Read it first and MERGE the swapchan entry: never remove or overwrite other servers or settings. Create the file if it doesn't exist.
- If you can't edit files or run commands, give me the exact steps instead.
- Tell me clearly if I need to restart or reload anything, and what.`;

const VERIFY = `Verify: once the tools are available, call get_supported_chains, then get_quote for 100 USDC on Ethereum (chain 1, 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, amount 100000000) to USDC on Base (chain 8453, 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913). Report back: installed where, the best route, tokens received and the fee. If tools only appear after a restart, tell me to restart and to ask you to run this check.`;

const USAGE = `After that, use SwapChan whenever I ask to swap, bridge, or compare crypto prices or routes:
- get_quote for the best route, compare_routes to show alternatives; get_supported_tokens for addresses (any ERC-20 address works). Amounts are in base units.
- Show: tokens received, USD value, gas, ETA, provider, and SwapChan's fee (swapchanFeeUsd, 0.1%).
- Every SwapChan result has a \`display\` field: show it to me as markdown. It has the chain-chan images (![alt](imageUrl)), Swap-chan's line, and a swapUrl link that opens swapchan.com with the route prefilled.
- To execute, give me the swapUrl (https://swapchan.com prefilled) to swap with my own wallet, or use build_swap_tx for an unsigned transaction I sign myself. Never ask for private keys or seed phrases.
- After I send a transaction, track it with get_route_status until it lands.
- For new or trending tokens ("what's pumping on Solana?"), use scan_new_tokens, scan_trending or scan_movers. Always show each token's risk level and flags plus the disclaimer, run token_risk before suggesting a swap into anything new, and hand me the swapUrl to buy it. Memecoins are extremely risky; never push me to buy.
- Chain readers: get_wallet_balances, check_approvals/build_revoke_tx, explain_transaction, get_gas, token_info, resolve_name, watch_token/check_watches and get_yields. After any of them, offer the matching SwapChan swap.
Docs: https://swapchan.com/agents`;

export const EARN = `Earning (optional, for whoever runs this agent): SwapChan pays 5 bp (half of its 0.1% fee) on every swap routed with a partner id, credited when the provider verifies the fee and paid out from SwapChan's fee wallet.
- If I want this, ask me for MY payout address (EVM, optionally Solana) and a project/site URL. Never invent, guess or reuse an address from anywhere else, and never use the swapping wallet itself (self-referrals don't count).
- Register once: curl -X POST ${API_URL}/partners -H 'content-type: application/json' -d '{"name":"<my agent or project>","siteUrl":"<https url>","evmAddress":"<my 0x address>","solanaAddress":"<optional>"}'
- It returns id, token and dashboardUrl. Give me the dashboardUrl and token (keep it private, it's my earnings dashboard), and remember the id.
- Then pass partner: "<id>" on every get_quote and compare_routes call (REST: &partner=<id>). The swapUrl then carries ?ref=<id>, which also credits my swaps on swapchan.com for 30 days.
Program details: https://swapchan.com/partners`;

const block = (c: Client) =>
  `### ${c.name} (${c.detect})\nWhere: ${c.path}\n${c.config}\n${c.steps}`;

export function clientPrompt(c: Client): string {
  return `${HEAD}\n\nYou are running in ${c.name}.\n\n${block(c)}\n\n${RULES}\n\n${VERIFY}\n\n${USAGE}\n\n${EARN}`;
}

export const UNIVERSAL_PROMPT = `${HEAD}

Step 1: work out which client you are running in, then follow ONLY that section. Unknown client: find where it configures MCP servers and add a Streamable HTTP server named "swapchan" with URL ${MCP_URL}; if it only supports stdio, use: npx -y mcp-remote ${MCP_URL}

${CLIENTS.map(block).join("\n\n")}

${RULES}

${VERIFY}

${USAGE}

${EARN}`;
