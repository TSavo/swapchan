# Cross-chain swap: send a UTXO coin into THORChain (OP_RETURN memo)

Swap a UTXO coin (DOGE, LTC, BCH, BTC) for an asset on another chain — RUNE, ETH, another UTXO coin —
by paying the coin to a THORChain vault with a swap memo in an `OP_RETURN` output. One transaction, in
THORChain's inbound order: `VOUT0 = vault`, `VOUT1 = change`, last output `OP_RETURN <memo>`
(dev.thorchain.org, "Sending Transactions"). The shipped tools build it (`tx-build --memo`/`--op-return`),
check its THORChain shape (`tx-envelope verify_thor_send`), and sign it behind the typed-code
confirmation (`tx-sign`, which shows the memo on the terminal). A THORChain node (or any quote service)
gives you the vault and memo; it is a cross-chain swap, so the destination asset arrives on its own chain.

## 1. Quote → vault, memo

Ask a THORChain node for the inbound of a swap from your coin to the destination asset:

    rpc NODE '/thorchain/quote/swap?from_asset=DOGE.DOGE&to_asset=THOR.RUNE&amount=AMOUNT_1E8&destination=thor1...'

It returns `inbound_address` (the vault), `memo`, and the recommended `expiry`/`gas_rate`. For a UTXO
inbound the memo is a short swap string such as `=:r:thor174jsu5agtgztcmcly96ac9mrtf5n2k98dhmunu`
(`=:ASSET:DEST[:LIM][:AFFILIATE:FEE]`); confirm its destination and asset before you send.

## 2. Build the inbound (vault + change + OP_RETURN memo)

`tx-build --memo STRING` (or `--op-return HEX` for raw bytes) adds the zero-value `OP_RETURN` as the
last output and pays its vbytes out of coin selection. `--send SATS --change ADDR` pays `SATS` to the
vault and the remainder (less fee) back to you; `--sweep` sends the whole input to the vault. The memo is
refused above the chain's relay limit (BCH 220 bytes, otherwise 80). Verify the build with
`tx-envelope verify_thor_send` (exact `[vault, optional change, OP_RETURN memo]` shape, non-RBF, proven
input values, fee cap) and with the shared `tx-verify` policy. The single zero-value `OP_RETURN` is accepted only when you pass
`--expect-memo MEMO` with the exact payload; without it, or with a memo that differs by one byte, it is an
`unexpected_output`:

<!-- e2e: expect="status":"ok" ; rc=0 -->
    tx-build --chain doge --utxos /in/u-doge.json --to D5kTEGxmas71USKAcAaJptKjq8NJc6EK8C --send 100000000 --change DFpN6QqFfUm3gKNaxN6tNcab1FArL9cZLE --fee-rate 1000 --memo '=:r:thor174jsu5agtgztcmcly96ac9mrtf5n2k98dhmunu' | tx-verify --chain doge --expect-to D5kTEGxmas71USKAcAaJptKjq8NJc6EK8C --change DFpN6QqFfUm3gKNaxN6tNcab1FArL9cZLE --expect-memo '=:r:thor174jsu5agtgztcmcly96ac9mrtf5n2k98dhmunu'

    tx-build --chain doge --utxos utxos.json --to VAULT --send AMOUNT --change YOUR_ADDR --fee-rate RATE --memo 'MEMO' > inbound.json
    tx-envelope --json '{"op":"verify_thor_send","chain":"doge","tx":"'"$(jq -r .psbt inbound.json)"'","vault":"VAULT","memo":"MEMO","amount":"AMOUNT","change":"YOUR_ADDR","taker":"YOUR_ADDR"}'

## 3. Sign (the memo is shown) and broadcast

`tx-sign` requires `--expect-to VAULT` for the real destination and `--expect-memo MEMO` for the single
`OP_RETURN` (exact match, else refused before signing); the memo is also printed on the `/dev/tty` summary (UTF-8 if printable, else hex) so you confirm it before
typing the code. A second `OP_RETURN`, or an `OP_RETURN` carrying value, is still refused.

    tx-sign --tx inbound.json --chain doge --expect-to VAULT --change YOUR_ADDR --expect-memo 'MEMO' < key   # shows the memo; type the code
    tx-broadcast --chain doge --url NODE < inbound.signed

Track the cross-chain leg at `/thorchain/tx/status/<inbound-txid>`; the destination asset arrives on its
own chain, so your UTXO chain shows only the coin leaving to the vault (that is expected, not a failure).

## Measured on mainnet

A DOGE→RUNE swap on 2026-10-27 used vault `DF5ndBX4Fd6yUcPvAs9SkbH5r4VaZE6huG` and memo
`=:r:thor174jsu5agtgztcmcly96ac9mrtf5n2k98dhmunu`; the DOGE inbound was
`6d0a0978df7782ce418e777e435406c7c2b9bab88225cd0c543894ed8c80dfdb`.

## Tests

`scripts/e2e.d/thorchain-utxo.sh` drives the shipped path node-free on a synthetic DOGE UTXO:
`tx-build --memo` → `tx-envelope verify_thor_send` (ok) → `tx-verify` (ok) → `tx-sign` (pty, public key 1,
memo shown, `--expect-memo`) → `tx-decode` confirms the `OP_RETURN`, and proves two `OP_RETURN`s or a non-zero-value
`OP_RETURN` are still refused, as is the memo with no or a one-byte-different `--expect-memo`. `scripts/e2e.d/memo-regtest.sh` runs the same inbound against the real
pinned LTC/DOGE/BCH regtest nodes. UNTESTED in CI: the live THORChain quote and the cross-chain settlement.

See [thorchain-swap-evm.md](thorchain-swap-evm.md) for the reverse direction (an EVM token into a swap)
and [thorchain-thorname.md](thorchain-thorname.md) for affiliate names.
