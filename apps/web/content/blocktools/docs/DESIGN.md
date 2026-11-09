# blocktools: design

> **⚠️ DANGEROUS: use at your own risk.** Code that handles keys and signs transactions
> should always be read and audited by you before you trust it with real funds.
> **Used incorrectly, it can destroy your money**: signing to a wrong address, paying a
> huge fee, losing keys, or sending on the wrong chain. You are responsible for verifying
> every transaction. It opens hostile wallet files and extracts secrets, so run it only
> sealed and offline (`./blocktools run`, `--network none`). The unit tests are evidence,
> not a substitute for your own review. See [docs/SECURITY.md](docs/SECURITY.md).


blocktools is a set of small Unix command-line tools that recover keys from old
wallet files and sign transactions. The tools run inside a sealed, offline
container. It ships tools only: it is not an agent and not an MCP server.
It is a companion to [SwapChan](https://swapchan.com), which never holds keys.

## 1. Model: the tools print keys, the boundary filters them

Every tool is an ordinary Unix filter. It reads files or stdin, does one job,
and writes **JSON lines** to stdout. Tools print secrets (mnemonics, WIF,
private keys), because printing them is the job, for a human or the next tool in
the pipe. Tools do not police their own output.

The rule that **the agent never sees secrets** is enforced at one boundary:

```
host (agent)                         sealed container (--network none)
-----------                          ---------------------------------
./blocktools run '<pipeline>'  --->   sealed-run agent '<pipeline>'
                                       runs tool | tool | tool itself (NO shell),
                                       tool stderr -> null, last stdout -> redactor
                                                                   ---> stdout to the agent
./blocktools reveal '<pipeline>' -->  sealed-run human: needs a TTY + typed one-time code,
   (T at a terminal)                   writes raw output to /dev/tty only
```

* `sealed-run` is a Rust program, not a shell script. It parses `a args [< file] | b args`
  (whitespace tokens, shell metacharacters rejected), runs only allowlisted tools that sit
  next to it, with an empty environment, and applies the `redact` filter in-process.
  The reference image has no shell at all, so there is nothing to inject into.
* The redactor (`redact` / in `sealed-run`) is the only thing whose output reaches the agent. It keeps only
  allowlisted fields, each with a strict validator (§3). A line that fails any
  check is dropped completely. It ends with a summary line (kept/dropped counts).
* Tool stderr is discarded. Raw output is never written to disk, not even tmpfs.
* Leak tests target `redact` and the end-to-end agent view
  (`crates/schema` tests, `scripts/e2e-local.sh`), not the individual tools.

## 2. Threat model

| Threat | Mitigation |
|---|---|
| Agent (LLM) context leaks keys (logs, prompt injection, transcripts) | Agent only gets `redact` output; allowlist + validators + leak scan |
| Hostile wallet files / filenames carrying instructions | Treated as data only; bounded reads; no eval/pickle/shell-outs in tools; filenames never interpreted |
| Hostile KDF params (CPU/memory DoS) | scrypt bounded by memory (128·N·r ≤ 256 MiB) and work (N·r·p ≤ 2^24), not per-knob, so geth standard, geth --lightkdf (N=4096 p=6) and the Web3 spec vector (N=2^18 r=1 p=8) open; PBKDF2 ≤ 10M iterations; container memory/pids/CPU limits |
| Exfiltration over the network | `--network none`; no network tools in the image; no network code in tools |
| Container escape / privilege | non-root uid 10001, `--cap-drop ALL`, `no-new-privileges`, read-only rootfs, noexec tmpfs |
| Persistence of secrets on disk | `/in` and `/secrets` are tmpfs filled over stdin (no bind mount, no volume); the rest of the writable space is tmpfs; inputs are root-owned 0444 in 0555 dirs, so uid 10001 (no capabilities) cannot change them; `--log-driver none` |
| Blind signing / tampered unsigned tx | `tx-verify` decodes inside the container; human confirms on the TTY (§6) |
| Password in agent context, argv or env | Passwords come only from a read-only file in `/secrets` or a `/dev/tty` prompt |
| Agent runs `reveal` | `reveal` needs a controlling terminal and a random typed code. **Residual risk:** an agent that can spawn a pty can satisfy this (scripts/e2e-only/tty-drive.py does). Optional terminal pinning (`sealed-run pin-tty`) refuses other sessions but is defeated by a same-user agent that rewrites the pin; see SECURITY.md |

Out of reach: a compromised Docker host (Battleaxe) or kernel, or a human who
pastes keys into chat.

## 3. Agent-facing schema (enforced by `redact`)

One JSON object per line, at most 512 bytes (boundary test, docs/CLAIMS.md redact-512). Allowlisted fields:

| field | validator |
|---|---|
| `tool` | enum of blocktools tool names |
| `status` | enum: ok, checksum_ok, checksum_fail, no_candidates, too_many_candidates, bad_input, wrong_password, unsupported, error, done (**required**) |
| `kind` | enum: p2pkh, p2sh-p2wpkh, p2wpkh, p2tr, eth |
| `address` | base58 `1…`/`3…`, bech32/bech32m `bc1…`, or `0x` + 40 hex |
| `path` | `m(/N'?){0,8}` |
| `candidate`, `count`, `index`, `changed_words`, `line` | integer ≤ 1e9 |

Unknown fields are dropped. A listed field that fails its validator drops the
whole line. Then the serialized line is scanned and dropped if it contains a
64-hex run, `xprv/yprv/zprv/tprv…`, a WIF-shaped string, or 3+ consecutive
BIP39 words. Txids (64 hex) are blocked on purpose until phase 2 adds a typed
`txid` field.

## 4. Tools (one job each)

| tool | in | out (raw, may contain secrets) | phase |
|---|---|---|---|
| `seed-repair` | phrase on stdin | `{status:checksum_ok, candidate, changed_words, mnemonic}` | 1 ✅ |
`pw-candidates` expands a token list into a bounded set of password guesses (case/swap/digit/typo) for piping into the existing openers; see docs/ROADMAP-PARITY.md.
| `seed-to-master` | stdin JSON lines: optional `{passphrase}`, then `{mnemonic, candidate}` | `{candidate, scheme, xprv, seed}`; old Electrum 1.x seed: `{scheme:electrum-old, seed}` (no xprv) | ✅ |
| `phrase-to-key` | stdin phrase lines or `{phrase, salt}` | `{line, scheme, private_key}`: sha256 brainwallet (brainwallet.org, bitaddress.org) and WarpWallet (scrypt+PBKDF2); pipe into `key-to-addresses` | ✅ |
| `utxo-set` | `--dump` a Core `dumptxoutset` file; stdin addresses or scriptPubKeys | `{query, chain, script, status: funded/empty, value_sat, outputs, bloom}`; crate `blocktools-utxo` (dump parser for Core 25-27 and 28+, exact sorted set, bloom filter in front) |
| `wallet-finder` | `--dump` as utxo-set; stdin free text | per funded address `{status, scheme, passphrase, kind, address, value_sat, outputs}`: lines, sentences and word windows (plus pw-candidates rules) as brainwallet candidates, five shapes each; never a key, never signs |
| `derive` | stdin JSON lines `{xprv, seed?, candidate}`; public flags (see `--help`) | `{chain, kind, path, address, wif / private_key}`; `--explain` plan only | ✅ |
| `read-file` | file names in argv (public paths) | file bytes (like `cat`, 64 MiB cap, boundary test) | ✅ |
| `sealed-run` | `agent`/`human` + pipeline | redacted lines / raw to `/dev/tty` | ✅ |
| `keystore-open` | stdin: line 1 = password, rest = keystore JSON (or `--password-tty`) | `{kind:eth, address, private_key}` | 1 ✅ |
| `redact` | raw lines | public lines only | 1 ✅ |
| `dat-read` | Bitcoin Core `wallet.dat` (BDB/SQLite, bounded own parser, no libdb) | account xprvs + bare keys | done (M2) |
| `electrum-open`, `multibit-open`, `armory-open` | respective formats | keys, addresses | 2 |
| `utxo-match` | addresses + UTXO JSON file (from host) | matched address/amount | 2 |
| `tx-verify` | unsigned PSBT/tx file | plain summary: inputs, outputs, fee, change | 2 |
| `tx-sign` | PSBT + key stream + confirmation | signed raw tx hex | 2 |

Composition example (in the container): `seed-repair < /in/seed.txt | seed-to-master | derive --count 5`.

**seed-repair algorithm (phase 1):** lengths 12/15/18/21/24. Unknown words → words
within edit distance 2 or sharing the 4-letter prefix (BIP39 words are unique by
4 letters). Searches combinations, capped at 200k, and keeps the ones whose
BIP39 checksum is valid. If every word is known but the checksum fails, it tries
adjacent swaps, then each single-word substitution. Phase 2: missing word
positions and wordlists in other languages.

**derive: plan, then walk.** Flags and presets build a *plan* of
(chain, address type, path template) families plus account/change/index ranges.
The plan contains no key material and `derive --explain` prints it without reading
stdin. The plan is then walked for every master key on stdin. Flags carry **public
parameters only**: chain, coin type, purpose, ranges, templates, address types,
compression, curve, gap limit, and a file of *public* target addresses
(`--match`, which prints only hits together with the path that produced them, so
the output answers "which path made this address?"; `--stop-on-match` ends the walk after the first hit). Passphrases are never flags;
they reach `seed-to-master` as a stdin JSON line. Templates are validated before
use (placeholders `{purpose} {coin} {account} {change} {i}`, must parse as a
BIP32 path, max 96 chars). Hard caps: 1M entries per range and 5M derivations per run
(`too_many_candidates`). Duplicate (path, chain, kind) rows are emitted once.
Presets (`--list-presets`): common, exhaustive, recovery, exodus, tronlink,
ledger-live, legacy-hd. See recipes/derive.md. Ed25519 (Solana, Stellar) paths must be
all-hardened (SLIP-10) and need the `seed` field from seed-to-master. Stellar (`xlm`, SEP-0005
`m/44'/148'/{i}'`): address = StrKey G (version 6<<3), secret = StrKey S (18<<3), base32 +
CRC16-XModem LE (chains::strkey_encode/strkey_decode). KATs: SEP-0005 vector 1 (crates/secrets/tests/xlm.rs). Cosmos Hub (`atom`, Enc::Cosmos{hrp}):
secp256k1 `m/44'/118'/0'/0/{i}`, address = plain bech32(hrp, hash160(compressed pubkey)),
secret = 32-byte hex `private_key`. KAT: cosmjs Secp256k1HdWallet default address. Algorand (`algo`, Enc::Algo): native 25-word
mnemonic only (BIP39 English words, 11-bit little-endian packing, checksum word = sha512/256(key)
bits 0..10; core feature `algo`), address = base32(pub || sha512/256(pub)[28..]); not derived
from BIP39 seeds (derive skips it, like Monero). KAT: py-algorand-sdk test mnemonic/address. Polkadot (`dot`, Enc::Ss58{prefix:0}, core feature
`sr25519` = schnorrkel): mini-secret = PBKDF2-HMAC-SHA512(BIP39 entropy, "mnemonic", 2048)[..32],
sr25519 Ed25519-mode expansion, root account only (no `//hard` paths), SS58 checksum =
blake2b-512("SS58PRE"||prefix||pub)[..2] (blake2b moved from tx to core). key-to-addresses takes
the mnemonic; native mnemonics are only expanded on their own chain. KAT: subkey docs vector.
Cardano (`ada`, Enc::Ada, core feature `cardano`): Icarus master = PBKDF2-HMAC-SHA512(passphrase,
salt = BIP39 entropy, 4096, 96) clamped; BIP32-Ed25519 V2 children (kL += 8*zL[..28], kR += zR,
public = kL*B unclamped via curve25519-dalek); CIP-1852 m/1852'/1815'/0'/0/i payment, 0'/2/0 stake;
mainnet base address header 0x01 || blake2b-224(pay) || blake2b-224(stake), long bech32 (own
encoder, no 90-char cap). key-to-addresses --chain ada from the mnemonic. KAT: bip_utils + pycardano docs.
TON (`ton`, Enc::Ton, core feature `ton`): native 24-word mnemonic, entropy = HMAC-SHA512(phrase, ""),
seed-version check PBKDF2(entropy, "TON seed version", 390)[0]==0, key = PBKDF2(entropy, "TON default
seed", 100000)[..32] ed25519. Address = sha256 cell hash of the wallet v4r2 StateInit (code hash
feb5ff68..., depth 7; data seqno 0, subwallet 698983191, pubkey, empty plugins), base64url with tag
0x51/0x11 and CRC16-XModem. BIP39-valid phrases are never treated as TON. KAT: tonsdk-generated test phrase.
Old Electrum 1.x seeds (12/24 words from the 1626-word list in `blocktools-core::electrum_old`, or the 32/64-hex seed): `seed-to-master` prints `scheme electrum-old` plus the hex seed, and `derive` walks the non-BIP32 keys (secexp = sha256 stretched 100,000x, key = secexp + sha256d("i:change:" || mpk), uncompressed P2PKH, btc only; `blocktools-secrets::electrum_old`, shared with electrum-read). KAT: Electrum `test_electrum_seed_old`. Brainwallets: `phrase-to-key` (sha256 of the phrase bytes; WarpWallet scrypt N=2^18 r=8 p=1 XOR PBKDF2-HMAC-SHA256 65536, `blocktools-secrets::brain`; KATs: the xkcd phrase, keybase/warpwallet spec.json). (`seed-to-master --passphrase-prompt` is built: /dev/tty, echo off via blocktools-tty.)

## 5. Passwords and passphrases

Interactive alternative: `--passphrase-prompt` / `--password-tty` read from `/dev/tty` with echo off (blocktools-tty); never argv or env.

Passwords and passphrases arrive on **stdin**, as data in the stream. The human
puts them in `$BLOCKTOOLS_SECRETS` (read-only at `/secrets`, host dir chmod 700,
git-ignored; `./blocktools` streams the directory as tar on stdin into a tmpfs `/secrets` inside the sealed
container: no bind mount, no volume, nothing on the engine's disk; the tmpfs goes with the container on exit.
tmpfs is RAM of the engine's VM/host and could be swapped out by it; that is the remaining exposure), and the pipeline feeds them in, e.g.
`read-file /secrets/ks-password /in/ks.json | keystore-open`. The tool itself never
opens a named file. The only other source is `keystore-open --password-tty`, a
prompt to the human on `/dev/tty`. Nothing is ever read from argv or env.
Values are zeroized after use (`zeroize`).

## 5a. Pipe principles

1. **Utilities, not a server.** blocktools is separate Unix programs, not an MCP
   server. Each does exactly one thing, keeps no hidden state, and is named for
   what it does: one reads DAT files (`dat-read`, phase 2), one opens JSON
   keystores (`keystore-open`), one repairs recovery phrases (`seed-repair`).
   Each takes its format in and gives its format out (JSON lines).
2. **stdin and stdout only.** Secrets and outputs travel only through stdin and
   stdout: never environment variables, never file names, never argv. Output is
   always on stdout. Files reach a tool only via shell redirection
   (`< /in/x`, `read-file a b |`) in the pipeline script. The tool sees a stream,
   not a path. argv carries only non-secret options (`--count 5`).
3. **A half-complete pipe leaks secrets. A complete pipe emits only the intended output.**
   Complete pipe: `wallet file → master key → derived key → signed transaction`.
   The secret never leaves the pipe and only the signed tx comes out. So a
   recovery utility may output only a master key, with derivation as a second
   utility piped after it. Cutting the pipe early (stopping after `derive`) prints
   keys, which is fine for a human at a terminal and never shown to the agent.
4. **Agent workflow.** The agent writes a short script that chains the utilities,
   runs it with `./blocktools run '<script>'`, and gets back only the final
   output. `redact` still filters everything the agent sees (§3), so even a
   half-complete pipe written by mistake shows the agent only addresses, paths
   and statuses.

### Conformance audit (phase 1 code)

| Place | Status |
|---|---|
| `seed-repair` | ✅ stdin only (`--in FILE` removed) |
| `derive` | ✅ stdin only (`--phrase-file`, `--passphrase-file` removed; passphrase is a `{"passphrase":…}` line) |
| `keystore-open` | ✅ stdin only: line 1 = password, rest = keystore (`--in`, `--password-file` removed) |
| `sealed-run` agent mode | ✅ no longer tees raw output to a tmpfs file; tool stderr is discarded |
| **Deviation:** `keystore-open --password-tty` | Reads the password from `/dev/tty`, a human side channel, not stdin. Kept for typing passwords that are never stored. To decide: keep, or require stdin only (human pipes `cat /dev/tty` themselves). |
| Split done | `seed-to-master` (phrase → master xprv) and `derive` (xprv → child keys + addresses). `derive` output is still a half-complete pipe; `tx-sign` completes it. |
| **Deviation:** `sealed-run`/`blocktools` take the pipeline script via argv | The script is agent-written public text, never a secret. Alternative: feed the script on stdin. |
| **Deviation:** passwords staged as files in `/secrets` | The human stores them, and the tool still receives them via stdin. Alternative: a dedicated fd (e.g. `3< /secrets/pw`) if mixing with data on stdin proves awkward. |
| `read-file` takes file names in argv | Paths are public; the file *contents* go to stdout. This replaces shell `cat` in the shell-less image. |

## 5b. Minimal dependencies

Each utility depends on as few crates as possible: ideally one cryptography
library and little else. Non-crypto helpers (hex encoding, output JSON lines,
address/path validators, leak scanner) are plain std code. Crypto primitives (hashes,
ciphers, KDFs such as scrypt/PBKDF2, curves, signatures) are never hand-rolled: they come from
RustCrypto / secp256k1 / dalek crates. In-tree code only composes them as a wallet format
specifies (e.g. Armory ROMix over SHA-512, Electrum seed-version HMAC) and each composition is
pinned by known-answer tests. `scripts/check-deps.sh` (also run in the Docker build) fails
if any crate's dependency tree gains a crate not listed in `deps/<crate>.allow`.

Measured with `cargo tree -e normal` (unique crates excluding the crate itself):

| crate | before: direct / total | after: direct / total | direct deps now |
|---|---|---|---|
| seed-repair | 12 / 52 | 1 / 8 | bip39 |
| seed-to-master | (new) | 4 / 21 | bip39, bitcoin, zeroize, serde_json |
| derive | 12 / 52 | 4 / 25 | blocktools-core (bitcoin, sha3, zeroize), serde_json — no bip39 any more |
| sealed-run | (new) | 1 / 13 | blocktools-schema |
| read-file | (new) | 0 / 0 | std only |
| keystore-open | 12 / 52 | 9 / 27 | secp256k1, sha3, scrypt, pbkdf2, sha2, aes, ctr, zeroize, serde_json |
| blocktools-schema | 4 / 21 | 2 / 12 | bip39 (wordlist), serde_json |
| redact | 2 / 22 | 2 / 13 | blocktools-schema, serde_json |

Removed: `regex`, `hex`, `serde` (derive), and every unused crate the tools had
inherited. Justification for what stays:

* **bip39**: BIP39 wordlist, checksum, PBKDF2-HMAC-SHA512 seed (rust-bitcoin project).
* **bitcoin** (derive only): BIP32, address encodings incl. bech32m/taproot tweak, WIF; brings secp256k1 (libsecp256k1).
* **secp256k1** (keystore-open): public key from private key for the ETH address, without all of `bitcoin`.
* **sha3**: Keccak-256 for ETH addresses and keystore MAC (not in the rust-bitcoin stack).
* **scrypt, pbkdf2, sha2, aes, ctr** (keystore-open): the Web3 v3 keystore KDFs and cipher, all RustCrypto.
* **serde_json**: parsing *hostile* JSON input (keystore files, pipe input in derive/redact) must be robust. A hand-rolled parser on untrusted input is a bigger risk than one well-fuzzed crate. Output JSON is hand-written.
* **zeroize**: wiping secrets from memory.

Deferred (to decide):
* **One crypto family.** Today there are two: rust-bitcoin (bip39/bitcoin/secp256k1)
  and RustCrypto (sha3, scrypt, pbkdf2, sha2, aes, ctr). One option is RustCrypto
  only (`k256` + `bip32` crates + own address encoding), which drops libsecp256k1's
  C code but replaces a very widely audited library. The other is rust-bitcoin
  only, but it has no Keccak, scrypt or AES, so keystore-open still needs RustCrypto.
* **Dropping serde_json** with a minimal bounded JSON-lines reader shared by the
  tools: possible, but deferred because it means a hand-written parser of hostile input.
* `cargo-deny` (license/advisory checks) is not installed. The allowlist script
  covers growth only.

### libc (single exception, reviewed)
`libc` (0.2, no default features) is used **only** by `crates/tty`, for
`tcgetattr`/`tcsetattr` to turn terminal echo off while a human types a password
or passphrase (`seed-to-master --passphrase-prompt`, `keystore-open --password-tty`)
and to read the typed confirmation code before signing. No other libc calls. If echo
cannot be disabled the prompt refuses (`bad_input`) instead of echoing a secret.
Only the tools that prompt depend on blocktools-tty.

### Network (host-side only)

Only `utxo-fetch`, `tx-broadcast` and `rpc` use the network, through `crates/net`. They are
**not copied into the sealed image** (Dockerfile skips them) and `check-deps.sh` fails if any
other crate pulls in `blocktools-net`, `minreq`, `rustls`, `ring` or `webpki-roots`.

HTTP crate chosen by measured `cargo tree -e normal` (unique crates, 2026-10):

| crate + TLS            | crates |
|------------------------|-------:|
| minreq 2 + https-rustls|     12 |
| ureq 3 + rustls        |     23 |
| ureq 2 + tls           |     49 |
| attohttpc + rustls     |     51 |

`minreq` is the smallest and is what BDK's esplora-client uses (rust-bitcoin maintains a
fork, `bitreq`). Caveat: it pins the older rustls 0.21 line; `ureq` 3 (rustls 0.23) is the
next-smallest and swapping is confined to `blocktools-net`. blocktools-net: https only (plain http only for
localhost test servers), 30 s timeout, no redirects, 8 MiB body cap (net-8mib), server data re-validated. The 30 s default timeout is measured against a slow mock (rpc-timeout-30s).
Tests use `scripts/mock-chain.py` on 127.0.0.1; nothing real is ever contacted or broadcast.

## 6. Transactions: build → decode → confirm → sign → decode → broadcast

Every step is a separate tool. Only `utxo-fetch`, `tx-broadcast` and `rpc` touch the network,
and all run on the host, never in the container.

```
utxo-fetch (host, network)  ->  utxos.json / nonce.json / fees.json   (public data)
tx-build   (offline)        ->  unsigned PSBT  |  unsigned EVM RLP (legacy / EIP-1559)
tx-decode  (offline)        ->  what the exact bytes do (JSON lines, or --text)
human reads the summary; tx-sign shows that SAME tx-decode summary and asks for a TTY code
tx-sign    (sealed)         ->  keys on stdin, signs only the bytes it just decoded
tx-decode  (offline)        ->  on the SIGNED output: same outputs, fee and sender?
tx-broadcast (host)         ->  submit the raw bytes (mock-tested only)
rpc (host, network)         ->  same reads/broadcast for any RPC endpoint; deny-list refuses wallet key methods (docs/RPC.md)
```

**Solana**: legacy, v0 and v1 (SIMD-0385) wire transactions decode and verify; `is_on_curve` is dalek `decompress`, as in the Solana runtime.

**Legacy-input amount proof (security review 2026-10-25).** A legacy (pre-segwit) sighash does not commit to the
amount being spent, so a host that lies about an input's value can make a signer pay a hidden fee (the classic
P2PKH fee attack). Rule, applied to every legacy-sighash family (BTC/LTC/DOGE/BLK/... P2PKH, GRS, PoS-nTime):
an input whose script is not a witness program must carry its full previous transaction. Bare P2SH counts as legacy (it may wrap any legacy script) unless the utxo line / PSBT carries a `redeem_script` that is a witness program hashing to the address (wrapped segwit, BIP143); tx-sign also accepts P2SH it can prove as its own key's P2SH-P2WPKH.
`utxo-fetch` adds `prev_tx` (raw hex) for such inputs; `tx-build` refuses without it (`legacy_input_needs_prev_tx`)
or when its txid (chain digest: GRS single SHA-256) or output disagrees with the claimed amount/script; the PSBT gets
`non_witness_utxo`, PoS envelopes get `pos_prevouts[i].prev_tx`. `tx-decode` reports `unproven_inputs`; `tx-verify`
fails with `legacy_input_amount_unproven` (not waivable by `--allow-warnings`); `tx-sign` refuses to sign such an
input. Zcash (ZIP-243/244) and forkid chains (BCH/BSV/BTG) commit to amounts in the sighash, so a lying amount only
produces an invalid signature; the PSBT check still applies to them.

**Swap-deposit PSBTs** (`buildPsbtWithMemo`) follow THORChain's UTXO output order: vault, change, then OP_RETURN memo (optional). Default non-RBF (nSequence 0xffffffff; THORChain inbound must not be RBF); `rbf` opts in.

**Interchange format.** Bitcoin-family transactions use PSBT (BIP-174). A watch-only host
builds; an offline machine signs. EVM uses the unsigned RLP (EIP-155 legacy with a chain id,
or EIP-1559 type 2). Tron txs are decoded (wasm `tronDecodeTx`); a Tron builder is not built yet. Bitcoin multisig is built: P2WSH m-of-n (`multisig`) and a taproot CHECKSIGADD leaf (`taproot-multisig`); cosigners partial-sign offline (`tx-sign --partial`, `secrets` feature only) and `tx-combine` finalizes. The address builders, `combinePsbts` and Plan resolve are also wasm exports; the partial signers are not (wasm-check W-nokey, W-nokeyapi).

**tx-decode** (`crates/tx` library plus the thin `tools/tx-decode`, **built**). The input
format is auto-detected: hex or base64, a raw Bitcoin tx, a PSBT, EVM RLP, or a JSON line
with `psbt`/`tx`/`unsigned_tx`/`signed_tx`. The output is:
- a summary line: chain/type, signed, counts, txid, fee and fee rate (when the input amounts
  are known), locktime, RBF, EVM chain id/nonce/gas/fees/value/to/from (`from` is recovered
  from the signature), and ERC-20 `transfer`/`approve`/`transferFrom` with token, recipient
  and amount;
- one line per input/output: outpoint, address, kind, amount;
- warnings, from a fixed vocabulary: `high_fee`, `high_fee_pct`, `high_fee_rate`,
  `input_amounts_unknown`, `dust_output`, `nonstandard_output`, `op_return_output`,
  `locktime_set`, `unsigned`, `partially_signed`, `utxo_txid_mismatch`, `no_chain_id`,
  `contract_creation`, `high_gas_price`, `token_approve`, `unlimited_approve`,
  `token_transfer_from`, `unknown_calldata`, `bad_signature`, `no_inputs_or_outputs`.
- The `high_fee` limit scales per started 1,000 vB (`FeeWarn::fee_for`); sweep builders cap fee_rate at `FeeWarn::rate_cap()` = max(2,000, 4 x rate limit) per coin. Wasm outputs add `amount_str`/`fee_str` twins for values above 2^53 (EXPORTS.md).
- QRK amounts are 5-decimal base units (COIN = 1e5), established from mainnet txids.
- `high_fee` / `high_fee_rate` limits are per coin (`chains::fee_warn`, exposed as `chainParams().fee_warn`): 20 x the measured median fee rate, never below the Bitcoin default 1,000,000 / 500. Values and their measured basis: docs/CHAINS.md "Fee-warning limits". Test: crates/tx/tests/fee_warn.rs.

Bitcoin and PSBT parsing is rust-bitcoin's consensus code. RLP is a small bounded codec
(depth 4, 4096 items, canonical lengths). Keccak comes from `sha3` and recovery from
`secp256k1`. Input is limited to 4 MiB (boundary test, tx-input-4mib). In agent mode the line passes `redact`:
amounts, addresses, counts and warnings cross, **txids do not** (a 64-hex value is
indistinguishable from a key, so the boundary drops it). On the host, run tx-decode
directly to see txids.

**tx-build** (**built**). Offline and file-driven: UTXOs, nonce and gas/fee rates are
input files, never fetched. Modes: `--sweep`, `--send AMOUNT`, `--fee-rate`, `--rbf`,
`--consolidate`, `--dust-limit`. Output: a PSBT, or unsigned EVM legacy/1559. ERC-20 sweeps
are two transactions: an explicit, separately confirmed gas top-up from a funding address,
then the token `transfer`.

**tx-verify** reuses `blocktools-tx` and checks the decoded tx against expectations:
outputs equal the expected addresses, change goes to a derived address, the chain id is
right, the fee and fee percentage are under caps, and no unknown outputs exist. Any failure
gives a non-zero exit. EVM: the default total-fee cap is tx-sign's 0.01 ETH. ETH value next to
ERC-20 transfer calldata fails (`eth_value_with_token_call`) unless `--allow-value-with-token`.

**tx-sign** reads keys on stdin and the tx on a second stdin line or `--tx FILE`.
It then:
1. decodes the tx with `blocktools-tx` and **prints the tx-decode `--text` summary on /dev/tty**;
2. refuses if the fee exceeds `--max-fee` (a default cap guards against typo burns) or if
   `--expect-to ADDR` (validated by `blocktools_core::validate`) is not the destination;
3. asks for a random 6-character code typed on the TTY (`blocktools_tty::confirm`);
4. signs exactly those bytes and emits the signed tx.
EVM signing refuses transactions without a chain id. Signing reuses the
`blocktools_tx::evm::Tx::sign` path that already reproduces the EIP-155 example byte for byte.

**SwapChan** stays host-side: `find_money` → UTXO/nonce files for tx-build; `verify_tx`
can double-check tx-decode output before broadcast.

## 7. SwapChan integration (host side only)

The container never talks to SwapChan. Public data (addresses, unsigned
txs, signed hex) moves between the agent's SwapChan MCP tools and the container
as files in `in/` and lines from `redact`.

## 8. Build and run

* `Dockerfile`: build stage `rust:1.85-alpine3.20` pinned by digest (allowlist check, tests,
  build, then `file` on every binary — the build fails unless each is statically linked).
  Runtime stage is `FROM scratch`: only the static tools in `/blocktools`. No shell, no busybox,
  no wget, no libc, no `/etc`.
* `./blocktools build | run '<pipeline>' | reveal '<pipeline>'`, plus `make recover`
  and `make reveal` for one-command use.

### Verified status (2026-10-24, Battleaxe, Docker 29.8.2, linux/amd64)

Measured: the image builds (dependency allowlist check + `cargo test` in the build stage), and the
runtime image built (its size then was not kept; README carries the measured size). Under the full sealing flags: (unmeasured)
* `seed-repair | derive` on the public "abandon … about" vector with typos, through `sealed-run agent`:
  7 lines, only addresses, paths and statuses, with the expected BIP44/49/84/86/ETH addresses.
* `keystore-open` on the Web3 spec vector: only `0x008AeEda4D805471dF9b2A5B0f38A0C3bCBA786b`.
* Leak grep (wif, private_key, mnemonic, abandon, 64-hex) on agent output: 0 matches. The raw tool output
  without the boundary does contain keys, as intended.
* Inside: uid 10001, only `lo` interface, an HTTP connect to 1.1.1.1 fails, DNS fails, `touch /usr/x`
  gives "Read-only file system", executing a binary copied to the tmpfs fails, CapEff=0, NoNewPrivs=1.
* `sealed-run human` without a TTY refuses (exit 3).

Not yet exercised: `./blocktools` itself (its `-v`-style bind mounts resolve on the Docker *host*, so
with a remote context like Battleaxe, `in/` and `secrets/` must exist there; the test above fed data on stdin),
and `reveal` with a real TTY. (The alpine runtime measured above was replaced by `scratch` afterwards; see the
newest verified-status section.)

### Re-verified (2026-10-24, Battleaxe via the Mac docker context, linux/amd64, 32 CPUs, commit 38b386d)

Measured: `docker --context battleaxe build` of 38b386d succeeds in about 2 min (build stage runs the dependency
allowlist check and `cargo test`); the runtime image built (sizes from that period were not kept; README carries the measured size). (unmeasured)
Under the same sealing flags as `./blocktools` (no binds; mnemonic on stdin), through `sealed-run agent`, on the public
"abandon … about" vector:
* `zec-sapling --count 2`: 2 rows, first address = local KAT zs188wzu…f0nta; no mnemonic or zxviews in output.
* `zec-sapling --count 2 --unified`: 2 u1 + 2 t1 rows survive redact; account-0 UA = u1vu0zk…46h7ty (Python reference).
* `key-to-addresses --chain ada`: 5 rows, first = bip_utils addr1qy8ac7…4afdhv. `--chain dot`: 1 row, 13KVd4…Vd7xo.
  Their `private_key` fields come out only as `[REDACTED]`; no 64-hex value, mnemonic, xprv or WIF in output.
* `seed-repair | seed-to-master | derive --count 1`: 5 address rows.
* `sealed-run human` with no TTY refuses (exit 2).
Not re-run this time: the network/rootfs/caps probes (same flags as the earlier run), `reveal` with a TTY, bind-mount
inputs on the remote host.

### Remote engines (BLOCKTOOLS_ALLOW_REMOTE)

Deny by default: an `ssh://`, `tcp://` or `http(s)://` engine (`DOCKER_HOST`, else the current context) is refused
with exit 4 before any container exists. `BLOCKTOOLS_ALLOW_REMOTE=ssh` permits only `ssh://` engines: the inputs
cross the wire inside ssh and land in the container's tmpfs (stdin/tar only, no bind mounts, no volumes), which
is the Mac -> Battleaxe (Docker Desktop on Windows) setup. `BLOCKTOOLS_ALLOW_REMOTE=1` permits any remote engine,
including unencrypted `tcp://`. Any other value permits nothing. Sealing flags are the same in every case.
Covered by `scripts/e2e.d/wrapper-remote.sh` (fake docker); a real ssh engine is not in CI (untested).

## 9. Out of scope

Brute-forcing unknown passwords at scale (GPU cracking), any network access in
the container, holding funds, custody, broadcasting from the container, hardware
wallets, and any key escrow or backup service.

## 10. Roadmap

* **Phase 1 (done):** seed-repair, derive (BIP44/49/84/86, ETH), keystore-open, redact, sealed wrapper.
* **Phase 2 (in progress):** wallet.dat reader; tx-decode/build/verify/sign; Electrum, MultiBit, Armory; utxo-match; typed `txid`/`signed_tx` fields.
* **Phase 3:** password-candidate lists from a human-provided file (bounded), missing-word repair, more chains.
* **Library split:** §11 — logic in crates, thin CLIs, `secrets` feature off by default for SwapChan. Steps in docs/ROADMAP.md L1–L8.

## 11. Library crate (public API for dependents)

Other projects (notably SwapChan) depend on **library code**. Two consumption paths stay open; neither is required to be picked now:

1. **CLI** — spawn the thin stdin/stdout tools (same pipes as humans/agents).
2. **WebAssembly** — `wasm-bindgen` build of the `blocktools` facade (default = public-only features) producing a **TypeScript/npm wrapper** for SwapChan (SwapChan stays TypeScript). Same API; no network and no `secrets` in that build. CI must assert the `.wasm` contains no secrets-feature code (ROADMAP L4b).

The native CLIs remain first-class: each is a thin stdin/stdout wrapper around the library. The sealed Docker image and `sealed-run` / `redact` boundary are unchanged for agent use. WASM is a binding option for host-side consumers, not a second product.

3. **C ABI** — `crates/cabi` (`blocktools-c`, secrets-off): `bt_version`, `bt_chain_table`, `bt_envelope`, `bt_free` (header `crates/cabi/include/blocktools.h`). Shared JSON schema: `blocktools::envelope` / `tx-envelope` (`blocktools.sign/v1` decode|verify|check|chain_table). No private keys. Thin language wrappers: `bindings/{python,go,cpp,zig}` (see `bindings/README.md`). Account-family ops and signing half are follow-on work.

### Crate layout (target)

| crate | role | default features |
|---|---|---|
| **`blocktools`** | **Published facade.** One dependency for consumers. Re-exports the modules below. | public-only (no secret types in the API) |
| `blocktools-core` | chains, path plans, address encode/validate, xpub→address | no private keys |
| `blocktools-tx` | decode, build unsigned, policy/verify | no signing |
| `blocktools-io` | JSON-line emit, `--help` warning | std only |
| `blocktools-schema` | agent allowlist + leak scan (optional dep) | public fields only |
| `blocktools-secrets` (new, or feature modules in core/tx) | seed repair/master, xprv derive, keystore/DAT/Electrum parsers, `tx::sign` | **off unless `secrets` feature** |
| `blocktools-tty` | echo-off prompts | only CLIs that prompt |
| `blocktools-net` | host HTTP for utxo-fetch / tx-broadcast / rpc | never in sealed image |

Internal crates live under `crates/{core,tx,io,schema,tty,net}` with package names `blocktools-*`; tools keep plain job names (no prefix). The local checkout path may differ. The **published name** consumers depend on is `blocktools`.

### Feature flags (on the `blocktools` facade)

| feature | default | compiles |
|---|---|---|
| *(none / default)* | yes | address validate, path plan, xpub→addresses, tx decode/build/policy, classify fingerprints |
| `secrets` | **no** | BIP39/Electrum seed→master, xprv/seed derive (WIF/hex out), keystore/DAT/Electrum/MultiBit/Armory open, `tx::sign` |
| `ed25519` | no | Solana / SLIP-10 (same as today) |
| `schema` | no | `redact` allowlist helpers (SwapChan usually does not need this) |
| `net` | no | never pulled by sealed tools; host-only |

A public-inputs-only consumer (`SwapChan`) depends on `blocktools` with default features and **never compiles** secret-handling code. Offline CLIs that print keys enable `secrets` (and `ed25519` when needed). `check-deps.sh` allowlists stay per-crate; the facade's default tree must not grow a secrets crate.

### Public API shape (stable surface for SwapChan)

Types are owned by the library; CLIs only parse argv/stdin and print JSON lines.

```text
blocktools::address
  validate(chain, addr) -> Result<AddrKind, Error>
  eth_checksum([u8;20]) -> String
  script_to_address / address_to_script  (BTC-family)

blocktools::plan
  Spec, Ranges, preset(name), expand(template, …)
  explain(flags) -> Plan          // no key material; same as derive --explain

blocktools::derive          // default: public keys only
  from_xpub(xpub, plan) -> Vec<AddressRow>   // address, path, kind, chain — no secrets
  // with feature = "secrets":
  from_xprv(xprv, plan) -> Vec<KeyRow>       // + wif / private_key
  from_seed(seed32, plan) -> Vec<KeyRow>     // ed25519 paths need this

blocktools::tx
  decode(bytes_or_text, utxo_chain) -> Decoded
  Decoded { chain, kind, signed, inputs, outputs, fee, warnings, … }
  policy::Policy { expect_to, max_fee, max_fee_rate, change, chain_id, … }
  policy::check(&Decoded, &Policy) -> Vec<&'static str>
  build::btc(…) / build::evm(…) -> unsigned PSBT or RLP bytes

  // with feature = "secrets":
  sign::psbt / sign::evm(…) -> signed bytes   // still requires human confirm at CLI

blocktools::classify   // public fingerprints only
  scan_line(text) -> { kind, line, fingerprint }  // never echoes the secret

// feature = "secrets" only:
blocktools::seed::repair / to_master
blocktools::keystore::open_v3
blocktools::wallet::{dat_read, electrum_open, …}
```

Errors are plain enums/`&'static str` today; a single `blocktools::Error` can wrap them later without pulling anyhow. No async, no HTTP in the default tree, no Tokio.

### Implemented (2026-10-24)

Steps L1–L6 are in. What exists today (names are the real ones; the sketch above is the target):

| crate | default build | with features |
|---|---|---|
| `blocktools` (facade, `crates/blocktools`) | re-exports `chains`, `plan`, `validate`, `xpub`, `b64`, `hex_enc/dec`, `eth_address_from_pubkey`, and `tx` (`build`, `evm`, `policy`, `rlp`) | `secrets` → `blocktools::secrets`, `tx::sign`, key rows; `ed25519`; `schema`; `net` |
| `blocktools-core` | `chains::{AddrRow, pub_rows, sol_address}`, `xpub::from_xpub`, `plan::{from_args, explain, preset, expand, …}`, `validate` | `secrets`: `Row`, `secp_rows`, `derive_chain`, `derive_account`, `eth_address(sk)`, `slip10_ed25519` |
| `blocktools-tx` | `build::{build_btc, build_evm, parse_utxos}`, `evm::Tx::{parse, encode_*, from}`, `policy` | `secrets`: `sign`, `evm::Tx::sign` |
| `blocktools-secrets` | (nothing without a feature) | `repair` (BIP39 typo repair), `seed` (BIP39/Electrum → master), `dat` (wallet.dat BDB/SQLite), `keystore` (Web3 v3), `keys` (raw key decodings, signing-key lines), `walk` (plan × master → key rows) |

`blocktools-secrets` has one feature per area so each CLI links only the crypto it uses (e.g.
`seed-repair` pulls `repair` = bip39 only; `keystore-open` pulls scrypt/aes-ctr but not cbc).
Every CLI enables what it needs explicitly; `check-deps.sh` fails if `blocktools`,
`blocktools-core` or `blocktools-tx` with default features reach `blocktools-secrets`, bip39,
scrypt, pbkdf2, aes/cbc/ctr, or any network crate. KATs: `crates/blocktools/tests/public.rs`
(default features) and `tests/secrets.rs` (`required-features = ["secrets"]`) call the library
directly; per-module KATs live beside the code. `classify` lives in `blocktools-core::classify`; Electrum, MultiBit/bitcoinj and Armory wallet readers live in
`blocktools-secrets` (features `electrum`, `multibit`, `armory`), not in the default-feature facade.

### WebAssembly / npm (L4b, 2026-10-24)

`bindings/wasm` (crate `blocktools-wasm`, its own Cargo workspace so native builds never compile
wasm-bindgen) wraps the facade with **default features** and exposes `validateAddress`,
`listChains`, `addressesFromXpub`, `explainPlan`, `decodeTx`, `describeTx`, `verifyTx` (JSON
strings out). Added deps: `wasm-bindgen =0.2.100` only (plus the `lowmemory` feature on the
already-present secp256k1, which shrinks libsecp256k1's tables). `scripts/wasm-check.sh` builds
it, runs wasm-bindgen (`pkg/node`, `pkg/web`), and fails if the dep tree has any secrets/net/seed
crate, if the name section contains secret APIs (blocktools_secrets, tx::sign, WIF/xprv/seed
code, libsecp256k1 signing/keygen), or if exports differ from the public list, then runs
`bindings/wasm/test.mjs` (public vectors) under Node. It is a single self-contained wasm file (run
`scripts/wasm-size.sh` for its current size, gzipped size, and wasm32 crate count). The module also
exports four libsecp256k1 context hooks (`rustsecp256k1_v0_10_0_context_*`, error callbacks)
that secp256k1-sys marks `#[no_mangle]`; they are not secret-bearing. Build needs clang
(secp256k1-sys C code) and the wasm32-unknown-unknown target. Not published to npm.

### CLI contract (unchanged for humans/agents)

Each `tools/*` binary:
1. `blocktools_io::help(USAGE)` for `--help`
2. parse public flags
3. read stdin (and `/dev/tty` only where DESIGN §5 already allows)
4. call one library function
5. `outln!` JSON lines

No business logic left in `main` beyond argv and I/O. Composition stays `a | b | c`.

### Migration steps

See [docs/ROADMAP.md](docs/ROADMAP.md) rows **L1–L8**. Order of work: freeze the public modules → move remaining tool-local logic into crates → add `secrets` feature gates → introduce the `blocktools` facade → thin the CLIs → point SwapChan at the facade with default features → rename crates/docs when ready.


## Chain table and stable wasm API (2026-10-24)

The chain rows are data (`chains.rs`: version bytes, hrp, SLIP-44, Sign quirk, `verified`, sources); see docs/CHAINS.md. Unverified rows are not supported by derive, validate, tx-build or the wasm stable API. The stable JS/Rust API is listed in EXPORTS.md; `checkTx` is fail-closed and takes public inputs only.

## Coins: detect, convert, sweep per tx format (2026-10-24)

`address::detect` returns every candidate chain and never picks one; `convert` refuses `ambiguous_address` when candidates read the same bytes as different script types. The table carries decimals, checksum, forkid and tx_format. `sweep::build_unsigned_sweep` builds the `legacy`, `legacy-sha256` and `forkid` formats, plus `pos-ntime` via `build_unsigned_sweep_at` (needs a tx time); `zcash-v5` builds a transparent v5 sweep (see Zcash below).

## Non-Bitcoin-family chains are their own crates (2026-10-24)

Monero is `crates/monero` (blocktools-monero). The default `keys` feature carries curve25519-dalek for seed→keys and the on-curve check. `blocktools-core` (classify) uses it with `default-features = false`, so every other binary gains only wordlist + base58 + keccak, no curve or proc-macro crates. Classify adds `monero_seed` (25 words from the 1626-word English list, 3-letter prefixes) and `monero_address` (standard 69-byte addresses; integrated and subaddresses are refused for now). The chain table has an `xmr` row (`Enc::Xmr`): address validation goes through blocktools-monero, and the BIP32 presets skip it because Monero keys come from its own seed, not paths. `xmr-keys --scan-out` writes the view-only wallet-rpc `generate_from_keys` request to a new 0600 file. The private view key is secret (it reveals incoming funds), so it never goes to stdout or stderr. Sweep is designed but not built: see docs/monero-sweep-design.md.

## XRP Ledger (2026-10-24)

`crates/xrp` (blocktools-xrp) has:
- its own Ripple-alphabet base58;
- family seeds, both secp256k1 (root plus account-0 tweak) and ed25519 (sha512half of the seed);
- classic and X-addresses (XLS-5d);
- a Payment-only binary codec. Fields are written in canonical (type, field) order, and any other field is refused on decode.

Signing uses `STX\0`. secp256k1 signs sha512half of it with RFC6979, low-S and DER. ed25519 signs the bytes directly. The txid is sha512half(`TXN\0` || blob).

`xrp-tx` is the CLI. `sign` needs `--expect-to` and a typed code on /dev/tty, and it warns when the destination tag is missing. Core only gets `is_xrp_seed` and X-address validation, written against its existing base58, so classify does not pull in ed25519.

## Account-model payments (blocktools-acct, acct-tx)

`crates/acct` builds one transfer per chain in that chain's native encoding (base64 on the CLI): Stellar
TransactionEnvelope v1 XDR (one native Payment or AccountMerge; signature over sha256(sha256(passphrase) || 2 || tx)),
Algorand canonical msgpack `pay` (signature over "TX" || msgpack; txid = base32(sha512/256)), Cosmos Hub MsgSend
(SignDoc protobuf, secp256k1 RFC6979 low-S over sha256(SignDoc), txid = sha256(TxRaw)). TON wallet v4r2 external message (tonsdk layout: body inline, one internal transfer, BOC crc32c without index; signature over the signing cell hash; strict decode re-encodes and compares). Cardano (`ada`): Shelley body {inputs, outputs, fee, ttl}, vkey witness by BIP32-Ed25519 extended key, == pycardano bytes; native assets NOT BUILT. Polkadot (`dot`): Asset Hub extrinsic v4, sr25519 (deterministic witness), payload == py-substrate-interface; UNVERIFIED (no official vector). Decoders accept only that
subset and refuse anything else (muxed accounts, other assets, rekey/lease/group, msig). Algorand decode also re-encodes
and refuses non-canonical input. `acct-tx sign` needs `--expect-to`, refuses an already-signed tx, checks the key
matches the source, and signs only after the typed code on /dev/tty. Balance and sequence come from host-side `utxo-fetch --chain xlm|algo` (blocking
blocktools-net, no Tokio); acct-tx itself has no network crate. KATs: tests/kat.rs, byte-equal to the chains' own SDKs.

## Recipes are executable documentation

`recipes/*.md` are the user manual. Each example marked with `<!-- e2e: expect=..; rc=..; fund=.. -->` is run exactly as written by
`scripts/recipe-check.py` (in e2e). `./blocktools run '...'` goes through `sealed-run agent`, and `recipes/recover.sh` runs against the mock
chain. The checker also makes sure stdout holds no secret (the LEAK regex plus the literal secret values of the generated vectors). Vectors are made at test time, so
nothing secret-shaped is committed. A recipe with no tested example fails the build. The schema allowlist now admits
`xpub-addresses`, `xmr-keys` and `xrp-tx` lines, and 95-char Monero standard addresses (prefix 4/5/9). Every other long base58 string is still dropped.

## Electrum 1.x

electrum-read parses the Python-literal file (`py_to_json`), decrypts the seed (the same AES-CBC/sha256d scheme as 2.x), and derives the old-scheme
keys in blocktools-secrets. The derived master public key must equal the file's `master_public_key`. This doubles as the wrong-password
check, and nothing is emitted unless it matches. Output lines are derive-shaped (`wif`, `address`, `path m/change/i`), so tx-sign takes them directly.

## Groestlcoin (2026-10-24)

`grs` is a normal UTXO row with two chain-specific digests, both keyed off the row (no new struct field):
`Chain::ck()` picks the base58 checksum (`Ck::Groestl` = first 4 bytes of groestl512(groestl512(x))) for addresses
and WIF, and `Sign::Sha256Single` / `blocktools_tx::digest::Digest::Sha256` makes the txid and the legacy and
BIP143 signature hashes single SHA-256 (source: groestlcoinjs-lib src/transaction.js). rust-bitcoin's sighash
cache hardcodes sha256d, so `digest.rs` reuses its legacy encoder (`legacy_encode_signing_data_to`, which
keeps the SIGHASH_SINGLE bug) and carries its own BIP143 encoder, SIGHASH_ALL only. Taproot (2026-10-25): grs1p addresses are derived (bech32m, hrp grs; the tweak is BIP341's, and Groestlcoin's src/test/data/bip341_wallet_vectors.json is byte-identical to Bitcoin's), but GRS taproot inputs are still refused at signing. Extended keys: Electrum-GRS/eclair-grs put the Groestl checksum on xpub/tpub too; `xpub::normalize_ck` converts it to sha256d before parsing, so a GRS xpub works only with `--chain grs` and a sha256d xpub is refused there.
`digest` is a public, key-free module (the decoder needs the txid), so it builds without `secrets` and
lands in wasm; signing stays in `sign`.

Dependency: RustCrypto `groestl` 0.10 (`default-features = false`), the same `digest` 0.10 family as the
`sha2`/`sha3` already in the tree, so it adds exactly one crate (`groestl`) to each allowlist. Writing our own
Groestl would be more code to audit than an established, test-vectored crate.

Vectors (independent of this repo): groestlcoinjs-lib addresses.spec.ts and bip32.spec.ts (p2pkh, p2sh-p2wpkh,
p2wpkh, BIP32 paths); Electrum-GRS Test_keyImport (Groestl-checksummed WIFs, compressed and not); groestlcoinjs
transaction.json (txids = single SHA-256) and hashForWitnessV0 fixtures; two real GRS mainnet txs (P2PKH and
P2WPKH, from api.blockchair.com) whose signatures verify under our single-SHA-256 sighash and fail under sha256d.
groestlcoinjs' own WIF strings and its signed-tx fixture are Bitcoin's (sha256d) and are not used.

tx-sign and tx-verify now take the chain from the tx-build JSON when `--chain` is not given, and refuse a
conflicting `--chain` (signing a GRS PSBT with the BTC sighash would make an invalid tx).

## PoS-nTime transactions (`crates/tx/src/pos.rs`)

Layouts were measured against mainnet txs (`crates/tx/tests/data/pos_mainnet.txt`): each vector must hash (sha256d) to its on-chain txid and every input signature must verify under the chosen sighash, and must fail under the flipped `sighash_time` choice.

- PPC v1, NVC v1, CLAM v1/v2: u32 nTime right after the version, included in the sighash. CLAM v>1 appends a varstr "clam-speech" after locktime.
- RDD v2: nTime after locktime; part of the txid but stripped from the sighash.
- BLK v2: no nTime at all (plain Bitcoin layout), so the row is `Standard`/`legacy`.
- POT: no vector, refused.

Explorer JSON (chainz) reports block time, not tx time; the vectors' nTime was recovered as the unique value making sha256d(raw) equal the txid. There is no PSBT for this format: the unsigned form is a JSON envelope `{chain,tx_format:"pos-ntime",unsigned_tx,time,pos_prevouts}` and tx-sign re-checks the bare tx is unchanged after signing. Inputs are P2PKH only; network acceptance (min fee, dust) is untested.

## Zcash transparent (v4/v5)

`blocktools-tx::zcash` parses v4 (Sapling, ZIP-243) and v5 (NU5, ZIP-225) txs, computes the txid (v4 dsha256, v5 ZIP-244 BLAKE2b tree) and the transparent sighash (ZIP-243 / ZIP-244 S.2), and builds and signs transparent-only v5 sweeps from P2PKH inputs. BLAKE2b (RFC 7693, personalised) is in-crate. Measured: the zcash-test-vectors ZIP-244 set (10 txids, 32 transparent and 8 shielded sighashes) and ZIP-243 set (10 sighashes); 7 mainnet txs (3 v4, 4 v5) whose txids match and whose 9 P2PKH signatures verify under the computed sighash with branch id 0x37a5165b, and fail under a flipped one; the e2e recomputes a signed sweep txid with Python hashlib. The branch id is consensus-critical and changes at every network upgrade: tx-build takes `--branch-id`, the default is the 2026-10-25 measured mainnet value. Shielded components are decoded only as opaque bytes and their fee is unknown; tx-sign refuses txs that have any. Untested: network acceptance, v6 txs (seen live on mainnet), non-P2PKH inputs, the 546 zat dust threshold.

Since 2026-10-25 `zec` is in wasm `listChains`/`supportedChains` with `scope: "transparent"`; addresses are additionally checked against 21 mainnet script->address pairs from blockchair.

## WDC / QRK tx format (2026-10-25)

WDC: Bitcoin-legacy confirmed on 4 mainnet txs (sha256d txid, 357 legacy-sighash P2PKH signatures, input addresses re-derive under byte 73). The row stays `verified: false` (no SLIP-44). QRK: no mainnet non-coinbase tx found in 800 recent blocks, so its Sign stays `Unknown`.

## bitcoinj / MultiBit HD

`blocktools-secrets::bitcoinj` (feature `multibit`, tool `multibit-read`) reads bitcoinj wallet protobufs (cleartext or scrypt+AES-256-CBC, UTF-16BE password bytes) and MultiBit HD `mbhd.wallet.aes` (outer scrypt with the fixed MBHD salt, AES-256-CBC with the fixed IV a344391f538311b329548616c489723e, measured by recovering it from the btcrecover test file). Every decrypted key must reproduce its stored public key, and an HD seed must reproduce the stored root key; otherwise the result is `wrong_password`, never a key. HD wallets output the master xprv; MultiBit HD accounts are at m/0'. Measured on the btcrecover public wallets: the encrypted MultiBit wallet's key equals btcrecover's published WIF; the other two bitcoinj wallets match their stored public keys; the MBHD xprv derives the stored m/0'/0/0 and m/0'/0/1 keys. Untested: wallets written by other bitcoinj versions, watching/married wallets, testnet ids (refused), wallets with a bitcoinj passphrase on the seed, Armory: see below.

Armory (`blocktools-secrets::armory`, tool `armory-read`): PyBtcWallet layout (KDF params at offset 334 with a hash256 checksum, root address at 846, entries at 2107). KDF = Armory ROMix (SHA-512 table of mem/64 hashes, mem/128 lookups, first 32 bytes) applied `iters` times; private keys AES-256-CFB with the per-address IV; chain step priv*(hash256(pub65) XOR chaincode) mod n. Every key must reproduce its stored 65-byte public key and agree with the entry's own encrypted key; otherwise `wrong_password` / `corrupt`. Output: uncompressed WIF per stored address. Measured on the gurnec/btcrecover public test wallet (password btcr-test-password, 2 MiB x 4 KDF): all 100 stored addresses reproduced; a Python prototype written from the Armory C++/Python sources gave the same. Untested: unencrypted, other Armory versions, paper backups. (unmeasured)

Zcash Sapling (tools/zec-sapling): BIP39 seed -> ZIP-32 Sapling master -> m/32'/133'/i' -> default
payment address (zs1, bech32, 78 chars). Spending keys never leave the process; --viewkey-out FILE writes
zxviews extended full viewing keys to a new 0600 file. KATs: zcash ZIP-32 sapling_zip32_hard vectors and
sapling_key_components (pk_d). `--unified` adds, per account, a ZIP-316 unified address (orchard + sapling +
p2pkh at the first valid Sapling diversifier index j; Orchard keys from the `orchard` crate at m/32'/133'/i',
p2pkh at m/44'/133'/i'/0/j, encoding by `zcash_address`) and the t1 address. KATs: orchard_key_components
row 0 (default address) and all 60 unified_address.json rows (seed/account/j -> each receiver and the UA
string). The abandon…about account 0/1 UAs also equal the zcash-test-vectors Python reference run locally.
Untested: a wallet app (Zashi/Ywallet) showing the same UA; Orchard viewing keys, scanning and spending are not built.

## Monero scan/sweep (2026-10-25)

`tools/xmr-wallet` drives the user's own monero-wallet-rpc on loopback only (URLs other than 127.0.0.1 are refused) and never runs in the sealed image. Seed and view key travel only in the HTTP body to loopback. Sweep: restore, refresh, `sweep_all` with do_not_relay, check destination network and amount + fee == unlocked, print the plan; `--relay` additionally requires a 6-digit code typed at /dev/tty, then `relay_tx`. 2026-10-25 stagenet run (Mac, official monero v0.18.5.4 binaries, SHA-256 checked against the published hashes.txt): faucet 0.5 XMR seen by `xmr-wallet scan` (unlocked 500000000000 at height 2236134); `xmr-wallet sweep --relay` planned amount 499969620000 + fee 30380000 = unlocked, relayed tx bb300227e8e6c418fe7d825ac432d79abc2d4b943d99e053eabfba3c8197a96d (mined in stagenet block 2236135, checked on a public stagenet node); a view-only `scan` of the destination wallet shows that amount incoming (pool). The TTY confirm was answered by an `expect` script standing in for a human. Untested: mainnet, Polyseed/13-word/non-English seeds, subaddresses.

## Recovery verifier (2026-10-25)

`blocktools::verifier` is a Rust port of SwapChan's `verifyRecovery` / `verifySafe` / `verifyV4` / `verifySweepTx`
(no secrets, wasm-safe). The ABI decoder mirrors viem 2.57.11 (lenient address words, strict bools, offset rules,
8192 recursive-read limit) so verdicts match the TS. `tests/verifier_parity.rs` replays a 1293-case corpus generated
by `tools/verifier-parity/gen.ts` from the TS sources with real viem, and parses the copied TS sources
(`tests/data/verifier-ts/`) to prove STANDARD_RECOVERY, pinned contracts, MultiSend and the deadline cap are identical.
Raw entry points decode a legacy/2930/1559 tx with `blocktools-tx`, require the chain id, recover the signer and
require it to be the owner. Intentional differences (SwapChan-approved, flagged `intentional_diff` in the corpus with the TS verdict kept as `ts_expect`; the runner asserts Rust refuses): non-hex `data`, multicall nesting > 32, a MultiSend leg whose length runs past the blob, a sweep `value` that is an array/object. Also a malformed `value`
returns a verdict instead of throwing, viem error texts only keep the `unverifiable: ` prefix.

## EVM transfer builder and coin selection (2026-10-25)

`blocktools::build` replaces SwapChan's `forkSweep`/`evmSweep` tx assembly and the `utxochains.ts` selection policy.
The builder never signs; it emits the unsigned RLP and the signing hash so the existing sign → decode → checkTx path
stays the gate. Selection drops inputs whose spend fee (rate × 148 vB) exceeds 5% of value, sorts largest-first and
caps at 200 inputs. Parity corpus: `tools/build-parity/gen.ts` (viem as the serializer oracle).
