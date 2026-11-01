# Recipes

**Front door:** `recipes/recover.sh FILE DEST [--chain C] [--goal addresses|balance|sweep]`. It classifies the
input, picks the reader, lists public addresses, checks balances and sweeps, with a typed code before
signing and another before broadcast. Exit codes: 0 done, 3 stopped on purpose (watch-only, or a chain without a
sweep here), 4 no funds, 1/2 error.

**Every example marked as tested runs in e2e** (`scripts/recipe-check.py`). It runs exactly as written, through
the real sealed agent boundary, on public dummy vectors, against a 127.0.0.1 mock chain, and fails on any secret in
stdout. Anything a recipe calls UNTESTED or NOT BUILT is exactly that.

**The sealed image has no shell.** It is `FROM scratch`: static tools and `sealed-run`. You can't
`docker run -it ... sh`. Run pipelines with `./blocktools run '<pipeline>'` (agent-safe, redacted output),
or `./blocktools reveal '<pipeline>'` (a human at a terminal types a code, and keys are shown). The grammar is
`tool args [< /in/file] | tool args | ...`. There are no `$VARS`, globs, `;`, `&&` or redirects except `<`. Files go
in `./in` (mounted read-only at `/in`), passwords in `./secrets` (at `/secrets`). Use `read-file a b` to
join a password file and a wallet. Network steps (`utxo-fetch`, `tx-broadcast`) and `recover.sh` run on the host
and see addresses and signed transactions only.

## By input
| You have | Recipe | Status |
|---|---|---|
| 12–24 word BIP39 phrase (typos ok) | [input-seed-phrase.md](input-seed-phrase.md) | built, tested |
| BIP39 phrase with one word missing (`?` or 11/14/17/20/23 words) | [offline-recovery-guide.md](offline-recovery-guide.md) | built, tested |
| Offline guide: seed/key → EVM, Tron, BTC, LTC, DOGE | [offline-recovery-guide.md](offline-recovery-guide.md) | built, tested |
| Electrum seed / wallet file (2.x+, and 1.x old 12-word seed) | [input-electrum.md](input-electrum.md) | built, tested; old seed btc only |
| Brainwallet phrase (brainwallet.org / bitaddress.org sha256, WarpWallet) | [input-brainwallet.md](input-brainwallet.md) | built, tested on public vectors |
| Which of my phrases is funded? (offline UTXO set from `dumptxoutset`: utxo-set, wallet-finder) | [goal-find-funded-phrase.md](goal-find-funded-phrase.md) | built, tested on a real Core 25.2 dump (regtest) |
| Bitcoin Core / old-client `wallet.dat` | [input-wallet-dat.md](input-wallet-dat.md) | built, tested; real altcoin-client file untested |
| Armory `.wallet` | [input-armory.md](input-armory.md) | built, tested on one public test wallet |
| MultiBit Classic `.key` | [input-multibit.md](input-multibit.md) | built, tested; MultiBit HD / bitcoinj `.wallet` built, tested on public test wallets |
| Raw key (hex, WIF, base58, base64) | [input-raw-key.md](input-raw-key.md) | built, tested |
| Ethereum keystore JSON | [input-keystore.md](input-keystore.md) | built, tested |
| xprv (BIP32 master key) | [input-xprv.md](input-xprv.md) | built, tested (xprv form only) |
| xpub / ypub / zpub / address (watch-only) | [input-xpub-address.md](input-xpub-address.md) | built, tested |
| XRP family seed (`s...`, `sEd...`) | [xrp.md](xrp.md) | built, tested |
| Algorand 25-word mnemonic | [chain-algorand.md](chain-algorand.md) | addresses only, tested |
| Stellar secret (`S...`) | [chain-stellar.md](chain-stellar.md) | addresses only, tested |
| Monero 25 words | [monero.md](monero.md) | keys/address; scan + sweep via host `xmr-wallet` (stagenet-tested) |
| Don't know | [input-unknown.md](input-unknown.md) | classify |

## By chain
| Chain | Addresses | Balance | Sweep | Recipe |
|---|---|---|---|---|
| Bitcoin | ✅ | ✅ | ✅ | [chain-bitcoin.md](chain-bitcoin.md) |
| Litecoin, Dogecoin | ✅ | ✅ | ✅ (mock chain only) | [chain-litecoin-dogecoin.md](chain-litecoin-dogecoin.md) |
| Groestlcoin | ✅ (incl. Groestl-checksum xpub, grs1p; real-wallet xpub untested) | ✗ | ✅ (e2e, no live network; p2tr spend refused) | [chain-groestlcoin.md](chain-groestlcoin.md) |
| Ethereum / EVM | ✅ | ✅ | ✅ ETH, ERC-20 | [chain-ethereum.md](chain-ethereum.md) |
| XRP | ✅ | manual | ✅ Payment (xrp-tx) | [xrp.md](xrp.md) |
| Qtum | ✅ | ✗ | ✅ offline build (P2PKH; format checked on 5 mainnet txs; no live network) | [chain-qtum.md](chain-qtum.md) |
| Old coins (PPC, NMC, FTC, NVC, CLAM, BLK, RDD, XPM, QRK, ...) | ✅ | ✗ | ✅ offline build (PoS nTime for PPC/NVC/CLAM/RDD; QRK format unverified; e2e, no live network) | [chain-old-coins.md](chain-old-coins.md) |
| Zcash transparent (t1) | ✅ (t1 via zec-sapling --unified only) | ✗ | ✅ offline v5 build (e2e, no live network) | [chain-zcash-transparent.md](chain-zcash-transparent.md) |
| Tron | ✅ | ✗ | ✗ | [chain-tron.md](chain-tron.md) |
| Solana | ✅ | ✗ | ✗ | [chain-solana.md](chain-solana.md) |
| Cosmos Hub | ✅ | ✅ utxo-fetch (host-side, manual) | ✅ MsgSend (acct-tx, TTY confirm) | [chain-cosmos.md](chain-cosmos.md) |
| THORChain (RUNE) | ✅ thor1 | ✅ rpc (host-side) | ✅ MsgDeposit (acct-tx, TTY confirm) | [chain-thorchain.md](chain-thorchain.md) |
| Algorand | ✅ (own mnemonic) | ✅ utxo-fetch (host-side, manual) | ✅ pay / close-to (acct-tx, TTY confirm) | [chain-algorand.md](chain-algorand.md) |
| Cardano | ✅ (Shelley base, Icarus) | ✅ utxo-fetch (Koios, host-side) | ✅ ADA-only payment/sweep (acct-tx, TTY confirm) | [chain-cardano.md](chain-cardano.md) |
| Zcash shielded (Sapling, unified u1) | ✅ (address + Sapling viewing key) | ✗ | ✗ | [zcash-shielded.md](zcash-shielded.md) |
| TON | ✅ (wallet v4r2) | ✅ utxo-fetch (host-side, manual) | ✅ v4r2 transfer/sweep (acct-tx, TTY confirm) | [chain-ton.md](chain-ton.md) |
| Polkadot | ✅ (root sr25519) | ✅ utxo-fetch (Asset Hub RPC, host-side) | ⚠️ UNVERIFIED Asset Hub transfer/sweep (acct-tx, TTY confirm) | [chain-polkadot.md](chain-polkadot.md) |
| Stellar | ✅ | ✅ utxo-fetch (host-side, manual) | ✅ Payment / AccountMerge (acct-tx, TTY confirm) | [chain-stellar.md](chain-stellar.md) |
| Monero | ✅ | ✅ xmr-wallet scan (stagenet) | ✅ xmr-wallet sweep (stagenet, TTY confirm) | [monero.md](monero.md) |

## EVM contracts (any EVM chain)

| Goal | Recipe | Status |
|---|---|---|
| Index of the short EVM contract recipes below | [evm-contract-data.md](evm-contract-data.md) | index |
| Decode a transaction's calldata; encode calldata (`abi-decode`, `abi-encode`) | [evm-decode-calldata.md](evm-decode-calldata.md) | offline examples run in CI |
| Look up an unknown selector (`sig-hash --lookup`, your own candidate list) | [evm-unknown-selector.md](evm-unknown-selector.md) | offline examples run in CI |
| Decode event logs (`abi-decode`, `log-decode`) | [evm-decode-logs.md](evm-decode-logs.md) | offline examples run in CI |
| Decode a revert: `Error(string)`, `Panic`, custom errors | [evm-decode-revert.md](evm-decode-revert.md) | offline examples run in CI |
| Run an `eth_call` and decode the return; state overrides, traces (`contract-call`, `contract-trace`) | [evm-eth-call.md](evm-eth-call.md) | run in CI against a mock RPC only |
| Compute a CREATE or CREATE2 address (`create-address`) | [evm-contract-address.md](evm-contract-address.md) | offline examples run in CI |
| Inspect a deployed contract: code, ABI, selectors, offline source/metadata check | [evm-inspect-contract.md](evm-inspect-contract.md) | offline examples run in CI |
| Check an EIP-712 signature and digest (`typed-data-verify`) | [evm-eip712-verify.md](evm-eip712-verify.md) | offline examples run in CI |
| Check an ERC-20 approve or EIP-2612 permit before signing | [evm-check-approval.md](evm-check-approval.md) | offline examples run in CI on constructed data; automatic unlimited-approval flagging NOT BUILT |
| Decode a multicall or a Universal Router `execute` (nested calls) | [evm-decode-multicall.md](evm-decode-multicall.md) | run in CI; naming router commands / v4 actions NOT BUILT |
| Tx hash → decoded call, logs and revert, end to end | [evm-tx-end-to-end.md](evm-tx-end-to-end.md) | run in CI against a mock RPC; live node untested; tracing a mined tx NOT BUILT |
| What a Permit2 signing request commits to, verified offline | [evm-permit2-signing-request.md](evm-permit2-signing-request.md) | run in CI on a real mainnet permit |
| Check an EIP-1167 proxy or EIP-7702 delegation before interacting (`bytecode-inspect`) | [evm-check-proxy-delegation.md](evm-check-proxy-delegation.md) | run in CI; storage-slot proxies NOT BUILT |
| Build, verify, sign and broadcast a contract call or a deployment (`tx-build --data/--create` → `tx-verify` → `tx-sign`) | [evm-contract-tx.md](evm-contract-tx.md) | build, verify, sign and broadcast covered by e2e against a mock that does not execute the EVM; the real-geth devnet script is untested |

## Cross-chain swaps (THORChain)

| Goal | Recipe | Status |
|---|---|---|
| Register / manage an affiliate THORName | [thorchain-thorname.md](thorchain-thorname.md) | built, tested; measured on mainnet |
| Swap an EVM token into another chain (router depositWithExpiry) | [thorchain-swap-evm.md](thorchain-swap-evm.md) | built (shipped EVM tx tools + allow_calls); measured on mainnet |
| Swap a UTXO coin (DOGE/LTC/BCH/BTC) into another chain (OP_RETURN memo) | [thorchain-swap-utxo.md](thorchain-swap-utxo.md) | built (shipped `tx-build --memo` + `tx-sign --expect-memo` exact-memo OP_RETURN accept); e2e + regtest; measured on mainnet |

## By goal
| Goal | Recipe |
|---|---|
| Find which derivation path a wallet used | [derive.md](derive.md) |
| Check whether anything is left | [goal-check-balance.md](goal-check-balance.md) |
| Move everything to a new address | [goal-sweep.md](goal-sweep.md) |
| Read a transaction before signing/sending | [decode-a-transaction.md](decode-a-transaction.md) |
| Fetch a tx from your bitcoind and decode it, fee included (`rpc \| tx-decode`) | [rpc-decode.md](rpc-decode.md) |
| m-of-n multisig: build, carry into a Plan, each cosigner partial-signs, combine (P2WSH and Taproot script-path) | [multisig.md](multisig.md) |
| Inspect a BOLT11 Lightning invoice (decode fields + recovered payee, re-encode) | [bolt11.md](bolt11.md) |

Fee warnings (`high_fee`, `high_fee_rate`) use per-coin limits from measured mainnet fee rates (docs/CHAINS.md "Fee-warning limits").
| Verify, and sign on an offline machine | [goal-verify-and-offline.md](goal-verify-and-offline.md) |

Zcash transparent (t1/t3) is a supported chain for validate/convert/sweep; shielded: [zcash-shielded.md](zcash-shielded.md).

Worldcoin (wdc) txs decode as Bitcoin-legacy (mainnet-checked) but wdc remains unverified: no SLIP-44 path. Quark (qrk) txs are Bitcoin-legacy (10 mainnet txids, 10 signatures checked) with 5 decimals; sweep build is supported (untested on mainnet).

## recover.sh: classify type -> route

| classify | route | tested example |
|---|---|---|
| mnemonic, electrum_seed, electrum_old_seed | seed-repair / seed-to-master -> derive --chain C | input-seed-phrase.md, input-electrum.md |
| wif, hex_key, b58_key, b64_key | key-to-addresses --chain C | input-raw-key.md, chain-*.md |
| xprv | sed-wrapped -> derive --chain C | input-xprv.md |
| xpub, address | watch-only: xpub-addresses / address (balance, no sweep) | input-xpub-address.md |
| wallet_dat | dat-read -> derive | input-wallet-dat.md |
| electrum_wallet | electrum-read (-> seed-to-master -> derive) | input-electrum.md |
| electrum_wallet_file_encrypted | electrum-read (decrypts BIE1; BIE2 refused) | input-electrum.md |
| multibit_key | multibit-read -> key-to-addresses | input-multibit.md |
| bitcoinj_wallet | multibit-read -> key-to-addresses (or derive m/0'/c/i for an HD seed) | input-multibit.md |
| armory_wallet | armory-read -> key-to-addresses | input-armory.md |
| keystore_v3 | keystore-open (eth) | input-keystore.md |
| eth_presale | keystore-open (eth) | input-keystore.md |
| monero_seed | xmr-keys address, exit 3 -> xmr-wallet (host) | monero.md |
| monero_address | exit 3 (needs the view key) | monero.md |
| xrp_seed | xrp-tx keys, exit 3 -> xrp-tx build/sign | xrp.md |
| ton_mnemonic, algo_mnemonic, xlm_seed | address, exit 3 -> acct-tx build/sign | chain-ton/algorand/stellar.md |
| (Signum/Burst passphrase) | `recover.sh --chain signum`: signum-account -> S- address, exit 3 (sweep in Signum XT wallet) | chain-old-coins.md |
| unknown | exit 3 | input-unknown.md |

Sweep is automated for btc/ltc/doge/eth. For any other `--chain`, recover.sh prints the addresses, exits 3 and names
the builder (acct-tx, xrp-tx, or tx-build from a UTXO list) and the recipe.


Legacy (non-segwit) inputs: UTXO lists need `prev_tx` (utxo-fetch adds it; recipe fixtures are synthetic). See docs/SECURITY.md.
