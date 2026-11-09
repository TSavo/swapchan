# Cookbook (by wallet type and chain)

This index points at the executable recipes. Every **tested** example in those files
is run verbatim by `scripts/recipe-check.py` in e2e. Prefer the recipe over copying
snippets from chat logs.

## By wallet / input type

| You have | Go to |
|---|---|
| BIP39 seed (typos / missing word) | [recipes/input-seed-phrase.md](../recipes/input-seed-phrase.md), [recipes/offline-recovery-guide.md](../recipes/offline-recovery-guide.md) |
| Electrum seed or wallet | [recipes/input-electrum.md](../recipes/input-electrum.md) |
| Bitcoin Core `wallet.dat` | [recipes/input-wallet-dat.md](../recipes/input-wallet-dat.md) |
| Armory | [recipes/input-armory.md](../recipes/input-armory.md) |
| MultiBit / bitcoinj | [recipes/input-multibit.md](../recipes/input-multibit.md) |
| Raw hex / WIF | [recipes/input-raw-key.md](../recipes/input-raw-key.md) |
| Ethereum keystore | [recipes/input-keystore.md](../recipes/input-keystore.md) |
| xprv / xpub / address | [recipes/input-xprv.md](../recipes/input-xprv.md), [recipes/input-xpub-address.md](../recipes/input-xpub-address.md) |
| BIP38 / Blockchain.com | tools `bip38-open`, `blockchain-read` + classify; see ROADMAP-PARITY |
| Password candidate lists | `pw-candidates` piped into openers |
| Unknown file | [recipes/input-unknown.md](../recipes/input-unknown.md) → `classify` |

## By chain

See the chain table in [recipes/README.md](../recipes/README.md) and [CHAINS.md](CHAINS.md).
Account-model chains (XLM, ALGO, ATOM, ADA, DOT, TON, RUNE) use `acct-tx`; XRP uses `xrp-tx`; Monero uses `xmr-keys` / `xmr-wallet`.
The parent `tx-build` and `tx-sign` verbs also accept `--chain` to hand off to those account/XRP backends.
Solana/Tron use `tx-build --chain sol|tron` and `tx-verify --chain sol|tron` (or `sol-tron-tx` directly),
not `tx-sign` or `tx-broadcast`. See [VERB-CHAIN.md](VERB-CHAIN.md) for backend flags and unsupported steps;
these CLI hand-offs do not add wasm exports.

## By goal

| Goal | Recipe |
|---|---|
| Make a new wallet | [recipes/goal-make-a-wallet.md](../recipes/goal-make-a-wallet.md), `new-seed` |
| List addresses | `--goal addresses` via [recover.sh](../recipes/recover.sh) |
| Check balance | [recipes/goal-check-balance.md](../recipes/goal-check-balance.md) |
| Sweep | [recipes/goal-sweep.md](../recipes/goal-sweep.md) |
| Decode before sign | [recipes/decode-a-transaction.md](../recipes/decode-a-transaction.md) |
| Offline verify + sign | [recipes/goal-verify-and-offline.md](../recipes/goal-verify-and-offline.md) |

## Contract data (EVM, offline filters)

| Goal | Recipe |
|---|---|
| Unknown selector → signature (from a file you supply) | [recipes/evm-unknown-selector.md](../recipes/evm-unknown-selector.md), `sig-hash` |
| Transaction input → arguments (`jq` + signature) | [recipes/evm-decode-calldata.md](../recipes/evm-decode-calldata.md), `abi-decode` |
| `eth_getLogs` events → decoded fields | [recipes/evm-decode-logs.md](../recipes/evm-decode-logs.md), `abi-decode` |
| `eth_call` return data (e.g. `balanceOf`) | [recipes/evm-eth-call.md](../recipes/evm-eth-call.md), `abi-decode` |
| Revert data: `Error(string)`, `Panic`, custom errors | [recipes/evm-decode-revert.md](../recipes/evm-decode-revert.md), `abi-decode` |
| Arguments → calldata (`eth_call`/tx `data`), or a bare tuple (CREATE2 salt preimage) | [recipes/evm-decode-calldata.md](../recipes/evm-decode-calldata.md), `abi-encode` |
| Deployment tx → contract address (CREATE, from + nonce) | [recipes/evm-contract-address.md](../recipes/evm-contract-address.md), `create-address` |
| Factory + salt + init-code hash → CREATE2 address (e.g. a Uniswap V3 pool) | [recipes/evm-contract-address.md](../recipes/evm-contract-address.md), `abi-encode`, `sig-hash --keccak`, `create-address` |
| ABI → selectors, collisions, ERC-165/ERC-20 interfaces | [recipes/evm-inspect-contract.md](../recipes/evm-inspect-contract.md), `abi-inspect` |
| `eth_getCode` → proxy / delegation / EOF, compiler version, size limit, selector candidates | [recipes/evm-inspect-contract.md](../recipes/evm-inspect-contract.md), [recipes/evm-check-proxy-delegation.md](../recipes/evm-check-proxy-delegation.md), `bytecode-inspect` |
| `eth_signTypedData_v4` request or signed typed data → digest, recovered signer, verdict | [recipes/evm-eip712-verify.md](../recipes/evm-eip712-verify.md), `typed-data-verify` |
| ERC-20 approve / EIP-2612 permit: spender, amount, unlimited flag (jq), permit digest | [recipes/evm-check-approval.md](../recipes/evm-check-approval.md), `abi-decode`, `typed-data-verify` |
| Multicall / Universal Router `execute` → nested inner calls | [recipes/evm-decode-multicall.md](../recipes/evm-decode-multicall.md), `abi-decode` |
| Tx hash → decoded input, receipt logs, revert | [recipes/evm-tx-end-to-end.md](../recipes/evm-tx-end-to-end.md), `abi-decode`, `log-decode` |
| Permit2 signing request → what it commits to, recovered signer | [recipes/evm-permit2-signing-request.md](../recipes/evm-permit2-signing-request.md), `typed-data-verify` |
| Contract call tx: signature + args → calldata → unsigned tx → decoded re-verify → sign → broadcast (any chain id) | [recipes/evm-contract-tx.md](../recipes/evm-contract-tx.md), `abi-encode`, `tx-build --data`, `tx-verify --call`, `tx-sign --call` |
| Contract creation tx: init code → unsigned tx → approve by init-code hash → sign (shows new address) | [recipes/evm-contract-tx.md](../recipes/evm-contract-tx.md), `tx-build --create`, `--create-hash` |
| Solana or Tron transfer: build unsigned from a plan, decode, verify (chain auto-detected, `--chain` overrides) | `sol-tron-tx` |
| Prove control of an address: sign or verify a text message (Bitcoin `signmessage` P2PKH, Ethereum `personal_sign`, Tron signMessageV2, Solana raw/offchain-v0, Cosmos ADR-036; chain detected from the address) | `msg-sign`, `msg-verify` |
| Build or strictly check a Sign-In with Ethereum (EIP-4361) message (domain, nonce, expiry checks opt-in; signature via `msg-verify`) | `siwe` |
| Declarative transaction Plan (RFC #15): build steps, resolve to unsigned bytes, check against assertions (EVM/UTXO/Account) | `tx-plan` |
| m-of-n multisig (Bitcoin P2WSH): build the witness script + address, carry it into a Plan, each cosigner partial-signs, combine to a signed tx | [recipes/multisig.md](../recipes/multisig.md), `multisig`, `tx-plan input --witness-script`, `tx-sign --partial`, `tx-combine` |
| m-of-n multisig (Taproot script path): build a CHECKSIGADD tapleaf + P2TR address under the NUMS key, carry it into a Plan, each cosigner Schnorr-partial-signs, combine to a signed tx | [recipes/multisig.md](../recipes/multisig.md), `taproot-multisig`, `tx-plan input --tap-leaf-script`, `tx-sign --partial`, `tx-combine` |
| Inspect a BOLT11 Lightning invoice: decode the amount, tagged fields and recovered payee pubkey, and re-encode it byte-identically | [recipes/bolt11.md](../recipes/bolt11.md), `bolt11` (decode-only; no channel protocol, no signing) |
