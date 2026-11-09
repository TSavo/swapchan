# Changelog

All notable changes to blocktools. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/). Every entry names the commit(s) it comes from.
Numbers and security statements here are only those registered as measured in docs/claims.toml
(claim id in brackets); anything not measured is under "Known limitations" in plain words.

## [Unreleased]

## [0.5.0] - 2026-11-08

Minor release. Highlights:
- wasm `tronVerifyTx` and 77 exports (was 76) [wasm-export-count], measured at 1572c714.
- Kusama (`ksm`) and Polymesh (`polyx`) emit a Trust Wallet Core ed25519 row alongside the existing substrate sr25519 row; `dot` stays sr25519-only.
- `tx-build`, `tx-sign`, and `tx-verify` take `--chain` and exec the existing backends (fail closed where signing or verify is unavailable).
- Permit spender checks and Seaport order checks on `typed-data-verify` and the wasm `evmTypedDataVerify`.
- **Behaviour change:** `rpc --allow-wallet-sign` refuses unasserted permits and Seaport orders.
- BitConnect (`bcc`) archival evidence is preserved; `verified` stays false and signing is not enabled.

### Added
- Kusama (`ksm`) and Polymesh (`polyx`) emit a Trust Wallet Core ed25519 row (kind `ed25519`) alongside the existing substrate sr25519 row. `key-to-addresses` treats a 32-byte seed as TWC does (tests/chains/{Kusama,Polymesh} FromPrivateKey and CoinAddressDerivationTests.cpp dummy key 0x46×32 at adf80f8). `derive --chain ksm|polyx` (presets `common`, `exhaustive`, `recovery`) walks registry paths `m/44'/434'/0'/0'/0'` and `m/44'/595'/0'/0'/0'` via SLIP-10. Existing sr25519 / subkey addresses are unchanged; `dot` is still sr25519-only.
- wasm `tronVerifyTx(hex, expectJson)` — the existing `tron::verify_tx` policy (`sol-tron-tx verify --chain tron`). `decodeTx`/`verifyTx` with chain `tron` now route to `tronDecodeTx` / refuse with `tron_use_tronVerifyTx` (same pattern as Solana). 77 exports [wasm-export-count], measured at 1572c714.
- BitConnect (`bcc`) archival verification of the existing unverified Bitcoin-style fork row (7355ff22, docs/BITCONNECT-VERIFICATION.md). Public mainnet evidence is checked in; `verified` stays false; auto-detect still excludes BCC; `tx-build --chain bcc` still exits 2 (`unverified chain parameters: not supported`). The tests do not add `bcc` to the decoder layout table, POS_SWEEP allowlist, or signer. Signing is not enabled.

### Fixed
- `key-to-addresses` treated an all-digit 64-hex key as a JSON number and silently skipped it (no `unsupported` line). Only JSON objects are read as `{key|wif|private_key}` now, matching `keys::parse_key_line`.
- `tx-build`, `tx-sign`, and `tx-verify` take `--chain sol|tron|xrp|xlm|algo|atom|ton|ada|dot|rune` and exec the existing backend (`sol-tron-tx`, `xrp-tx`, `acct-tx`) from the same directory (`blocktools_io::sibling_exit`). `tx-sign --chain sol|tron` fails closed (`signing_not_available`; those backends take no keys). `--chain xmr` fails closed (`xmr_requires_wallet_rpc`; signing stays on host `xmr-wallet`, never pulled into the sealed image). `--chain zec` is unchanged (transparent v5); `zec-sapling` is address derivation, not a tx backend. `tx-verify --chain sol|tron` execs `sol-tron-tx verify`; other delegated chains without a verify backend fail `verify_not_available`. `tx-broadcast` refuses those chains (`broadcast_not_available`). Coverage is listed in `docs/VERB-CHAIN.md` and checked by `scripts/verb-chain-check.py` and `scripts/e2e.d/verb-chain.sh`. No wasm export added.
- Spender checks for signed permits (EIP-712 typed data), shared by `typed-data-verify` and the wasm
  `evmTypedDataVerify` (`permit::apply`): EIP-2612, DAI and Permit2 `PermitSingle`, `PermitBatch`,
  `PermitTransferFrom`, `PermitBatchTransferFrom`, recognised by primaryType and exact field set. New output
  `permit`, `unlimited_approval`, `spender_unasserted`, `permit_findings`, and `unrecognised_spender_fields` for other
  shapes. New opt-in `--expect-spender`, `--expect-amount`, `--expect-unlimited` / options `expect_spender`,
  `expect_amount`, `expect_unlimited`: status `spender_not_expected`, `amount_not_expected`, `unlimited_approval`,
  `spender_not_checkable`, `amount_not_checkable` (exit 1). An exact-balance drainer permit (below 2^128) is caught
  by the spender. Without assertions the status is unchanged (advisory fields only). No wasm export added.
- Seaport order check (`seaport::apply`, shared by `typed-data-verify` and the wasm `evmTypedDataVerify`):
  `OrderComponents` and `BulkOrder` for Seaport 1.5 and 1.6 at their canonical addresses (ProjectOpenSea/seaport
  README). New output `seaport` (offer, consideration to the offerer, consideration to others, received per currency,
  with the smaller of start/end amounts) and advisory `seaport_findings` (zone, zoneHash, conduitKey, restricted or
  contract order type, criteria items, NFT consideration, far-future endTime, consideration to others). Statuses
  `seaport_no_consideration`, `seaport_unknown_deployment`, `seaport_not_checkable` and, with the new
  `--expect-min-consideration SPEC` / option `expect_min_consideration` (`N`, `native:N`, `0xTOKEN:N`),
  `seaport_dust_consideration` (exit 1). NFT-for-NFT swaps pass and are listed (`nft_consideration`). No wasm export
  added (seaport-order-check). `BulkOrder` is recognised at every official tree height 1..24 (seaport-js
  bulk-orders.ts, seaport-core Verifiers.sol), each by its exact `OrderComponents[2]…` type string; every leaf is
  checked, empty padding leaves are skipped, one drainer leaf fails the whole signature; other shapes stay
  `seaport_not_checkable`.

### Changed
- Restamped the claims parked after PR #90 (tronVerifyTx / TWC ksm-polyx ed25519) at green main 1572c714 (CI 42518495268): wasm-export-count, fee-cap-utxo-default, redact-512, msg-ambiguous-address, twc-cosmos-addresses, bch-cashaddr-destinations, twc-ed25519-aptos-sui-near, wasm-verifytx-approval-checks, wasm-typed-data-expect, permit-expect-spender, and seaport-order-check. CI logs and independent local test runs matched; no runtime or signing changes.
- docs/CHAINS.md: Solana wasm already has unsigned `solBuildTransfer`; removed the stale "No Solana builder yet" line.
- Restamped sealed image size [image-size-readme], Linux sealed-run [sealed-run-linux], and live Alpine 0.4.0-r0 install [alpine-apk-install-0.4.0] from Battleaxe measurements at 55d8cad1. Restamped evm-devnet-create-call and tx-sign-presign-checks from main CI run 42504158970.
- **Behaviour change:** `rpc --allow-wallet-sign` now refuses an `eth_signTypedData_v4` permit (EIP-2612, DAI, Permit2)
  unless `--expect-spender` matches (`wallet_sign_permit_unasserted`, `spender_not_expected`, `amount_not_expected`,
  `unlimited_approval` unless `--expect-unlimited`), and refuses typed data with spender-like address fields that is
  not a recognised permit (`wallet_sign_spender_unrecognised`). Nothing is sent when refused. `rpc` now depends on
  `blocktools-evm` (deps/rpc.allow: blocktools-evm, sha2, cpufeatures).
- **Behaviour change:** `rpc --allow-wallet-sign` now refuses an `eth_signTypedData_v4` Seaport order
  (`wallet_sign_seaport_unasserted`) unless `--allow-seaport-order` or `--expect-min-consideration SPEC` is given, and
  then still refuses `seaport_no_consideration`, `seaport_dust_consideration`, `seaport_unknown_deployment`,
  `seaport_not_checkable`. Nothing is sent when refused.
- `docs/COVERAGE.md` lists the `tx-build --chain` overlaps with `sol-tron-tx`, `xrp-tx`, and `acct-tx`.
- The sealed image Dockerfile copies `fixtures/evm-mainnet`, which `crates/tx/tests/evm_decode.rs` reads.
- The sealed image Dockerfile copies the `fixtures/` and `recipes/fixtures/` trees (`tools/rpc/tests/cli.rs` permit/seaport tests read `recipes/fixtures/evm`; copying subdirs one at a time kept breaking the image build).
- docs: the Mac-to-Battleaxe `/in` hand check is no longer described as empty (1572c714). With `BLOCKTOOLS_ALLOW_REMOTE=ssh`, `./in` is streamed via tar-over-`docker exec` (hand check 2026-11-08, not re-run in CI). The macos-remote-context-empty-in claim stays untested (cannot satisfy K-macos).

### Known limitations
- BitConnect (`bcc`) remains unverified: not a supported chain, auto-detect excludes it, and `tx-build --chain bcc` exits 2 (`unverified chain parameters: not supported`). Signing is not enabled.
- macos-sealed, recovery-real-lost-wallet, macos-remote-context-empty-in, and chains-fee-figures (still quoting the October sample) remain untested.
- image-size-readme, sealed-run-linux, and wrapper-remote-refusal are untested on this tree: the wrapper `BLOCKTOOLS_VERSION` bump to 0.5.0 changed a file they depend on. Last measurements were at 55d8cad1 (image-size and sealed-run) and f7b3937 (remote-refusal).

## [0.4.0] - 2026-11-02

Minor release, tagged v0.4.0 on 2026-11-03. Highlights:
- **Behaviour change:** `tx-sign` and the wasm `verifyTx` now refuse unlimited approvals, unasserted batch inner calls
  and Safe delegatecalls by default (see Changed).
- `msg-verify` and `msg-sign` support Tron signMessageV2, Solana (raw / offchain-v0) and Cosmos ADR-036.
- New `siwe` tool (EIP-4361).
- `abi-decode --allow-gaps` / `evmAbiDecode` `allow_gaps`.
- Fixed: Cosmos addresses that were also valid Solana keys were misdetected; they now give `ambiguous_address`
  unless the chain is named (new `msgVerifyOpts` key `"chain"`).
- 76 wasm exports (was 75; new `msgVerifyOpts`).

### Added
- New tool `siwe`: builds an EIP-4361 Sign-In with Ethereum message from JSON fields (`siwe build [--raw]`) and
  parses one strictly (`siwe parse`): only valid, canonical text is accepted, otherwise `refused` (exit 1). Opt-in
  checks `--domain`, `--nonce`, `--now RFC3339` / `--check-time` (`domain_mismatch`, `nonce_mismatch`, `expired`,
  `not_yet_valid`). No keys; the signature is not checked (use `msg-verify`). CLI only, no wasm export (76 exports,
  unchanged). Vectors: spruceid/siwe 911f6f2c, docs/PROVENANCE-siwe.md.
- `tx-verify` checks approvals and transfers in the calldata: `approve`, `increaseAllowance`, EIP-2612 and DAI
  `permit`, Permit2 `approve`/`permit`, `setApprovalForAll`, `transfer`, `transferFrom`, at top level and inside
  `multicall`, Multicall3 `aggregate*`, Universal Router `execute`, Safe `execTransaction` and Safe `multiSend`.
  New output keys `approvals`, `transfers`, `inner_calls`. An approval of 2^128 or more, or of all tokens, fails with
  `unlimited_approval`. New opt-in assertions `--expect-spender`, `--expect-amount`, `--expect-unlimited` (needs
  `--expect-spender`), `--expect-recipient`, `--expect-value`, `--allow-inner-call TO:SELECTOR`,
  `--allow-delegatecall TO`, failing with `spender_not_expected`, `amount_not_expected`, `recipient_not_expected`,
  `value_not_expected`, `inner_calls_not_asserted`, `delegatecall`. No blanket allow.
- `typed-data-verify` prints `verifying_contract` and takes `--expect-chain-id` / `--expect-verifying-contract`
  (status `chain_id_mismatch` / `verifying_contract_mismatch`, exit 1). The wasm `evmTypedDataVerify` output gains
  `verifying_contract`; no wasm export added or removed.
- The wasm `verifyTx` runs the same approval / transfer / batch checks as `tx-verify` (one shared function,
  `presign::apply`), deny by default with no options: `unlimited_approval`, `inner_calls_not_asserted`, `delegatecall`
  now fail in wasm as in the CLI, and the result gains `approvals`, `transfers`, `inner_calls`. The opt-ins are new
  `call_json` keys `expect_spender`, `expect_amount`, `expect_recipient`, `expect_value` (strings), `expect_unlimited`
  (bool), `allow_inner_call` (["TO:SELECTOR"]), `allow_delegatecall` (["TO"]); wrong types throw `<key>_must_be_*`.
  `evmTypedDataVerify` takes an optional 4th argument `options_json` `{expect_chain_id, expect_verifying_contract}`
  (strings; shared `eip712::apply_expect` with typed-data-verify). Behaviour change: a wasm `verifyTx` that passed an
  unlimited approval, an unasserted batch or a Safe delegatecall now fails. Table: EXPORTS.md.
- `msg-verify` checks Tron signMessageV2, Solana (`--format raw|offchain-v0`, required) and Cosmos ADR-036
  (`--pubkey`, required) message signatures, chain detected from the address; `--chain` gains `tron|sol|cosmos`.
  Options for another chain are refused. The wasm `msgVerify` gains Tron; new export `msgVerifyOpts(inputJson)`
  takes `format` / `pubkey` (76 exports, was 75). Vectors and sources: docs/PROVENANCE-msg.md.
- `msg-sign` signs Tron signMessageV2, Solana (`--format raw|offchain-v0`, required) and Cosmos ADR-036 messages,
  chain detected from the address; `--chain` gains `tron|sol|cosmos`. Same gate as Ethereum/Bitcoin: refusals
  (blind 32-byte hash, hex, transaction-looking text) before any key is read, the signature re-verified, then the
  message shown and a code typed on /dev/tty. Solana keys: 64-hex seed or a solana-keygen 64-byte JSON array (its
  public half must match). Output `{"chain","address","signature"}` plus `format` (sol) or `pub_key`+`hrp` (cosmos).
  CLI only: no wasm signing. Tron and Solana raw reproduce Trust Wallet Core's signatures byte for byte
  (scripts/e2e.d/msg-chains-sign.sh, msg-chains-sign-e2e); Solana offchain-v0 and Cosmos are round-trip only (UNTESTED).
- `scripts/recipe-check.py` runs a recipe `curl` example only in the exact shape `curl [opts] $ETH/... | filters`
  (shlex-parsed; `;`, `&&`, `||`, `$(`, backticks, other URLs refused), with a self-test in hygiene-check.
- `abi-decode --allow-gaps` (wasm `evmAbiDecode` request field `"allow_gaps": true`, must be a bool, else
  `allow_gaps_must_be_bool`): opt-in partial decode where a dynamic tail may start after its canonical position (e.g.
  one LI.FI `BridgeData` parameter out of longer calldata). Skipped bytes are reported as `gap_bytes` and never decoded;
  backwards/overlapping offsets, bounds, dirty padding and `trailing_data` are still refused. docs/ABI-STRICT.md.

### Changed
- Behaviour change: `tx-sign` now runs the same approval/transfer/inner-call checks as `tx-verify` (shared
  `presign::apply`) before it reads a key, and again on the signed bytes, deny by default. Batches (multicall,
  Multicall3, Safe MultiSend) and unlimited approvals that `tx-sign` signed before are now refused unless asserted with
  `--expect-spender ADDR --expect-unlimited`, `--allow-inner-call TO:SELECTOR` or `--allow-delegatecall TO`. The
  optional `--expect-amount`, `--expect-recipient` and `--expect-value` flags work as in `tx-verify`, also with `--plan`.
- `scripts/claims-check.py` K-ci: lists main push runs unfiltered and keeps completed+success runs client-side
  (the `status=success` listing had omitted a green run), with a self-test and a negative case.

### Fixed
- `msg-verify` / wasm `msgVerify`, `msgVerifyOpts`: a Cosmos address with a 4-letter prefix that is also a valid
  32-byte on-curve Solana base58 key (e.g. `osmo148yundzwcr97np3s8c8yrx2p6p33ck6sd4stfm`) was detected as Solana,
  so `--pubkey` was refused with `pubkey_only_for_cosmos`. Such strings are now refused with `ambiguous_address`
  unless the chain is named: `--chain cosmos|sol`, or the new `msgVerifyOpts` key `"chain"` (JSON string). A wrong
  named chain is refused with `chain_does_not_match_address` (msg-ambiguous-address).

### Known limitations
- `siwe`: UNTESTED on messages from real wallets or dapps beyond spruceid's published vectors; no wasm export.
- Message verify: Cosmos ADR-036 signatures and real `solana sign-offchain-message` signatures are UNTESTED
  against wallet output (self round-trip and byte layout only), for msg-sign as well as msg-verify.
- Universal Router command bytes are surfaced, not named or decoded. ERC-721 `approve` shares the
  ERC-20 selector, so a token id of 2^128 or more is reported as unlimited. UNTESTED on transactions from a live wallet.

## [0.3.3] - 2026-10-30

Patch release: no code change to any tool, wasm export or flag since v0.3.0. It makes the 0.3.x
apt/apk/rpm repository signing work on the release signer's engine. Version 0.3.3 in every Cargo.toml,
internal pin, the wasm package, lockfiles and man pages (version-check) (this release).

### Fixed
- The `repos` release job (signed apt/apk/rpm repositories) never completed for 0.3.0–0.3.2: the host
  signing scripts bind-mounted the private key and the package inputs into their one-shot signing
  containers with `docker run -v`, but the release signer's engine is Docker Desktop on Windows, which
  cannot bind-mount the WSL2 host paths — they arrive as empty directories, so the key, the signer and
  the packages were all absent inside the container (the apk step failed with `python3: can't find
  '__main__' module in '/sign.py'`). Rewrite the signing and verify helpers to use **no host bind
  mounts**: the private key is streamed into a container tmpfs over `docker exec` stdin (RAM only, never
  a volume or the container's on-disk layer), public inputs go in with `docker cp`, and signed outputs
  come back with `docker cp`; verify containers are created, filled with `docker cp`, then started.
  `scripts/apk-sign-host.sh`, `scripts/apk-repo-build.sh`, `scripts/rpm-sign-host.sh`,
  `scripts/apk-verify.sh`, `scripts/rpm-verify.sh`. `scripts/apt-sign-host.sh` already signs on the host
  (no container) and is unchanged. Verified end to end on the real engine: all four signers produce
  signed, independently re-verified apt/apk/rpm repositories.

## [0.3.2] - 2026-10-30

Patch release (supersedes the un-shipped 0.3.1, whose repos publish wedged): no code change to any tool, wasm export or flag since v0.3.0. It exists so the 0.3.x
apt/apk/rpm repositories get published. Version 0.3.2 in every Cargo.toml, internal pin, the wasm package,
lockfiles and man pages (version-check) (this release).

### Fixed
- The v0.3.0 release `repos` job failed (release run 40848964388) with `release-repos: bolt11 ships in the
  tarball but is not in package-native.sh CLIS`: `scripts/package-native.sh` CLIS lacked the four tools new in
  0.3.0 (`multisig`, `tx-combine`, `taproot-multisig`, `bolt11`), so v0.3.0 shipped no apt, apk or rpm
  repositories. CLIS now lists them (6e6aa83).
- That guard only ran at release time, after the GitHub release was already published. It now lives in one
  script, `scripts/clis-check.sh`, which `release-repos.sh` calls on the release tarball and the gate's lint
  stage calls on every push, on the tarball `scripts/package-dist.sh` builds; a tool shipped in the tarball but
  missing from CLIS now fails CI, not the release. Negative test `R-clis` drops `bolt11` from CLIS and requires
  the check to fail with that tool's name (cfd9821).

### Known limitations
- The v0.3.0 GitHub release has only the linux-x86_64 tarball and SHA256SUMS, with no apt, apk or rpm
  repositories; it is left as published. v0.3.1 is the first 0.3.x release with those repositories.
- The new CI check is proven on the Linux gate; the signed repo build itself is only exercised by the release
  workflow on a tag.

## [0.3.0] - 2026-10-29

Version 0.3.0 in every Cargo.toml, internal pin, the wasm package, lockfiles and man pages (version-check) (9865ebc).
Minor version: new tools (`multisig`, `tx-combine`, `taproot-multisig`, `bolt11`), new wasm exports and new
flags; no CLI flag, wasm export or tool was removed (checked against v0.2.0: the pinned wasm export list in
`scripts/wasm-check.sh` only gained names; no `tools/` crate was removed; no option was removed from any man
page). The one behaviour change that can affect existing scripts is under "Changed".

This release closes the signing gap left by v0.2.0: blocktools could *build* an m-of-n transaction but not
*sign* one. It now partial-signs and combines m-of-n across Bitcoin (P2WSH), Taproot (script-path) and Cosmos —
plus offline BOLT11 — through the same declarative Plan, interoperable with external signers because the UTXO
carrier is standard BIP174 PSBT.

### Added
- m-of-n multisig on Bitcoin (P2WSH), end to end through the Plan (#25, c3762e3). New `multisig M --pubkey HEX…`
  tool → `{witness_script, P2WSH address, wsh(multi(…)) descriptor}` (offline, keyless, pubkey order preserved).
  UTXO inputs carry a `witness_script` (`crates/tx/src/build.rs`, validated: sha256 == the P2WSH program or a
  P2SH-P2WSH redeem; a bare `OP_CHECKMULTISIG` P2SH redeem accepted). New `crates/tx/src/multisig.rs`:
  `multisig_script`/`p2wsh_address`/`parse_multisig`; `partial_sign` records each held key's ECDSA signature
  over the BIP143 sighash (`script_code` = witness_script) in PSBT `partial_sigs` and never finalizes;
  `combine_finalize` assembles `<OP_0> <sig>… <witnessScript>` in pubkey order once ≥ threshold and fails closed
  (`not_enough_signatures`) below it. New `tx-sign --partial` (adds this cosigner's signature and prints the
  still-unfinalized PSBT — no finalize, no signed tx — with the plan/policy guard running first) and new
  `tx-combine` host tool (merges the cosigners' partial PSBTs, finalizes once the threshold is met). `tx-plan
  input --witness-script HEX` threads it through `resolve`/`represent` (the round-trip law holds). e2e
  `scripts/e2e.d/multisig.sh`: a full 3-of-5 P2WSH round-trip with no network, plus sub-threshold / non-cosigner
  / tampered-assertion refusals. Unit: a 2-of-3 round-trip with every signature verified against the P2WSH
  sighash (`crates/tx/src/multisig.rs` tests).
- Taproot script-path m-of-n (#26, cb72b03). New `taproot-multisig` tool: an `OP_CHECKSIGADD` k-of-n tapleaf
  (`<pk1> CHECKSIG <pk2> CHECKSIGADD … <m> NUMEQUAL`) committed under the BIP341 NUMS internal key, so the
  output is script-path only; prints the P2TR address, control block and merkle root (offline, keyless).
  `partial_sign` Schnorr-signs the BIP341 all-prevouts script-spend sighash into `tap_script_sigs`;
  `combine_finalize` assembles the witness `[sigN…sig1, leaf, control_block]` (reverse key order, empty push for
  a non-signer, exactly m sigs), fail-closed below threshold. An input carrying `tap_leaf_script` reconstructs
  the single-leaf NUMS spend info and fills the PSBT's `tap_internal_key`/`tap_merkle_root`/`tap_scripts`
  (validated: the leaf must reproduce the P2TR output key). `tx-sign --partial` and `tx-combine` run both the
  P2WSH (ECDSA) and taproot (Schnorr) routines, skipping inputs they do not own, so a mixed PSBT signs and
  finalizes fully. `tx-plan input --tap-leaf-script HEX`. e2e `scripts/e2e.d/taproot-multisig.sh`: a full 3-of-5
  script-path round-trip through the Plan with the sub-threshold / non-cosigner / tampered-assertion refusals.
- Cosmos legacy multisig (#27, c5a4b75, 8a29887). `LegacyAminoPubKey` (threshold + N child pubkeys) and N
  `SignerInfo`s with a `MultiSignature` bitarray in `crates/acct` (atom/thor), combined via the `acct-tx`
  partial-sign + combine path (SIGN_MODE_DIRECT; interop is a standard `TxRaw` + `MultiSignature`). e2e
  `scripts/e2e.d/cosmos-multisig.sh`: a 2-of-3 combine. 31 Cosmos single-signer MsgSend transaction vectors (10 from Trust Wallet Core's tests; Evmos and 20 more generated by running TWC adf80f8, not independent) pass, plus 2 refusal tests
  [twc-cosmos-vectors]; multisig addresses [twc-cosmos-addresses]. `acct-tx` message verify is shared
  [twc-message-vectors].
- BOLT11 offline Lightning invoice decode/encode (195ae8f, ab8c2c0). New `bolt11` tool: bech32 + tagged-field
  parse + secp256k1 payee-pubkey recovery, and byte-identical re-encode; a tampered checksum or signature is
  rejected. e2e `scripts/e2e.d/bolt11.sh` golden round-trip. The live channel protocol (commitments, HTLCs,
  routing) stays out of scope — blocktools is a constructor/signer, not a node.
- Keyless wasm exports `multisigAddress`, `taprootMultisigAddress`, `combinePsbts`, `txPlanResolve`, `msgVerify`
  (cbf9b22), and `bolt11Decode`, `bolt11Reencode` (this release). `bindings/wasm/test.mjs` asserts each equals
  the recorded CLI output (`crates/tx/tests/data/multisig-3of5.json`). Two new wasm guards: W-nokey (the wasm
  name section exposes no `partial_sign`/`SecretKey`/`Keypair`/`sign_ecdsa`/`sign_schnorr`) and W-nokeyapi (the
  `blocktools-tx` rustdoc built without the `secrets` feature mentions no `SecretKey`/`Keypair`), each with a
  gate-negatives plant (cbf9b22, 07a5023). EXPORTS.md and docs/EXPORTS-reference.md list every export. The
  export count (74) is measured from the wasm sources and `scripts/wasm-check.sh` [wasm-export-count], and the
  W-doccount gate replaces the hand-written count that used to live in EXPORTS.md (1eb275a, 0fa177c, 2a3f8e2).
- Shared library paths so the CLI and the wasm cannot diverge (633741b, 25314d7). `blocktools_tx::partial_sign`
  (ECDSA + Schnorr) and `message::verify` are behind the `secrets` feature; `combine_psbts` and
  `multisig::extract` are keyless, so the combiner and `msg-verify` need no signing feature. `crates/plan` gains
  `resolve_json` (Plan + Context → unsigned-bytes JSON); without the `account` feature (the wasm build)
  `blocktools-acct` and its ed25519 crates are not compiled and the Account family reports `family_not_built`.
- Mac → Battleaxe signing over SSH: `BLOCKTOOLS_ALLOW_REMOTE=ssh` permits only `ssh://` engines (tcp/http(s)
  still exit 4) (7dd387e).

### Changed
- `tx-plan` UTXO `check` now delegates to the signer's own `blocktools_tx::policy::check` on the decoded PSBT
  instead of `thor::verify_send` (#25, c3762e3). `verify_send` is THORChain-inbound-specific and demanded a
  memo, so it flagged a plain multisig spend the signer signs happily — check and sign diverged. Now pass-check
  ⟺ sign holds by construction for every UTXO shape (THORChain inbound, plain payment, or m-of-n P2WSH / taproot
  spend). The golden tamper tests assert the signer's codes (`unexpected_output` / `fee_above_cap`);
  `crates/plan/tests/utxo_golden.rs`.
- Wrapper: no host bind mounts (786344e, then 1846bef). `./in` and `./secrets` stream into the sealed container
  as tar over `docker exec` stdin into tmpfs (`/in`, `/secrets`; root 0700; files root-owned 0444 so uid 10001
  reads but cannot change them) — secrets never touch the engine's disk. This fixes empty inputs when the engine
  is Docker Desktop on Windows, which cannot see WSL2 bind paths. Sealed flags unchanged (`--network none`,
  `--read-only`, cap-drop ALL, no-new-privileges, uid 10001, `--log-driver none`); CLI unchanged. e2e
  `scripts/e2e.d/wrapper-seal.sh`, `scripts/e2e.d/wrapper-remote.sh`.
- The wasm bundle byte-size claims (`wasm-size`, `wasm-size-stripped`, `wasm-crates`) are dropped from
  `docs/claims.toml`; the module is described qualitatively in DESIGN.md (pointing at `scripts/wasm-size.sh` for
  a current figure) so no pinned byte count can drift, stale or need re-stamping (b8ead7f).

## [0.2.0] - 2026-10-28

Version 0.2.0 in every Cargo.toml, internal pin, the wasm package, lockfiles and man pages (version-check) (4212b19).
Minor version: new tools, new wasm exports and new flags; no CLI flag, wasm export or tool was removed
(checked against v0.1.1: the pinned wasm export list in scripts/wasm-check.sh only gained names; no
`tools/` crate was removed; no option was removed from any man page). Behaviour changes that can affect
existing scripts are listed under "Changed".

### Fixed
- `tx-sign --plan` / `tx-verify --plan` (UTXO): an unparsable `cap-fee` max was dropped for the chain's
  default cap; it now refuses with `cap_fee_unparsable`, and `utxo::check` reads the same `utxo::guards`
  mapping (u64 cap) so the two cannot diverge. A UTXO plan whose `chain` differs from the tx's chain is
  refused with `plan_chain_mismatch`. Docs no longer say UTXO check and sign are the same "by construction".

### Added
- THORChain UTXO inbound (swap from a UTXO coin): `tx-build --memo STRING` / `--op-return HEX` adds a
  zero-value trailing `OP_RETURN` to the UTXO build path (THORChain inbound shape `[vault, change,
  OP_RETURN memo]`; refused above the chain's relay limit — BCH 220, else 80 bytes;
  `blocktools_tx::build::op_return_script`), and `tx-sign`/`tx-verify` accept exactly one
  zero-value `OP_RETURN` as a non-destination memo only when `--expect-memo MEMO` (wasm `verifyTx`
  `expected_memo`) equals its payload byte-for-byte; without it, or on any mismatch, it is
  `unexpected_output`/`has_warnings` as before (deny by default; `Policy::expect_memo`,
  `crates/tx/src/policy.rs`, `crates/tx/tests/op_return_memo.rs`, `scripts/e2e.d/thorchain-utxo.sh`;
  the first version in 70a7406 accepted any single zero-value memo for every caller, changed before
  release); `tx-envelope verify_thor_send` checks the memo against its own `memo` field; `tx-sign` shows the memo (UTF-8 if printable, else hex) on the `/dev/tty`
  summary and keeps the typed-code confirmation. A second `OP_RETURN`, or a non-zero-value `OP_RETURN`,
  is still refused. Recipe `recipes/thorchain-swap-utxo.md`; `scripts/e2e.d/thorchain-utxo.sh` drives the
  shipped path node-free (build → `verify_thor_send` → pty sign → decode) with the two negative probes,
  and `scripts/e2e.d/memo-regtest.sh` runs it against the real LTC/DOGE/BCH regtest nodes.
- THORChain (`rune`) account support: `acct-tx keys|build|decode|sign --chain rune` signs a
  THORChain `MsgDeposit` (chain_id `thorchain-1`, SIGN_MODE_DIRECT, `/cosmos.crypto.secp256k1.PubKey`) —
  the transaction behind every THORChain swap-from-RUNE and THORName action; the action rides in the
  deposit memo, and the native fee (RfRune) is deducted by the chain (gas limit only, no fee coin).
  `crates/acct/src/thor.rs`. Unsigned = SignDoc, signed = TxRaw; `decode` verifies the signature and
  refuses a TxBody memo, a fee coin, extra coins or a signer that does not match the pubkey. KAT: body,
  auth_info and signed TxRaw byte-equal to the real mainnet `swapchan` THORName register/alias txs
  (`crates/acct/tests/thorchain.rs`); `scripts/e2e.d/thorchain.sh` drives keys/build/decode, the pty sign
  (wrong code aborts), and the `--expect-memo` guard. Recipes `recipes/chain-thorchain.md`,
  `recipes/thorchain-thorname.md`, `recipes/thorchain-swap-evm.md`; `rune` sign in `docs/CHAINS.md`.
- Contract tools. `log-decode` (offline event-log decoding) and `contract-call` (host tool: `eth_call`
  with return/revert decoding, `--read` state reads, chain id from the endpoint) (9bce34a).
  `contract-trace` (host tool: `eth_call` with checked state overrides, `debug_traceCall` passthrough as
  JSON lines behind `--allow-unlisted`) (12240d6). `bytecode-inspect --metadata/--sources`: offline
  Solidity metadata/source check against the CBOR trailer (035b24b; wasm lockfile follow-up f3c23ea).
- EVM contract call and creation end to end: `tx-build --data/--create`, `tx-verify`/`tx-sign
  --call/--abi/--create-hash` (strict decode shown in the summary, unknown selectors flagged), recipe
  `recipes/evm-contract-tx.md` (f2e066a); EVM API `approve_json`, `lift_approved`, encode from a JSON
  ABI by name (45b6741); `build_evm_transfer` data/create fields (b57df0c).
- wasm exports `evmApproveCall` and `verifyTx` call checking, `buildEvmTransfer` data/create (f90a6dd);
  `verifyThorSend`, and `tx-envelope` op `verify_thor_send` (80781bd). EXPORTS.md lists every export.
- `verifyThorSend` / `verify_thor_send`: fail-closed check of a THORChain inbound send on btc, ltc, doge
  and bch: exactly [vault == amount, optional change to the change address, OP_RETURN == memo bytes],
  non-RBF, fee within a cap, every input proven and owned by the taker address(es); named failure reasons
  (80781bd, 0e4a6ba).
- LTC/DOGE/BCH THORChain memo sends: per-chain dust and OP_RETURN limits in the memo PSBT builder (ca85a68);
  BCH vault CashAddr forms (446bd29); e2e `scripts/e2e.d/memo-regtest.sh` builds, signs and sends memo
  transactions to the pinned LTC, DOGE and BCH regtest nodes and checks the outputs on chain (39d6a01, 0e4a6ba).
- `utxo-set` and `wallet-finder`: Bitcoin Core `dumptxoutset` files (Core 25-27 and 28+ layouts) into an
  in-RAM exact set of funded scripts with a bloom filter in front; wallet-finder expands free text into
  candidate keys (7f1310b, f4bc4c2). Core 0.21-24 / Litecoin 0.21.x dumps, layout detected by
  trial-decoding and refused if ambiguous (fda3853, cd93cd8).
- Chainstate reading without `dumptxoutset`: pure-Rust read-only LevelDB reader for the `C` and old
  Dogecoin-era `c` layouts with obfuscation (71e61b5), Snappy, MANIFEST live set (046f360);
  `utxo-set --chainstate DIR` and `--write-dump OUT` (2bcc4d1); refuses a locked live directory and
  wrong era/key loudly (bf64dfd); standalone `chainstate-dump` tool (5b195d9), bounded open files
  (48affb6), `--hash-serialized` (48582cc).
- `rpc`: `rawtx`/`block`/`blockinfo`/`prevtxs` shortcuts (29cc5b1); `--timeout SECS` with a longer
  default for slow methods and a distinct `timeout` status (3c8c354); default timeout 30 s
  [rpc-timeout-30s].
- `tx-decode --prevtxs FILE` (offline prevout source) reports input values and fee (ea75965, 8a4fa78);
  recipe `recipes/rpc-decode.md` with a mock bitcoind (d502921, 21fb129).
- Real-node fork tests: `scripts/e2e.d/fork-regtest.sh` builds, verifies, signs and broadcasts sweeps on
  sha256-pinned regtest nodes for ltc, doge, bch (8ffa45b), dash, dgb, grs, btg (1805950), rvn (9516a6a),
  nmc and bsv (d1f4f93) [fork-regtest-ltc ... fork-regtest-bsv].
- Packaging: `gate.sh package` builds a release-layout tarball with SHA256SUMS and checks the binary
  architecture and a BIP84 vector through the unpacked tarball; CI packages on macOS arm64 and Linux
  aarch64 (006d03b) [package-macos-arm64, package-linux-aarch64]. These arm64 tarballs are CI artifacts
  only; the release workflow publishes Linux x86_64 (see Known limitations).
- Release repositories: `scripts/release-repos.sh` builds and signs the apk/apt/rpm repositories host-side
  and publishes them to gh-pages; the release workflow's `repos` job runs it on a v* tag, and
  `workflow_dispatch` runs an unsigned `repos-dry-run` (e986852, 2b7621f, 1f35e54).
- macOS: `docs/MACOS.md` defines sealed-on-macOS; `scripts/macos-sealed-check.sh` refuses remote or stopped
  engines (c71bbbb, 8ba288c); the macos CI job is blocking (ab5e316) [e2e-macos].
- `tx-decode --chain eth`: decodes legacy (pre-155 and 155), EIP-2930, 1559, 4844 (including the blob network
  wrapper) and 7702 raw transactions through a decode-only view; the signing parser is unchanged; EVM bytes are
  also auto-detected without `--chain` (62e8201) [tx-decode-evm-mainnet]. `tx-decode --chain
  xlm|algo|atom|ton|ada|dot|sol|tron|xrp` runs that chain's existing decoder, byte-identical in stdout and exit
  code (0a83f1c) (issue #11).
- `docs/COVERAGE.md`: verb x chain matrix measured from the CLIs; docs-check rule D-coverage fails on an
  unlisted multi-tool cell, a stale listing or a stale matrix, with 4 gate-negatives (bee1d50) (issue #11).
- e2e `scripts/e2e.d/evm-devnet.sh`: contract creation, a contract call and a value transfer on a pinned
  geth `--dev` node under the default schedule and Amsterdam, gas from `eth_estimateGas`; gas below the
  estimate fails on chain (b84d79e) [evm-devnet-create-call] (issue #9).
- Measured chain capability table (`scripts/chain-caps.py`, `tests/chain_caps.rs`, docs-check) (c362169, 126d4e8).
- `tty::confirm_ack`: a typed acknowledgement distinct from the confirmation code (3a21083).
- e2e recovery against wallets written at test time by Bitcoin Core 25.2, Electrum 4.5.8, eth-account and
  python-mnemonic (d9a6056; scope documented in 0f8a581) [recovery-synthetic-thirdparty].
- Signum (ex-Burst) recovery: new `signum-account` tool. A secret passphrase → SHA-256 private key →
  Curve25519 base multiplication (clamped, as libsodium/NXT `crypto_scalarmult_base`) → account id → the
  NXT Reed-Solomon `S-XXXX-XXXX-XXXX-XXXXX` address. Not BIP39/secp256k1, so no existing reader reached it;
  routed from `recover.sh --chain signum` (a free-form passphrase is not auto-classified), sweep in the
  Signum XT wallet. `crates/secrets/src/burst.rs`; `redact` allows the `signum` chain/kind and the S-
  address shape (`is_signum_address`). Vector: `S-H6YU-VM2A-MDZ5-CM32A` / id `11817502445436113882`.
- Electrum 1.x / Counterwallet mnemonics: `electrum::old_mnemonic_to_seed` decodes the 1626-word Electrum-1
  word list (3 words → 8 hex, floored modulo) to the stretched hex seed, feeding the existing `electrum_old`
  key derivation — so a 12-word Counterwallet phrase now reaches its uncompressed P2PKH addresses.
  `crates/secrets/src/electrum_old_words.rs`. Vector: → `1C6GJ8rocZzrjXPFnAEARTmysjuBS3RYY8`.

### Changed
- `rpc sendraw` and `tx-broadcast` show input values and fee before the confirmation code; when the fee
  cannot be proven (bare signed UTXO hex, no prevouts) they print a FEE UNKNOWN banner and require typing
  `ACK FEE-UNKNOWN` first (5a7d5aa, a75edb3) [sendraw-fee-shown]. Interactive flows that typed only the
  code now need the acknowledgement.
- `rpc`: params must be one JSON array (or object) argument; `rpc URL getblockhash 2` is now `bad_input`
  (exit 2, nothing sent) instead of sending a non-array params value nodes reject; write `'[2]'` (29cc5b1).
- `rpc --timeout` accepts a wider range (3c8c354); existing values stay valid.
- Packages: `phrase-to-key` is now shipped in deb/rpm/apk; it was in the v0.1.1 tarball only (907c318).
- `./blocktools run`/`reveal` refuse a remote docker engine (ssh/tcp context or `DOCKER_HOST`) unless
  `BLOCKTOOLS_ALLOW_REMOTE=1` (7c98c98) [wrapper-remote-refusal].
- Claims registry gates: stamped commits must have a green main CI run (K-ci), expect vs statement agreement
  (K-agree) (24688cd, 5a2ceb4, 57492bd, 751299a).

### Fixed
- `acct-tx` (rune): a `MsgDeposit` has no recipient, so decode/build no longer put the memo in `"to"`
  (`"to":null`; the memo stays in `"memo"`). The schema refused the memo as an address, so the sealed
  boundary dropped the whole line and `recipes/chain-thorchain.md`'s example exited 2. `sign --expect-memo`
  compares against `"memo"`; the /dev/tty summary shows "(no recipient) memo ...".
- `scripts/release-repos.sh` and `scripts/package-native.sh` no longer bind-mount host paths into docker: sources and
  staging go in as a tar on stdin and binaries, .rpm and .apk come back as a tar on stdout. On a Docker Desktop daemon
  (the signer runner) a WSL2 distro path mounts empty, so repos-dry-run failed with "could not find Cargo.toml in
  /src" (8a7b876).
- `scripts/e2e.d/evm-devnet.sh` waits for each killed geth before removing its datadir; the cleanup raced the node
  and turned a passing run into exit 1.
- `tx-verify`/`tx-sign` could not authorize an ERC-20 `approve` (or any non-transfer contract call) even
  with a `--policy` `allow_calls` entry for its exact `(contract, selector)`: the tools added the general
  findings an allow_calls match authorizes (`token_call_not_transfer` or `unknown_contract_call`,
  `has_warnings`, and for signing `destination_not_expected`) into their own verdict, then merged the
  policy file's findings only by ADDITION, never lifting the general ones the allowance waives -- so
  neither a token `approve` nor an opaque contract call (e.g. THORChain `depositWithExpiry`) listed in
  `allow_calls` could verify or sign. A new `policy_file::apply` merges and lifts in one place; both
  tools call it (issue #12). Regression: `scripts/e2e.d/approve-policy.sh`.
- `keystore-open` accepts eth-keyfile keystores whose IV lost leading zero bytes (previously reported
  unsupported; cause of a flaky recovery test) (3c7c460) [scrypt-bounds, recovery-synthetic-thirdparty].
- rpc tests ignore stray loopback connections (8acb94a); mock-bitcoind start wait for slower runners
  (c6c33f3); EPIPE tolerated when a tool refuses before reading stdin (8ba288c).
- Sealed image build: the Dockerfile copies `fixtures/utxo`, which the utxo dump tests read; the image
  build failed at cd93cd8 (678a8dd).
- Recipe `recipes/evm-contract-tx.md` used `--gas 100000` for a contract creation, which ran out of gas on
  Sepolia (status 0x0, gasUsed = limit; the init code was correct). It now takes `--gas` from `eth_estimateGas`
  on the user's chain: the same init code is estimated at 56132 on the default schedule and 226175 on
  Amsterdam, and on Amsterdam `--gas 100000` reproduces the Sepolia failure (b84d79e)
  [evm-devnet-create-call] (issue #9). The recipe also records the publicnode estimates for Ethereum
  mainnet and Sepolia taken by hand on 2026-10-27 (not a registered claim).
- `tx-decode --chain xmr` (and any other chain-table name that is not a UTXO chain, zec, eth or a delegated
  chain) parsed the input as a Bitcoin-family transaction; it now refuses with `unsupported_chain`, exit 2,
  before reading input (edf98c3; e2e tx-decode.sh).
- Sealed image build: the Dockerfile also copies `fixtures/leveldb` and `recipes/fixtures/evm-sol` (189e40f).
- recovery-real swap case picks a swap that fails the BIP39 checksum (62027dc).
- `fork-regtest` prints a labelled SKIP on non-Linux-x86_64 hosts instead of failing (49e6527).
- CHAINS.md no longer lists qrk as refused (2fcb79b); wasm lockfile gained sha2, fixing `wasm-check --locked` (f3c23ea).

### Security
- Fee is shown or explicitly acknowledged before any broadcast of a signed UTXO transaction
  (5a7d5aa, a75edb3) [sendraw-fee-shown].
- `rpc` deny-list: secret export/import/unlock and wallet-signing methods are refused before any request
  is sent (29cc5b1, 3c8c354) [rpc-deny-list]; response size capped and redirects refused [rpc-response-size-cap].
- Remote docker engines refused for sealed runs (7c98c98) [wrapper-remote-refusal].
- Release signing stays host-side: the signer runner's job-started hook admits only `release.yml` on a v*
  tag or a main `workflow_dispatch` (e986852).
- Boundary tests for input caps (977b94a) [redact-512, read-file-64mib, tx-input-4mib].
- secret-scan: tests derive block-hash literals instead of embedding them (cd93cd8).

### Known limitations
- The signed `repos` job has never run on a real tag; v0.1.1's repositories were signed by running the
  same scripts by hand on the host. Whether GitHub Pages redeploys after the job's push is not observed.
- The release publishes Linux x86_64 only. macOS arm64 and Linux aarch64 tarballs are built and checked
  in CI but not attached to the release, and the apk/apt/rpm repositories are x86_64 only.
- Not measured for this release candidate: the sealed run on Linux (sealed-run-linux; the Docker host used
  for measuring cannot bind-mount the input directory) and the mainnet fee figures in docs/ROADMAP.md
  (chains-fee-figures; no measuring command). docs/CLAIMS.md lists every claim with its status.
- The THORChain memo sends and `verifyThorSend` are tested against regtest nodes and fixtures only, never
  on mainnet.
- Sealed operation on macOS has never been run on a Mac; no recovery tool has been tested against a real
  lost or corrupted wallet.
- The CI runners hold the host Docker socket; the signer hook limits what the signer runner runs, not
  what a container job can reach.
