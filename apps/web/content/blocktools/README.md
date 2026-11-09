# blocktools

Offline command-line tools for blockchain transactions and smart contracts: encode and decode
contract calls, logs and reverts, inspect ABIs and bytecode, verify EIP-712 signatures, build
transactions and check them before anything signs, derive addresses and sign across many chains.
Rust Unix filters (one JSON object per line on stdin/stdout) that you chain into pipelines, plus a
wasm build for JavaScript/TypeScript. MIT licensed.

> **⚠️ Use at your own risk.** Code that handles keys and signs transactions should be read and
> audited by you before you trust it with real funds. **Used incorrectly, it can destroy your
> money**: signing to a wrong address, paying a huge fee, losing keys, or sending on the wrong
> chain. You are responsible for verifying every transaction. Tools that touch secrets are meant to
> run sealed and offline (`./blocktools run`, `--network none`). The unit tests are evidence, not a
> substitute for your own review. See [docs/SECURITY.md](docs/SECURITY.md).

## What it is

* **Contract tools (EVM)**: ABI encode/decode, selector and error lookup against your own
  candidate list, ABI inspection, log decoding, CREATE/CREATE2 addresses, bytecode inspection,
  EIP-712 verification, and a pre-sign check of contract calls. See below.
* **Transactions**: `tx-build` → `tx-verify` → `tx-sign` → `tx-broadcast` for Bitcoin,
  UTXO forks and EVM. Other chains use `--chain` hand-offs to `acct-tx`, `sol-tron-tx`
  or `xrp-tx`, with gaps: Solana/Tron have no signing or broadcast; XRP and account chains
  have no verify or broadcast backend. See [verb × chain coverage](docs/VERB-CHAIN.md).
  PSBT and multisig
  (`multisig`, `taproot-multisig`, `tx-combine`), `tx-decode`, `tx-plan`, message signing
  (`msg-sign`/`msg-verify`), Sign-In with Ethereum messages (`siwe`), BOLT11 invoices (`bolt11`). Signing is deny-by-default: `tx-verify`
  refuses what it cannot check unless you assert it explicitly. See [docs/POLICY.md](docs/POLICY.md)
  and [docs/REFUSALS.md](docs/REFUSALS.md).
* **Keys and addresses**: `derive`, `xpub-addresses`, `key-to-addresses`, `seed-to-master`,
  `new-seed`, `chain-table`. Per-chain support (derive / detect / sign / real-node evidence) is in
  the generated table in [docs/CHAINS.md](docs/CHAINS.md). No coin other than BTC has been signed
  and accepted on a real mainnet; several UTXO forks have a regtest real-node test, the rest are
  tested against mocks and vectors only.
* **Node and chain access (host-side)**: `rpc`, `utxo-fetch`, `contract-call`, `contract-trace`.
* **Wallet-file and seed recovery**: readers for old wallet formats, seed repair and password
  candidates. Tested on synthetic wallets only; see
  [Key and wallet recovery](#key-and-wallet-recovery) below.
* **Library**: a wasm build with 77 exported functions (`bindings/wasm`, list in
  [EXPORTS.md](EXPORTS.md)); no wasm call accepts a private key, seed or password. A C ABI too.

See [DESIGN.md](DESIGN.md) for the pipe rules and [docs/SECURITY.md](docs/SECURITY.md) for the
threat model.

## Contract tools (EVM)

| tool | what it does | network |
|---|---|---|
| `abi-encode` / `abi-decode` | encode calls; decode calldata, return data and reverts (`Error(string)`, custom errors); a wrong `--sig` reports `no_match` instead of guessing | offline |
| `sig-hash` | selectors, event topics, error ids; `--lookup` against candidate signatures you supply (no built-in signature database) | offline |
| `abi-inspect` | functions, events, selector collisions, interface ids | offline |
| `log-decode` | decode `eth_getLogs` / receipt logs | offline |
| `create-address` | CREATE (deployer + nonce) and CREATE2 (EIP-1014) | offline |
| `bytecode-inspect` | EIP-1167 proxy, EIP-7702, EOF, EIP-170 size, solc metadata, selector candidates (heuristic) | offline |
| `typed-data-verify` | EIP-712 type hash, domain separator, digest, signer recovery, expected-signer check | offline |
| `tx-build --data/--create` → `tx-verify --call/--abi/--create-hash` | build an unsigned contract call or deployment, then approve the exact calldata or initcode before signing | offline |
| `contract-call` | `eth_call` with return/revert decoding, `--read` for no-input views, `--chain-id` check | live RPC |
| `contract-trace` | `eth_call` with checked state overrides; `debug_traceCall` passthrough behind `--allow-unlisted` | live RPC |

```sh
abi-encode 'approve(address,uint256)' 0x000000000022D473030F116dDEE9F6B43aC78BA3 1000000
jq -r .result.input recipes/fixtures/evm-mainnet/01a-erc20-transfer-tx.json | abi-decode --sig 'transfer(address,uint256)'
```

`tx-build --data` piped to `tx-verify --call SIG` approves a decoded call; without `--call`, `tx-verify` fails with `unknown_contract_call`. `contract-call` and
`contract-trace` are host tools: they are not in the sealed image or the wasm build, and their tests
use a mock RPC. Not included: proxy storage-slot reading, ABI or verified-source fetching, full
simulation. Recipes ([index](recipes/evm-contract-data.md)): [decode calldata](recipes/evm-decode-calldata.md), [unknown selector](recipes/evm-unknown-selector.md), [logs](recipes/evm-decode-logs.md), [reverts](recipes/evm-decode-revert.md), [eth_call](recipes/evm-eth-call.md), [CREATE/CREATE2](recipes/evm-contract-address.md), [inspect a contract](recipes/evm-inspect-contract.md), [EIP-712](recipes/evm-eip712-verify.md), [approve/permit check](recipes/evm-check-approval.md), [multicall/Universal Router](recipes/evm-decode-multicall.md), [tx hash end to end](recipes/evm-tx-end-to-end.md), [Permit2 request](recipes/evm-permit2-signing-request.md), [proxy/7702 check](recipes/evm-check-proxy-delegation.md), [contract calls and deployments](recipes/evm-contract-tx.md) (build, verify, sign, broadcast), and the [full index](recipes/README.md).

## Install

### From the v0.5.0 release (Linux x86_64 only)

Releases are a Linux x86_64 tarball plus `SHA256SUMS`; the release itself is not signed. There is no macOS, Windows or ARM asset; on those, build from source.

```sh
gh release download v0.5.0 -R TSavo/blocktools     # or download both files from the Releases page
sha256sum -c SHA256SUMS                            # must print: blocktools-v0.5.0-linux-x86_64.tar.gz: OK
tar xzf blocktools-v0.5.0-linux-x86_64.tar.gz
cd blocktools-v0.5.0-linux-x86_64
export PATH=$PWD/bin:$PATH MANPATH=$PWD/share/man:
man blocktools
```

Do not skip the checksum step: an archive that fails `sha256sum -c` must not be run. The binaries are
dynamically linked against glibc; only the sealed Docker image is built from static musl binaries.
Measured on the v0.3.3 tarball (2026-10-31, `sh scripts/tarball-glibc.sh v0.3.3`): 53 of its 55 binaries need glibc 2.34
or newer; `sealed-run` and `tx-decode` need glibc 2.39 or newer (newest `GLIBC_` symbol per binary via `objdump -T`).

**Sealed mode from a tarball.** The tarball has no Dockerfile or sources, so its `./blocktools
build` cannot work. Build the image from the same release:

```sh
git clone --branch v0.5.0 https://github.com/TSavo/blocktools && cd blocktools
./blocktools build                                 # image blocktools:local; then ./blocktools run '...'
```

Until then, the tarball's `bin/sealed-run agent '<pipeline>'` gives the same output redaction but
no container isolation (no `--network none`): use it only on an offline machine.

### Debian / Ubuntu (apt, amd64)

```sh
sudo install -d -m 0755 /etc/apt/keyrings
sudo wget -O /etc/apt/keyrings/blocktools-archive-keyring.asc \
  https://raw.githubusercontent.com/TSavo/blocktools/main/packaging/apt/blocktools-archive-keyring.asc
echo "deb [signed-by=/etc/apt/keyrings/blocktools-archive-keyring.asc] https://tsavo.github.io/blocktools/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/blocktools.list
sudo apt update && sudo apt install blocktools
```

The repo serves 0.5.0-1. Glibc floors from the v0.3.3 tarball binaries (see above): 53 of its 55 binaries need 2.34+,
`sealed-run` and `tx-decode` need 2.39+. By the distros' glibc versions (inferred, not run): Debian 12 (2.36) and
Ubuntu 22.04 (2.35) run all but those two; Ubuntu 24.04 (2.39) runs all. Key fingerprint and the older container
measurements (debian:12, ubuntu:22.04 and 24.04, 2026-10-26, 0.1.x package): [docs/APT-SIGNING.md](docs/APT-SIGNING.md).

### Alpine (apk, x86_64)

```sh
wget -O /etc/apk/keys/blocktools@tsavo-2026.rsa.pub \
  https://raw.githubusercontent.com/TSavo/blocktools/main/packaging/alpine/keys/blocktools@tsavo-2026.rsa.pub
echo https://tsavo.github.io/blocktools/alpine >> /etc/apk/repositories
apk update && apk add blocktools
```

Static musl binaries; the repo serves 0.5.0-r0. Hand-measured once, on the earlier `0.1.1_pre20261026` package, in an
`alpine:latest` (3.24.3) container on 2026-10-26 (untested): install from the live URL, 43 of 43 executables run,
refused without the key: [docs/APK-SIGNING.md](docs/APK-SIGNING.md). Re-measured on 2026-11-08 against live `0.4.0-r0`
in `alpine:latest` (3.24.3) with apk-tools 3.0.8-r0: 56 of 58 executables ran (`blocktools` and `recover.sh` wrappers
exit 2); apk update and apk add without the repo key were refused (UNTRUSTED signature).

### From source

```sh
git clone https://github.com/TSavo/blocktools && cd blocktools
cargo build --locked --release --workspace         # tools land in target/release/
./blocktools build                                 # the sealed image (needs a Docker host)
```

## Sealed runs

`./blocktools run '<pipeline>'` runs the pipeline in a container with `--network none`, a
read-only root filesystem, all capabilities dropped, a non-root user and memory/pid limits.
`./in` is mounted read-only at `/in` and `./secrets` (passwords, one per file) read-only at
`/secrets` (`BLOCKTOOLS_IN` / `BLOCKTOOLS_SECRETS` move them). Its stdout passes through
`sealed-run agent`, which replaces every key field with `[REDACTED]` and drops lines that fail its
leak check, so the output is safe to paste or to hand to an agent. `./blocktools reveal` is the
human-only variant: it needs a real terminal and a typed code, then prints keys.
`scripts/sealed-check.sh` checks these flags on a real container (Linux Docker only).
**macOS sealed path is unverified (untested).** The macos CI job runs the tools natively, not sealed. One hand check on a Mac
(macOS 26.3.1 x86_64 at 2efe6ae2; Docker Desktop not running, so `docker` pointed at `ssh://battleaxe`): `./blocktools run`
refused the remote engine (exit 4); with `BLOCKTOOLS_ALLOW_REMOTE=ssh`, `classify /in/probe.txt` returned ok and the container saw the Mac's `./in` file via the tar-over-`docker exec` path (hand check 2026-11-08, not re-run in CI) (untested).
The wrapper bind-mounts nothing and creates no volume: `./in` and `./secrets` are streamed as tar on stdin
(`docker exec -i -u 0 <container> sealed-run unpack /in|/secrets`) into tmpfs mounts of the sealed container itself,
as root-owned 0444 files that uid 10001 can read but not change, and the container (with its tmpfs) is removed on exit,
because a Docker Desktop engine on Windows does not see WSL2 paths (a bind mount there arrives empty) and secrets must
not reach the engine's disk. The `/in` tmpfs size is set by `BLOCKTOOLS_IN_SIZE_MB` (default in `./blocktools`) and counts against the container memory limit. `scripts/e2e.d/wrapper-seal.sh` checks
this with a fake docker everywhere, `sealed-run unpack` on the wrapper's own tar, and a real engine on the Linux CI
runners (untested until a green CI run shows it); Docker Desktop on Windows itself is not in CI (untested).
`./blocktools run`/`reveal` now refuse an `ssh://` or `tcp://` engine (`DOCKER_HOST` or the current context) before starting
a container (`scripts/e2e.d/wrapper-remote.sh`, Linux, fake docker binary) (untested). `BLOCKTOOLS_ALLOW_REMOTE=ssh` permits only an `ssh://` engine (the tar streams travel inside ssh and land in tmpfs);
with it a `tcp://` or `http(s)://` engine is still refused (exit 4). `BLOCKTOOLS_ALLOW_REMOTE=1` permits any remote engine;
set it only if copying `./in` and `./secrets` to that host over that transport is intended. Recipe "Mac -> Battleaxe over SSH": see docs/MACOS.md.
Without Docker, `sealed-run agent '<pipeline>'` gives the same redaction but none of the
container isolation.

## Key and wallet recovery


Readers for Bitcoin Core wallet.dat, Electrum, Ethereum keystores, MultiBit, Armory and BIP38, plus `seed-repair`, `pw-candidates`, `classify` and `wallet-finder`. They have **not been tested against any real lost wallet (untested)**. Nobody has handed us a real
corrupted wallet or a real forgotten password, so recovery rests on synthetic tests only.
What is measured (Linux x86_64, `scripts/e2e.d/recovery-real.sh`, run in CI's e2e stage):

* Wallet files written by the real third-party software, with throwaway keys and passwords
  (generated fresh at test time by `scripts/recovery-gen.sh`, never committed; see docs/FIXTURES.md): Bitcoin Core 25.2 legacy BDB and descriptor (SQLite) wallet.dat,
  Electrum 4.5.8 segwit wallets (whole-file encrypted and keystore-only), and an eth-account 0.13.4
  scrypt keystore (the geth/MetaMask-export format). A BIP39 phrase from python-mnemonic (the Trezor
  reference) with addresses computed by Bitcoin Core's `deriveaddresses`.
* Damage a user would plausibly have: a typo'd seed word, two swapped words, a missing word, an
  unknown word (`?`), on the BIP39 and Electrum seeds; a password remembered only as "horse battery"
  plus a digit, or with two letters swapped. `seed-repair` / `pw-candidates` and the wallet readers
  must reach the address the generator itself printed. Candidate counts and attempt numbers are
  printed by the script on each run.
* Our own writers, not third-party ones: `scripts/make-fixtures.py` (dat-read e2e) and
  `scripts/electrum-bie1-gen.py`. btcrecover's test wallets (fetched by `scripts/fetch-fixtures.sh`)
  are third-party files but not ours to regenerate.

Not covered: a swap (or typo) that still passes the BIP39 checksum: seed-repair then reports `checksum_ok` and searches nothing, so the test picks a swap whose checksum fails; wallets damaged on disk (truncated or bit-flipped files), MetaMask's browser vault, Exodus,
hardware-wallet passphrases, multisig, passwords not reachable from the tokens you give, seeds with more
than two unknown words, and every wallet version other than those named above.


## Worked examples (public test fixtures only)

Each command below is run as written by `scripts/recipe-check.py` in CI, through the same
`sealed-run agent` boundary. Put the file in `./in/` and its password in `./secrets/`. The
fixtures are public: the BIP39 vector "abandon … about", the Web3 Secret Storage keystore vector,
and btcrecover's test wallets (`scripts/fetch-fixtures.sh`; password `btcr-test-password`).
Never put a real wallet on a networked machine.

**Seed phrase** (`in/seed.txt` = the 12-word "abandon … about" vector; CI's copy has two typos, which `seed-repair` fixes before `seed-to-master` sees it):

<!-- e2e: expect=bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu ; expect="wif":"[REDACTED]" -->
    ./blocktools run 'seed-repair < /in/seed.txt | seed-to-master | derive --chain btc --count 1'

<!-- e2e: expect=0x9858EfFD232B4033E47d90003D41EC34EcaEda94 -->
    ./blocktools run 'seed-repair < /in/seed.txt | seed-to-master | derive --chain eth --count 1'

**Bitcoin Core wallet.dat** (btcrecover's `bitcoincore-wallet.dat`, BDB):

<!-- e2e: expect=1Ak4Z3NsRigsn9wpwZNoRobNzy9jokxQxx ; needs=old-client-wallet.dat -->
    ./blocktools run 'read-file /secrets/multibit.pw /in/old-client-wallet.dat | dat-read | key-to-addresses --chain btc'

**Ethereum keystore** (Web3 Secret Storage test vector, password `testpassword`):

<!-- e2e: expect=0x008AeEda4D805471dF9b2A5B0f38A0C3bCBA786b -->
    ./blocktools run 'read-file /secrets/keystore.pw /in/keystore.json | keystore-open'

**Old Electrum 1.x seed** (Electrum's own test vector; 12 words from the 1626-word list, or the 32-hex seed) and **brainwallets** (`phrase-to-key`: sha256 of the phrase as brainwallet.org/bitaddress.org did, or WarpWallet):

<!-- e2e: expect=1FJEEB8ihPMbzs2SkLmr37dHyRFzakqUmo -->
    ./blocktools run 'seed-to-master < /in/electrum-old-seed.txt | derive --chain btc --count 1'

<!-- e2e: expect=1JwSSubhmg6iPtRjtyqhUYYH7bZg3Lfy1T -->
    ./blocktools run 'phrase-to-key < /in/brainwallet.txt | key-to-addresses --chain btc'

**Which of your phrases is funded, offline** (`utxo-set`, `wallet-finder`): load a Bitcoin Core `dumptxoutset` file into RAM and test addresses, or every sentence and word run of your own text, against it without asking any server. Hits print phrase, scheme, address and balance, never a key. Recipe: [recipes/goal-find-funded-phrase.md](recipes/goal-find-funded-phrase.md).

<!-- e2e: expect="hits":5 ; expect="status":"ok" -->
    wallet-finder --dump /in/utxo.dat < /in/notes.txt > /secrets/hits.jsonl

**Electrum** (btcrecover's Electrum 4.4.3 wallet):

<!-- e2e: expect=bc1qsz0dhew357cj6eznmcawgyf44jzpgcax2lvfvm ; needs=electrum-wallet -->
    ./blocktools run 'read-file /secrets/electrum.pw /in/electrum-wallet | electrum-read | seed-to-master | derive --chain btc --count 1'

**MultiBit Classic** (`.key` export):

<!-- e2e: expect=166UVSG9WX81Pkp9f8o4htYV9M3KBqXHdV ; needs=multibit.key -->
    ./blocktools run 'read-file /secrets/multibit.pw /in/multibit.key | multibit-read | key-to-addresses --chain btc'

**Armory** (`.wallet`):

<!-- e2e: expect=1H29eJEsQCtwCRc737gZyD7HtpxxdQNQzv ; needs=armory.wallet -->
    ./blocktools run 'read-file /secrets/armory.pw /in/armory.wallet | armory-read | key-to-addresses --chain btc'

Not sure what a file is? `classify` names it, and `recipes/recover.sh FILE - --goal addresses`
picks the pipeline for you:

<!-- e2e: expect="class":"wallet_dat" ; needs=old-client-wallet.dat -->
    ./blocktools run 'classify /in/old-client-wallet.dat'

## Where to go next

* Manual pages for every tool, `recover.sh` and the wrapper: `man/` in the repo
  (`man -l man/man7/blocktools.7`), `share/man/` in the release. They are generated from `--help`
  by `scripts/gen-man.py`, and CI fails if they are stale.
* Recipes, by input, chain and goal (sweep, balance, verify offline): [recipes/README.md](recipes/README.md).
  Every recipe has at least one example that CI runs.
* [Getting started](docs/getting-started.md) · [cookbook](docs/cookbook.md) ·
  [troubleshooting](docs/troubleshooting.md) · [refusal codes](docs/REFUSALS.md) ·
  [paths](docs/PATHS.md) · [policy files](docs/POLICY.md) · [chains](docs/CHAINS.md) ·
  [library API](docs/library-api.md) · [wasm/TS](bindings/wasm/README.md) ·
  [parity generators](docs/PARITY-GENERATORS.md) · [docs index](docs/README.md).

## Status

Status: the sealed image builds on Linux docker (52.1 MB (unmeasured) of uncompressed layers via `docker save` on a containerd image store at 55d8cad1, 43 binaries: the 42 entries of `crates/io/sealed-tools.txt` plus sealed-run; the file now lists 42 entries (measured at 9c48627); host tools such as contract-call are not in the image; `scripts/image-size.sh` prints the instrument and the docker version/storage driver, because `docker image inspect` differs between image stores). `scripts/sealed-check.sh` checks the sealed run on a real container (untested): network none, read-only rootfs, all capabilities dropped, read-only /in, and no secret material in agent output (Linux docker only). Phase-2 tools (tx-build, tx-verify, tx-sign, tx-broadcast, account and XRP signers) are covered by unit/KAT tests and `scripts/e2e-local.sh`; `sealed-run human` (what `reveal` runs inside the container) is driven through a pty in e2e. Not yet tested: `./blocktools reveal` itself under Docker on a real terminal. See DESIGN.md "Verified status".

Host-side network tools (`utxo-fetch`, `tx-broadcast`, `rpc`) never enter the sealed image, and `sealed-run` refuses them (status `unsupported`, exit 2, measured 2026-10-26): run them on the host, after the sealed steps. `rpc` is a pipe filter for node and wallet RPC endpoints (EVM, bitcoind and forks, Solana, Tron, Cosmos LCD, Esplora, Blockbook) that refuses key-export, unlock and wallet-signing methods by default; see `docs/RPC.md` (mock-tested; one measured public read).

Tests: `cargo test --release && sh scripts/e2e-local.sh`; the full gate is `sh scripts/gate.sh`.
Test vectors are public. Never commit real wallet data; `in/` and `secrets/` are git-ignored.
