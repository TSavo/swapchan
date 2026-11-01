# Chain: THORChain (RUNE)

Address `thor1...` = bech32 `thor` of hash160(compressed secp256k1 pubkey); path `m/44'/931'/0'/0/{i}`.
The key is 32-byte hex (`private_key`, redacted). `acct-tx --chain rune` builds, signs and decodes a
THORChain `MsgDeposit` (`thorchain-1`, SIGN_MODE_DIRECT) — the transaction type behind every THORChain
swap-from-RUNE, liquidity action and THORName. The action is carried in the deposit **memo**.

## Address and public key

<!-- e2e: expect=thor1w508d6qejxtdg4y5r3zarvary0c5xw7ku6wp68 ; expect="chain":"rune" -->
    ./blocktools run 'acct-tx keys --chain rune < /in/key.hex'

`keys` prints only the public `address` and `pubkey`; `build` needs the `--pubkey` (33-byte hex),
because an account that has never signed has no pubkey on chain yet.

## A deposit, built and decoded (public round trip)

Amounts are RUNE base units (1 RUNE = 1e8). Here a swap-to-ETH deposit (memo `=:ETH.ETH:ADDR:LIM`),
built and decoded back through the sealed boundary — only public fields return:

<!-- e2e: expect="chain":"rune" ; expect="amount":100000000 ; expect="from":"thor1w508d6qejxtdg4y5r3zarvary0c5xw7ku6wp68" ; expect="signed":false -->
    ./blocktools run 'acct-tx build --chain rune --from thor1w508d6qejxtdg4y5r3zarvary0c5xw7ku6wp68 --pubkey 0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798 --amount 100000000 --memo =:ETH.ETH:0x0000000000000000000000000000000000000001:0 --sequence 0 --account-number 1 | acct-tx decode --chain rune'

Signing is the `/dev/tty` step (`acct-tx sign --chain rune --expect-memo ...`): it shows the memo and
amount and signs only after the typed code; `scripts/e2e.d/thorchain.sh` drives it through a pty.

## What's built

`MsgDeposit` of one coin (THOR.RUNE), SIGN_MODE_DIRECT, `/cosmos.crypto.secp256k1.PubKey`. Unsigned =
SignDoc (base64); signed = TxRaw plus the SignDoc, so `decode` verifies the signature. Decode refuses a
TxBody memo, a fee coin, extra coins, extra messages, and a signer that does not match the pubkey. The
protocol native fee (RfRune) is deducted by the chain, so the tx carries a gas limit (default 20000000)
and no fee coin. KAT: body, auth_info and signed TxRaw byte-equal to the real mainnet `swapchan` THORName
register/alias txs (crates/acct/tests/thorchain.rs). NOT BUILT: non-RUNE deposit coins, multi-message txs,
and the network fetch/broadcast (host-side `rpc` against a THORChain node).

See [thorchain-thorname.md](thorchain-thorname.md) to register an affiliate name,
[thorchain-swap-evm.md](thorchain-swap-evm.md) to send an EVM token into a THORChain swap, and
[thorchain-swap-utxo.md](thorchain-swap-utxo.md) to send a UTXO coin (DOGE/LTC/BCH/BTC) into a swap.
