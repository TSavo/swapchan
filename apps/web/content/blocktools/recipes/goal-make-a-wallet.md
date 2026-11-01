# Goal: make a new wallet

`new-seed` is a BIP39 keygen: it draws fresh entropy from the OS CSPRNG and prints a mnemonic in the
exact shape `seed-to-master` reads, so making a wallet is one pipeline. The mnemonic is a SECRET; run
through `./blocktools run` (the agent sees `[REDACTED]` for the phrase and only the addresses in the
clear) and keep the real phrase via `./blocktools reveal`.

## 1. A fresh 24-word wallet (256-bit), public addresses only

    ./blocktools reveal 'new-seed | seed-to-master | derive --chain btc,eth --count 1'

`new-seed --words 12` makes a 12-word (128-bit) phrase instead. The mnemonic line is
`{"tool":"new-seed","status":"ok","mnemonic":"..."}`; write it down from the `reveal` output.

## 2. Deterministic check (known-answer vector)

The hidden `--entropy <hex>` flag replaces the CSPRNG with supplied entropy — it exists for the
known-answer test. 128-bit all-zero entropy is the canonical Trezor/BIP39 vector
"abandon abandon ... about", whose addresses are pinned by the BIP44/84 spec and MetaMask:

<!-- e2e: expect=bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu ; expect=0x9858EfFD232B4033E47d90003D41EC34EcaEda94 -->
    ./blocktools run 'new-seed --entropy 00000000000000000000000000000000 | seed-to-master | derive --chain btc,eth --public-only --count 1'

Under `./blocktools run` the mnemonic is blanked to `[REDACTED]`; only the addresses and paths are
printed. The same pipeline with `reveal` (or on a trusted offline host) shows the phrase and keys.
