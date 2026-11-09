# Getting started

**DANGEROUS with real funds.** Read [SECURITY.md](SECURITY.md) first. Practise on the public
fixtures below and on mock chains before you touch a real key.

## 1. Install

Pick one.

**Release tarball (Linux x86_64 only, glibc-linked, not static).** The current GitHub release is v0.5.0 and ships `blocktools-v0.5.0-linux-x86_64.tar.gz` and
`SHA256SUMS`. Measured on the earlier v0.3.3 tarball: 53 of the v0.3.3 tarball's 55 binaries need glibc 2.34 or newer, `sealed-run` and `tx-decode` need 2.39 or newer; see the README. A v0.5.0 glibc floor has not been re-measured. Verify before you unpack:

```sh
gh release download v0.5.0 -R TSavo/blocktools
sha256sum -c SHA256SUMS            # blocktools-v0.5.0-linux-x86_64.tar.gz: OK  -- anything else: stop
tar xzf blocktools-v0.5.0-linux-x86_64.tar.gz && cd blocktools-v0.5.0-linux-x86_64
export PATH=$PWD/bin:$PATH MANPATH=$PWD/share/man:
```

Tools are in `bin/`, manual pages in `share/man/` (`man derive`, `man blocktools`, `man recover.sh`).
The tarball has no Dockerfile: for the sealed image, `git clone --branch v0.5.0` and run `./blocktools build` there (below). In v0.1.0, `derive --address-list` through `redact` comes back empty; the README gives the `--public-only | jq` workaround.
Measured on Linux 2026-10-26: checksum OK, `man -w blocktools` resolves, and the examples in
section 3 pass with the release binaries. No macOS asset exists.

**From source.**

```sh
git clone https://github.com/TSavo/blocktools && cd blocktools
cargo build --locked --release --workspace     # binaries in target/release/
./blocktools build                             # sealed Docker image blocktools:local
```

**DEB / RPM / APK:** published package repositories serve v0.5.0; follow the
[repository install instructions](RELEASE-REPOS.md). Local packaging uses
`scripts/package-dist.sh` and `scripts/package-native.sh`; man pages go under `/usr/share/man`.
See [APK-SIGNING.md](APK-SIGNING.md) for the current Alpine install measurement and
[APT-SIGNING.md](APT-SIGNING.md) for the older, version-pinned Debian/Ubuntu measurements.

## 2. The security model in plain words

- **Secrets stay offline.** Anything that reads a seed, keystore or wallet file runs inside
  `./blocktools run` (no network, read-only filesystem, no capabilities, redacted stdout).
- **Inputs and secrets are separate.** Wallet files go in `./in` (seen as `/in`), passwords in
  `./secrets` (seen as `/secrets`), one per file, ending in a newline. `read-file PW FILE` joins
  them on stdin for the reader tool.
- **Flags are public.** Passwords, passphrases and mnemonics never go on argv.
- **What you see is redacted.** Key fields print as `[REDACTED]`. Only `./blocktools reveal`, at
  a real terminal after a typed code, prints keys.
- **Humans confirm spending.** `tx-sign` and broadcast ask for a one-time code on a terminal;
  optional [policy files](POLICY.md) cap fees and destinations before signing.
- **Unverified chains are labelled.** [CHAINS.md](CHAINS.md) lists verified and unverified rows.

## 3. First recovery, on public test data

```sh
mkdir -p in secrets
printf '%s\n' 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' > in/seed.txt
```

What is it?

<!-- e2e: expect="class":"mnemonic" -->
    ./blocktools run 'classify /in/seed.txt'

Repair (checksum, typos), turn into a master key, derive the first address of each Bitcoin type:

<!-- e2e: expect=1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA ; expect=bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu -->
    ./blocktools run 'seed-repair < /in/seed.txt | seed-to-master | derive --chain btc --count 1'

Or let the front door choose the pipeline for any file:

<!-- e2e: expect=bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu -->
    recipes/recover.sh /in/seed.txt - --goal addresses

Many chains at once, as a plain `label<TAB>path<TAB>address` list (SwapChan SCAN_JS layout;
source build after v0.1.0, see the README):

<!-- e2e: expect=0x9858EfFD232B4033E47d90003D41EC34EcaEda94 -->
    ./blocktools run 'seed-repair < /in/seed.txt | seed-to-master | derive --preset scan-js --address-list'

Passphrases: put candidates one per line in a file and use `seed-to-master --passphrase-file`
(the empty passphrase is always tried first), or type one with `seed-to-master --passphrase-prompt`.
Details and `--public-only`: [recipes/derive.md](../recipes/derive.md).

## 4. Your wallet file

Copy it into `./in/`, its password into `./secrets/NAME.pw`, then follow the recipe for its type.
The README has a tested one-liner per type; the recipes add variants, statuses and what is untested:

| File | Recipe |
|------|--------|
| Bitcoin Core / altcoin `wallet.dat` | [input-wallet-dat.md](../recipes/input-wallet-dat.md) |
| Ethereum keystore / presale JSON | [input-keystore.md](../recipes/input-keystore.md) |
| Electrum seed or wallet file | [input-electrum.md](../recipes/input-electrum.md) |
| MultiBit `.key` / bitcoinj `.wallet` | [input-multibit.md](../recipes/input-multibit.md) |
| Armory `.wallet` | [input-armory.md](../recipes/input-armory.md) |
| Seed phrase (BIP39, missing words) | [input-seed-phrase.md](../recipes/input-seed-phrase.md) |
| Don't know | [input-unknown.md](../recipes/input-unknown.md) |

Statuses you will see: `ok`, `wrong_password`, `unsupported`, `bad_input`, `no_candidates`
([REFUSALS.md](REFUSALS.md)).

## 5. Before moving funds

Sweeps are exercised end to end only against a **mock** chain (`scripts/e2e-local.sh`). Read
[goal-sweep.md](../recipes/goal-sweep.md) and SECURITY.md, and check the destination on screen,
before pointing `--url` at a real network.

## Next

- Cookbook: [cookbook.md](cookbook.md) → [recipes/README.md](../recipes/README.md)
- Stuck? [troubleshooting.md](troubleshooting.md)
- Library / wasm: [library-api.md](library-api.md), [../bindings/wasm/README.md](../bindings/wasm/README.md)
