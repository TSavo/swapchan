# SwapChan

**Best-price same-chain and cross-chain crypto swap routing — as an MCP server, with an anime cast.** 🎌

SwapChan fans out a single swap request to LI.FI, 0x, CoW, Velora, Across, Relay, Jupiter, KyberSwap, 1inch, deBridge and THORChain at once, ranks every route by net USD after gas and fees, and returns an **unsigned** transaction for the winner. It never signs, never holds keys or funds, and never controls your money — your wallet signs. The optional `broadcast_tx` only relays a transaction you already signed locally, unchanged, to 51 chains (EVM, Bitcoin and its forks, Solana, Tron, XRP, Stellar, Algorand, Cosmos Hub, Polkadot, TON, Cardano); it can't alter it. 15 networks, same-chain and cross-chain.

**[swapchan.com](https://swapchan.com)** · MCP endpoint `https://mcp.swapchan.com/mcp` · Official MCP Registry `io.github.TSavo/swapchan`

## See it work

Your agent asks in plain English → SwapChan fans out to every router, ranks by net USD after gas, and hands back an **unsigned** transaction. Your wallet signs.

![SwapChan agent call: swap 100 USDC Ethereum→Base, routes ranked, unsigned tx built, user confirms](https://raw.githubusercontent.com/TSavo/swapchan/main/docs/agent-call.gif)

### find_money: paste your addresses, get your money back

Paste wallet addresses into your agent → `find_money` scans every chain and contract the wallet touched, ranks what's recoverable, and builds **unsigned** recovery txs (unwrap, withdraw, redeem) plus one swap-to-USDC link. Results are cached for 3 minutes and carry `asOf`, `block` and `cached`; pass `fresh` (`fresh=1` on `/onchain/money`, rate-limited per address) to re-scan. If a source times out, the result has `partial: true` and `incompleteSources`, the headline says totals are a lower bound, and it is cached for only about 20 seconds. Real numbers from a live run on vitalik.eth, plus an archive replay of a real P3D recovery.

Coverage goes beyond EVM: Solana, Tron, Bitcoin, Bitcoin forks and old coins (BCH, BTG, LTC, DOGE and FTC, DASH, DGB, RVN, VTC, VIA, QTUM, MONA, BSV, GRS, PPC, NVC, CLAM, RDD, BLK, Zcash transparent (t1), TRC, AUR, XPM and QRK), each with an unsigned sweep you sign offline in the coin's own wallet (old-coin sweeps are offered only after a Rust/WASM transaction library has built and verified them and an independent second decode agrees), and balances on XRP, XLM, ALGO, ATOM (Cosmos Hub), DOT, TON, ADA and Signum. Exits from liquidity and Pendle positions carry live-quoted minimums and a 20-minute deadline. Short links use unguessable ids.

Lost the wallet app but still have the phrase, keystore or key? `recovery_guide` (and [swapchan.com/recover](https://swapchan.com/recover)) walks you through deriving your **public** addresses offline with [blocktools](https://github.com/TSavo/blocktools) ([v0.3.2 release](https://github.com/TSavo/blocktools/releases/tag/v0.3.2): Linux x86_64 only, check it with `sha256sum -c SHA256SUMS`; other systems build from source), e.g. `seed-to-master < seed.txt | derive --preset scan-js --address-list > addresses.txt`, then pasting addresses.txt into `find_money_batch`. Your seed and keys never leave your machine; SwapChan never sees them.

![SwapChan find_money: paste addresses, scan chains, "I found $4,538 for you", ranked recovery steps, swap all to USDC](https://raw.githubusercontent.com/TSavo/swapchan/main/docs/find-money.gif)

## Use it as an MCP server

Hosted, keyless, zero setup:

```sh
claude mcp add --transport http swapchan https://mcp.swapchan.com/mcp
```

Any MCP client, via stdio bridge:

```json
{
  "mcpServers": {
    "swapchan": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.swapchan.com/mcp"]
    }
  }
}
```

### Earn 5 bp as an agent builder

Register a partner id with your payout address and pass `partner` to `get_quote` / `compare_routes` (REST: `&partner=<id>`). You earn half of SwapChan's 0.1% fee on every swap with a verified fee:

```sh
curl -X POST https://api.swapchan.com/partners -H 'content-type: application/json' \
  -d '{"name":"My Agent","siteUrl":"https://github.com/me/my-agent","evmAddress":"0xYourPayoutAddress"}'
```

Returns `id`, a private dashboard `token` and `dashboardUrl`. Sites can embed the [widget](https://swapchan.com/widget) or use `?ref=<id>` links. Details: [swapchan.com/partners](https://swapchan.com/partners).

### Tools

74 tools, as listed by the live MCP server (`tools/list`):

| Tool                       | What it does                                                                                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_supported_chains`     | List the chains SwapChan routes on, each with its chain-chan mascot.                                                                                                                                     |
| `get_utxo_deposit`         | Send Litecoin, Dogecoin or Bitcoin Cash through THORChain from any wallet that can add an OP_RETURN memo.                                                                                                |
| `track_utxo_swap`          | Read-only progress of a THORChain swap by its inbound txid: waiting, seen, swapping, paid_out, refunded or failed, with a THORChain link and the payout tx link when there is one.                       |
| `get_supported_tokens`     | List tokens SwapChan knows (address, symbol, decimals), optionally for one chain or filtered by symbol/name.                                                                                             |
| `get_quote`                | Get SwapChan's single best quote (most value landing in the wallet after gas and fees) for a same-chain or cross-chain swap.                                                                             |
| `compare_routes`           | Compare every route SwapChan found, ranked best-first by net USD received, across aggregators and bridges.                                                                                               |
| `build_swap_tx`            | Build the UNSIGNED transaction for the best (or chosen) route, plus any ERC-20 approval needed first and an eth_call simulation when an RPC is configured.                                               |
| `get_route_status`         | Track a submitted swap or cross-chain transfer by source tx hash: pending, done, failed or not_found, plus the destination tx hash once it lands.                                                        |
| `build_limit_order`        | Build a gasless CoW Protocol limit order (sell an ERC-20 for at least a target amount, valid until expiry).                                                                                              |
| `list_limit_orders`        | List a wallet's CoW limit orders on one chain with status (open, fulfilled, cancelled, expired), amounts filled and an explorer link.                                                                    |
| `cancel_limit_order`       | Get the EIP-712 OrderCancellations typed data to cancel a CoW limit order off-chain (gasless).                                                                                                           |
| `scan_new_tokens`          | Newest token pairs (GeckoTerminal new pools + DexScreener latest profiles), youngest first.                                                                                                              |
| `scan_trending`            | Trending tokens (GeckoTerminal trending pools + DexScreener top boosts), most boosted/traded first.                                                                                                      |
| `scan_movers`              | Tokens with the biggest absolute price change over `window` among new and trending pairs.                                                                                                                |
| `token_risk`               | Deep automated risk check for one token.                                                                                                                                                                 |
| `get_wallet_balances`      | Portfolio for any address, free and keyless.                                                                                                                                                             |
| `check_approvals`          | List live ERC-20 allowances an EVM wallet has granted, on one EVM chain.                                                                                                                                 |
| `build_revoke_tx`          | Unsigned transaction that sets an ERC-20 allowance to 0 (approve(spender, 0)) on an EVM chain.                                                                                                           |
| `explain_transaction`      | Plain-English explanation of any transaction on SwapChan's chains: EVM (decoded token transfers, approvals, method name, fee in USD, swap detection), Solana (signer's balance changes, programs like…   |
| `get_gas`                  | Current network fees on all SwapChan chains: EVM gas price, Solana priority fee, Bitcoin sat/vB, Tron energy fee, each converted to the USD cost of a typical swap, plus the cheapest chain.             |
| `token_info`               | Everything about one token on an EVM chain or Solana: name/symbol/decimals/supply (on-chain), USD price and FDV, holder count and top holders, creator/owner, mint/freeze authority (Solana), deploy…    |
| `resolve_name`             | Resolve a name to an address or an address to its name: ENS (vitalik.eth, with avatar and twitter), Basenames (jesse.base.eth) and Solana Name Service (toly.sol), plus reverse lookup for EVM and…      |
| `price_history`            | Past USD price of a coin from DefiLlama (keyless, no key): pass a CoinGecko id ("dogecoin") or a common ticker ("DOGE", "BTC", "ETH", "SOL") and a date, and get the spot price on that day.             |
| `watch_token`              | Add tokens to a price watchlist stored by SwapChan under your watchId.                                                                                                                                   |
| `list_watches`             | Show everything on a watchlist (thresholds, prices when added, last check).                                                                                                                              |
| `check_watches`            | Check every watched token now: current price, % change since added, which thresholds triggered, and better-route alerts for watched swaps.                                                               |
| `unwatch_token`            | Remove one item (itemId from list_watches) or, without itemId, the whole watchlist.                                                                                                                      |
| `get_yields`               | Top yields on SwapChan's chains from DefiLlama: filter by asset (USDC, ETH, SOL...), chain, min TVL (default $1M).                                                                                       |
| `find_money`               | "Give me your wallet address and I'll find you money." Scans one wallet (address, ENS, Basename or SNS) and returns RANKED actions with estimated $ values: unclaimed rewards (Merkl), forgotten money…  |
| `build_swap_link`          | Build a SwapChan deep link that opens swapchan.com with the swap card prefilled and auto-quoted, plus a permanent, unguessable short link (swapchan.com/s/<id>, random id, swap links do not expire).    |
| `simulate_swap`            | Dry-run a transaction on a fork of the live chain (eth_simulateV1 with traceTransfers on EVM, simulateTransaction on Solana) and report exact balance changes, gas used, revert reason and whether the…  |
| `wallet_history`           | Recent swaps for a wallet with USD values at swap time (DefiLlama historical prices).                                                                                                                    |
| `wallet_pnl`               | Per-token realized and unrealized PnL (average-cost basis) from the wallet's visible swap history, priced at swap time.                                                                                  |
| `token_pools`              | All DEX pools for a token (DexScreener): liquidity, 24h volume, buys/sells, pool age, estimated price impact for $1k/$10k/$100k, and LP lock/burn status (GoPlus on EVM, RugCheck on Solana).            |
| `whale_watch`              | Large recent transfers of a token (EVM public-RPC logs, last ~10k blocks), labeled buy/sell against its DEX pools, plus deployer/owner and a dev-selling alert.                                          |
| `contract_reader`          | Plain-English read of a token/contract: verified source (Sourcify, Routescan), proxy/upgradeability (EIP-1967 slots), owner and whether ownership is renounced, and the owner's dangerous powers found…  |
| `airdrop_check`            | Unclaimed rewards and claimables for a wallet: Merkl incentive rewards on 9 EVM chains, legacy contracts (PoWH3D, Fomo3D, EtherDelta, Liquity surplus, and the LegacyETH registry: confirmed…            |
| `market_context`           | Crypto market snapshot from free sources: Fear & Greed (30-day history), BTC/ETH/SOL funding rates (Hyperliquid, OKX), stablecoin supply and per-chain stablecoin flows (DefiLlama), and chain TVL with… |
| `rebalance_plan`           | Given a wallet and target weights (e.g.                                                                                                                                                                  |
| `bridge_doctor`            | Diagnose a bridge/cross-chain transfer by source tx hash: checks LI.FI, Across (needs fromChainId), Relay, deBridge DLN and THORChain in parallel, plus the origin receipt, and returns status…          |
| `best_time_to_swap`        | Gas history for an EVM chain: base fee now vs the last ~1024 blocks (p10/median/p90 + series), a cheap/normal/expensive signal, and the historically cheapest hour (UTC) from SwapChan's own 10-minute…  |
| `verify_tx`                | Run SwapChan's calldata guard + simulation on any unsigned tx and return a verdict (ok / caution / danger), findings, balance-diff simulation and a plain-language summary for human sign-off.           |
| `broadcast_tx`             | Relay a transaction the user's wallet already signed, unchanged, to 51 chains.                                                                                                                           |
| `tx_status`                | Confirmation status for a hash previously returned by broadcast_tx (or any hash): confirmed / pending / failed / not-found.                                                                              |
| `signing_guide`            | Signing starts with "do you have the key?" Step 1 key recovery (complete BIP39, missing word, passphrase, keystore v3, 2014-15 Ethereum presale, Electrum, wallet.dat, blockchain.info, hardware, raw…   |
| `recovery_guide`           | Step 1 of signing_guide, also callable alone.                                                                                                                                                            |
| `read_chain`               | Generic read-only chain reader for every SwapChan chain.                                                                                                                                                 |
| `find_money_batch`         | Paste a list of PUBLIC addresses (any mix: EVM 0x…, ENS/Basenames, .sol, Solana, Tron, Bitcoin; commas/newlines/whatever) and SwapChan auto-detects each chain (EVM addresses are scanned on every EVM…  |
| `find_money_status`        | Poll a find_money_batch job: status (running/done), progress {done,total,percent}, running total, per-wallet results, ranked items, the verbatim 'summary' and the 'plan'.                               |
| `swapchan_playbook`        | Long-form guidance for agents: principles (trustless, human sign-off on every tx, verify before sign, confirm with read_chain, never touch seed phrases, always give short + full links), the full tool… |
| `address_tool`             | Work with public crypto addresses: op=detect (every chain/format an address fits; forks share version bytes, so expect several, e.g.                                                                     |
| `xpub_addresses`           | List public addresses from an extended PUBLIC key (xpub/ypub/zpub/tpub…): chain (e.g.                                                                                                                    |
| `solana_address`           | Solana address math: op=pda (program + seeds as hex strings → program-derived address and bump), ata (owner + mint [+ token_program] → associated token account), on_curve (address → is it an ed25519…  |
| `substrate_tool`           | Substrate helpers: op=ss58_decode (address → account public key hex + network prefix), ss58_encode (account hex + prefix → address), ss58_convert (address + prefix → same account under another…        |
| `hash_tool`                | Hashing and encoding of PUBLIC data: op=blake2b (hex data, out_len bytes 1-64, optional personal), twox128 (text, Substrate xxHash), base58_encode (hex data), base58_decode (base58 text; plain…        |
| `chain_params`             | Chain parameter table (reference data only; a listed chain is not a signing or recovery claim): Base58 version bytes, bech32 HRP and WIF byte for the Bitcoin-family ones…                 |
| `tron_tx`                  | Tron transaction inspection on UNSIGNED raw_data hex (tronweb raw_data_hex): op=decode (contracts, owner/to, amount_sun, TRC-20 call, ref block, expiry, fee limit, txid), txid (sha256 of raw_data).    |
| `multisig_address`         | Bitcoin m-of-n P2WSH multisig (wsh(multi(..)), unsorted) from compressed PUBLIC keys: threshold + pubkeys (hex, order is consensus-significant) + network (bitcoin default, testnet, signet, regtest).   |
| `taproot_multisig_address` | Bitcoin Taproot script-path m-of-n multisig: one CHECKSIGADD leaf under the BIP341 NUMS internal key (no key path), from x-only or compressed PUBLIC keys + threshold + network (bitcoin default…        |
| `combine_psbts`            | Merge cosigners' partially signed PSBTs (base64 or hex) for the same transaction and finalize once the threshold is met.                                                                                 |
| `build_plan_tx`            | Resolve a declarative blocktools Plan (JSON text) against a Context (JSON text: evm nonce, gas, max_fee_per_gas, priority_fee; utxo fee_rate) to UNSIGNED bytes: evm returns unsigned_tx (EIP-1559…      |
| `msg_verify`               | Check a PUBLIC message signature: EIP-191 personal_sign (0x address, 65-byte hex sig) or Bitcoin Core signmessage (P2PKH address, base64 sig).                                                           |
| `bolt11_decode`            | Decode a PUBLIC BOLT11 Lightning invoice (lnbc…): bech32 (BIP173) + tagged fields + the payee pubkey RECOVERED from the signature.                                                                       |
| `build_send_tx`            | Build an UNSIGNED transfer of a token or the native coin to any recipient — e.g.                                                                                                                         |
| `evm_abi`                  | Solidity ABI work on public data: op=encode (sig like transfer(address,uint256) + args as a JSON list → selector + calldata), decode (input hex + sig or abi → named args; with types like…              |
| `create_address`           | Predict a contract's deployment address: deployer + nonce (CREATE), or deployer (factory) + 32-byte salt + init_code or init_code_hash (CREATE2, EIP-1014).                                              |
| `bytecode_inspect`         | Classify contract runtime code (eth_getCode hex): EIP-1167 minimal proxy + implementation, EIP-7702 delegation + delegate, EOF, size vs the EIP-170 24576-byte limit, code keccak-256, Solidity…         |
| `typed_data_verify`        | Hash EIP-712 typed data (typed_data as JSON text, as passed to eth_signTypedData_v4): encoded type, domain separator, struct hash and digest.                                                            |
| `supported_chains`         | Chains the address tools know: name, ticker, title, SLIP-44, verified flag and the public explorer each was checked against (with date), plus library version.                                           |
| `contract_abi`             | Load an EVM contract's ABI like a block explorer's Contract tab: Sourcify first, then Etherscan (when configured), else pass abi.                                                                        |
| `contract_read`            | Call one view/pure function of an EVM contract via eth_call and return the ABI-decoded result.                                                                                                           |
| `contract_encode_call`     | Build the calldata for any function of an EVM contract (write functions included) and return it with the target, chain, value (payable functions only, in wei) and a decoded human-readable view, for…   |
| `contract_approve_call`    | Pre-signing verdict for one EVM contract call: builds the calldata, re-encodes it with the full ABI and exact signature, builds an unsigned tx (placeholder nonce and gas; the wallet sets the real…     |
| `contract_build_creation`  | Build an unsigned EVM contract creation from bytecode plus optional constructor ABI and args (blocktools buildEvmTransfer create).                                                                       |

### Networks

Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche, Linea, Scroll — plus Bitcoin, Solana, Tron, Litecoin, Dogecoin and Bitcoin Cash (15 networks). Same-chain and cross-chain. Litecoin, Dogecoin and Bitcoin Cash swap through THORChain only, in both directions. Payout and refund addresses are checked by blocktools. To send them you either get an unsigned PSBT (built and checked by blocktools: THORChain vault, exact amount, memo, change back to you, no RBF, fee cap) that you sign in your own wallet, or a THORChain deposit address with the exact amount, the required memo, the minimum and the expiry (not from an exchange: exchanges cannot add the memo). Progress is tracked read-only by txid.

### Open by design

SwapChan's MCP server is keyless on purpose. It's per-IP rate-limited, slippage-capped, and `build_swap_tx` only ever returns an **unsigned** transaction — the server has no keys, never signs, and never moves funds. Try it with zero setup.

---

## Develop

Monorepo (pnpm + turbo):

```
apps/api      Hono quote service (fan-out to providers, rank, build tx, status)
apps/web      Next.js App Router + wagmi/viem + Reown AppKit + Tailwind
apps/mcp      MCP server (get_quote etc.) on top of apps/api
packages/shared  zod types + HTTP contract (see packages/shared/README.md)
```

### Run

```sh
nvm use            # Node 24 LTS
corepack enable    # pnpm 10
pnpm install
cp .env.example .env   # fill keys
pnpm dev           # api :8787, web :3000, mcp :8788/mcp (anonymous in dev)
pnpm -F @swapchan/mcp e2e   # live MCP smoke against the running stack
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```
