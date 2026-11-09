# Security

> **⚠️ DANGEROUS: use at your own risk.** Code that handles keys and signs transactions
> should always be read and audited by you before you trust it with real funds.
> **Used incorrectly, it can destroy your money**: signing to a wrong address, paying a
> huge fee, losing keys, or sending on the wrong chain. You are responsible for verifying
> every transaction. It opens hostile wallet files and extracts secrets, so run it only
> sealed and offline (`./blocktools run`, `--network none`). The unit tests are evidence,
> not a substitute for your own review. See [docs/SECURITY.md](SECURITY.md).

## What is tested (measured 2026-10-24, box, `cargo test --release` + `make e2e`)
* Test counts are not written here (they went stale): CI runs the whole
  workspace test suite and `scripts/e2e-local.sh`, and every push must be green.
* Known-answer vectors: BIP39/BIP32 "abandon…about" root; BIP44/49/84/86 BTC;
  ETH (EIP-55); LTC, DOGE, Tron (indices 0/1 and xpub parity TDTk…), XRP (incl.
  ACCOUNT_ZERO), Solana (SLIP-10 and ed25519 key 1); private key 1 in every
  encoding; Electrum standard/segwit seeds from Electrum's own test suite; base58
  edge cases; EIP-55 token addresses; Tron hex conversion and rejects.
  Non-standard goldens were cross-checked with an independent Python implementation
  (`scripts/kat.py`), not only against our own code.
* Boundary: every e2e pipeline runs through `sealed-run agent` and is grepped for
  secret-shaped strings (`LEAK` regex); secret fields must appear as `[REDACTED]`.
* Fixtures are self-made, throwaway, generated at test time; no real wallet or key
  has been used. A secret scanner runs before every push.

## What is NOT tested / known limits
* Not externally reviewed; no fuzzing yet, no formal review of the parsers against hostile files
  beyond size bounds and unit tests.
* Docker image verification on real hardware is done per release step only.
* Terminal confirmation is NOT proof of a human: any process that can spawn a pty can type the
  code (see "Terminal confirmation: residual risk" below). Terminal pinning narrows it; it doesn't close it.
* Signing / broadcasting evidence is chain-specific; see [CHAINS.md](CHAINS.md) for real-node runs
  and untested limits, and [CLAIMS.md](CLAIMS.md) for measured claims. Do not generalize a run to other chains.
* A hostile endpoint can force the unknown-fee path. `rpc sendraw` looks up previous transactions at the
  endpoint it is about to broadcast to; each answer must hash to the txid the input names, so the endpoint
  can't fake an input value, but it can answer "not found". The summary then shows the FEE UNKNOWN banner
  and wants `ACK FEE-UNKNOWN`. Don't type it for an endpoint you don't trust: pass `--prevtxs FILE` built
  elsewhere, or broadcast the tx-sign JSON with `tx-broadcast`, which carries the input values.
  `tx-broadcast` given bare signed UTXO hex (no input values) shows the same banner and wants the same ACK.
* The macOS sealed path is unverified. The macos CI job runs the tools natively, not sealed (README).
* Release assets are Linux x86_64 only; other platforms build from source. Each measurement
  in [CLAIMS.md](CLAIMS.md) names its platform; a native run does not validate a sealed run.
* CI runners hold the host Docker socket (docs/CI.md). A job that runs on them can control the host's Docker,
  so a workflow change is trusted like host access. Fork pull requests run on GitHub-hosted runners instead.
* `utxo-set` / `wallet-finder` answer "funded" only against the dump you give them. The dump's age and
  origin are yours to trust: they don't check a dump against a node, and funds moved after it was taken are not seen.
* Old git history (commit 360a78e) contains throwaway test wallet files (public
  phrases, no value); history is deliberately not rewritten.

## Reporting issues
Report vulnerabilities privately to the maintainer via a GitHub security advisory
on the repository (Security → Report a vulnerability), not in a public issue. Do not
include real keys, seeds or wallet files in any report.

## Legacy-input amount proof

**Legacy-input amount proof (security review 2026-10-25).** A legacy (pre-segwit) sighash does not commit to the
amount being spent, so a host that lies about an input's value can make a signer pay a hidden fee (the classic
P2PKH fee attack). Rule, applied to every legacy-sighash family (BTC/LTC/DOGE/BLK/... P2PKH, GRS, PoS-nTime):
an input whose script is not a witness program must carry its full previous transaction. Bare P2SH counts as legacy (it may wrap any legacy script) unless the utxo line / PSBT carries a `redeem_script` that is a witness program hashing to the address (wrapped segwit, BIP143); tx-sign also accepts P2SH it can prove as its own key's P2SH-P2WPKH.
`utxo-fetch` adds `prev_tx` (raw hex) for such inputs; `tx-build` refuses without it (`legacy_input_needs_prev_tx`)
or when its txid (chain digest: GRS single SHA-256) or output disagrees with the claimed amount/script; the PSBT gets
`non_witness_utxo`, PoS envelopes get `pos_prevouts[i].prev_tx`. `tx-decode` reports `unproven_inputs`; `tx-verify`
fails with `legacy_input_amount_unproven` (not waivable by `--allow-warnings`); `tx-sign` refuses to sign such an
input. **BCH/BSV/BTG are not exempt:** their fork-id sighash commits to the amount (a lying amount would only
give an invalid signature), but every check keys on the script type and the fork-id signer (`sign_psbt_forkid`)
requires the proving previous tx too, so a P2PKH input on these chains needs `prev_tx` exactly like BTC P2PKH (test `forkid_needs_prev_tx`;
same rule for tx-build, `buildUnsignedSweep` in wasm, tx-decode/tx-verify and tx-sign). Only Zcash, whose
transactions are not PSBTs and carry amounts in the `zec_prevouts` envelope committed by ZIP-243/244, is exempt.

## Terminal confirmation: residual risk (security review 2026-10-25)

Earlier docs said "agent shells have no TTY". That is false: any process that can fork a pseudo-terminal
(Python `pty.fork`, `script`, `expect`, tmux) gets a controlling terminal, reads the code from it and
types it back. scripts/e2e-only/tty-drive.py does exactly that, and e2e uses it to drive `reveal`,
`sealed-run human` and `tx-sign`. The typed code proves that *something* answered on a terminal, not
that a human read the summary.

Partial mitigation: **terminal pinning.** The human runs `sealed-run pin-tty` once in their own terminal.
It records that terminal's session id and controlling-tty device in `~/.config/blocktools/tty-pin`
(from the password database, not `$HOME`; mode 0600). `$BLOCKTOOLS_TTY_PIN` can add a second pin but
can't remove one. While a pin exists, every confirmation (`tx-sign`, `tx-broadcast`, `acct-tx`, `xrp-tx`,
`xmr-wallet`, `sealed-run human`) refuses from any other session with `tty_session_not_pinned`. An unreadable pin
fails closed. e2e checks that a pin made in one pty refuses a code from a freshly spawned pty.

What it does NOT stop:
* an agent running as the same Unix user can delete or rewrite the pin (or pin its own pty first);
* injection into the pinned terminal itself (TIOCSTI where the kernel allows it, ptrace,
  `tmux send-keys`, terminal-emulator automation);
* platforms without /proc (macOS): there the session can't be read, so any pin fails closed and
  confirmation is refused while a pin exists.

It only helps when the agent runs as a different user (or in a container) that can't write the pin.
The real control is still the human reading the summary on a terminal the agent does not drive.

## Keystore KDF bounds (security review 2026-10-25)

`keystore-open` used per-knob caps (p ≤ 4) that rejected the Web3 spec's own scrypt vector (p=8). It now
bounds what matters: memory 128·N·r ≤ 256 MiB and work N·r·p ≤ 2^24 (8x geth standard), checked with
overflow-safe arithmetic before any allocation. All scrypt goes through the RustCrypto `scrypt` crate (>= 0.12, which dropped the RFC 7914
N < 2^(16r) erratum check, so the spec vector N=2^18, r=1 works); there is no in-tree KDF or cipher code.
Tests: spec vector (p=8),
geth --lightkdf (N=4096, r=8, p=6), RFC 7914 vector 2 through the crate, bounds, hostile 8 GiB request refused.

## EVM verification defaults (security review 2026-10-25)

`tx-verify` (and wasm `verifyTx` with `max_fee` "") now applies tx-sign's default EVM total-fee cap, gas × maxFeePerGas
≤ 0.01 ETH, so verify and sign agree; pass `--max-fee WEI` to change it. A nonzero native value alongside ERC-20
`transfer` calldata (the ETH would go to the token contract) fails with `eth_value_with_token_call` in tx-verify
and tx-sign unless `--allow-value-with-token`. Test: `evm_value_with_token_and_default_cap` (crates/tx/tests/kat.rs).

## Redactor and classify hardening (security review 2026-10-25)

`redact` (blocktools_schema::looks_secret / redact_line) now also refuses lines containing an XRP family seed
(`s` + 28-31 base58), a Bitcoin mini private key (`S` + 21/25/29 base58), or a 32-44 char base58 value in any
address-type field (`address`, `from`, `to`, `token`, `token_to`) unless the line says `"chain":"sol"`; a 32-byte
base58 value in any other string field is refused outright. `classify` on a password file (`/secrets/pw`, `pw*`,
`*pass*`) and on any `unknown` row prints class and line only: no SHA-256 fingerprint, which would be a
dictionary oracle for a low-entropy password. Tests: `rejects_xrp_seed_minikey_sol_secret`, classify `pw_paths`.

## Repo hygiene (security review 2026-10-25)

GitHub Actions are pinned by commit SHA; release publishing is a separate job in the `release` environment
(the `release` environment must allow deployments only from `v*` tags; `scripts/release-env-check.sh` refuses to publish otherwise, no manual approval since 2026-10-26). `check-deps.sh`
runs with `LC_ALL=C` and reads members from `cargo metadata --locked`. The Python wheels once (unmeasured)
committed at the repo root are removed going forward and `*.whl` is ignored; they remain in git history
(no rewrite). `scripts/hygiene-check.sh` (gate and CI) fails on unpinned actions or tracked build artifacts.

## Docs-versus-code checks and portable e2e (security review 2026-10-25)

`scripts/docs-check.sh` (gate and CI) fails if a tool under `tools/` is undocumented, a built tool is called
"planned", a hand-written test count appears in README/DESIGN/SECURITY, a host-side network tool
(rpc, utxo-fetch, tx-broadcast, xmr-wallet) is in crates/io/sealed-tools.txt (the sealed-run allowlist and the image ship list), or in-tree scrypt
reappears undisclosed. `scripts/e2e-local.sh` is part of the Linux gate; macOS is run by the blocking macos CI job (docs/CI.md, Platforms): `scripts/e2e-only/portable.sh`
replaces `setsid` (Python `os.setsid` fallback) and `stat -c` (BSD `stat -f`); checks whose fixtures need
the Python `cryptography` module (dat-read, recover, bitcoinj) print `skip ... pip install cryptography`
instead of failing. Each e2e.d script now runs in its own subshell, so one script's skip no longer ends the suite.

### EVM network pinning (review B, 2026-10-25)
For every EVM transaction, `tx-verify`, `tx-sign` and wasm `verifyTx` fail with `chain_id_not_pinned`
unless the caller passes `--chain-id` (`chain_id`), and with `chain_id_mismatch` when it differs from the
transaction's id. The network (e.g. BNB Smart Chain = 56) is a machine check, not left to the human.
The summary starts with a boxed `CHECK THESE` block: chain id and name, NATIVE vs TOKEN, final recipient,
value and max fee in the chain's native symbol (ETH, BNB, POL, AVAX), with a marker when native coin is
sent to a token contract.

### Script strictness (review F, 2026-10-25)
Every script in scripts/, scripts/e2e.d/ and recipes/ runs with `set -eu`; the check scripts and
recipes/recover.sh add `pipefail`. e2e-local.sh deliberately does not: its checks assert on a tool's
output (`tool | grep -q EXPECTED`), where the tool's nonzero exit is the refusal under test. grep
"no match" is tolerated only as exit 1 (`|| [ $? -eq 1 ]`), so grep errors stay fatal. Any
remaining `|| true` / `|| :` must carry an `# allow-true: reason` comment on the same line;
scripts/hygiene-check.sh fails otherwise. The audit found two real swallowed errors: secret-scan's
`xargs grep 2>/dev/null || true` (now `git grep`, fatal on error) and an e2e tx-broadcast no-tty
check whose result was discarded (its stdin was also overridden; now asserted).

### Explicit staging (review G, 2026-10-25)
Nothing stages with `git add -A`. Changes are staged by path; scripts/verify-and-push.sh never
stages and runs scripts/prepush-check.sh before testing and again before committing. It fails on
untracked non-ignored files, unstaged edits to tracked files, any tracked binary, and any tracked
file over 2 MB. CI runs it too. Local hook: `git config core.hooksPath .githooks` (.githooks/pre-push).
