# THORName: register and manage an affiliate name on THORChain

A THORName maps a short name to a payout address per chain, so THORChain routes can pay an
affiliate fee to it. Registering and updating a name is a native THORChain `MsgDeposit` of RUNE
whose **memo** carries the action — BlockTools builds and signs it with `acct-tx --chain rune`
(THORChain is `thorchain-1`, SIGN_MODE_DIRECT, secp256k1; the signer address is `thor1...`).

You need: a `thor1` wallet you control, funded with RUNE (the register fee is ~10 RUNE + one year
of per-block fees, read it live from `/thorchain/network`), and its `account_number` / `sequence`
(read from `/cosmos/auth/v1beta1/accounts/thor1...`). BlockTools has no network: fetch those with any
THORChain node, pass them in, and broadcast the signed TxRaw with `/cosmos/tx/v1beta1/txs` (simulate
first with `/cosmos/tx/v1beta1/simulate` — a malformed deposit is rejected there before any RUNE moves).

## Memos

    register 1 year:   ~:NAME:THOR:OWNER_thor1:OWNER_thor1:PREFERRED_ASSET
    add/replace alias: ~:NAME:CHAIN:ADDRESS            (CHAIN = ETH, BTC, BSC, ...; 0.01 RUNE)

`PREFERRED_ASSET` (e.g. `ETH.ETH`) is the asset affiliate fees auto-swap to; they pay out to that
chain's alias. So to collect fees to an Ethereum address, register with `ETH.ETH` and add an `ETH`
alias pointing at it.

## Address and keys

<!-- e2e: expect=thor1w508d6qejxtdg4y5r3zarvary0c5xw7ku6wp68 -->
    ./blocktools run 'acct-tx keys --chain rune < /in/key.hex'

## Register (build → decode → sign)

Amounts are RUNE base units (1 RUNE = 1e8). `acct-tx build` prints the unsigned SignDoc; `decode`
shows the deposit (public); `sign` shows the memo and amount on `/dev/tty` and signs only after you
type the code, and only if `--expect-memo` equals the memo exactly.

    acct-tx build --chain rune --from thor1... --pubkey HEX33 --amount 1105120000 \
        --memo '~:swapchan:THOR:thor1...:thor1...:ETH.ETH' --sequence 0 --account-number N > reg.json
    acct-tx decode --chain rune < reg.json
    acct-tx sign   --chain rune --tx reg.json --expect-memo '~:swapchan:THOR:thor1...:thor1...:ETH.ETH' < thor-key.hex > reg.signed

Broadcast `reg.signed`'s `signed` (base64 TxRaw) as `tx_bytes`:

    rpc NODE /cosmos/tx/v1beta1/simulate '{"tx_bytes":"<base64>"}'      # gas_info.gas_used, no error = valid
    rpc NODE /cosmos/tx/v1beta1/txs '{"tx_bytes":"<base64>","mode":"BROADCAST_MODE_SYNC"}'   # code 0 = accepted

Then the ETH alias (sequence 1):

    acct-tx build --chain rune --from thor1... --pubkey HEX33 --amount 1000000 \
        --memo '~:swapchan:ETH:0xYOUR_EVM_ADDRESS' --sequence 1 --account-number N > alias.json
    acct-tx sign  --chain rune --tx alias.json --expect-memo '~:swapchan:ETH:0xYOUR_EVM_ADDRESS' < thor-key.hex > alias.signed

Verify: `GET /thorchain/thorname/NAME` shows the owner, preferred asset and aliases.

## Measured on mainnet

This path registered `swapchan` on `thorchain-1` on 2026-10-27: register tx
`23BD9F3948645277DEC8E97E0B733159A26C8BCAFA75EE34355965E420B04158` (owner
`thor174jsu5agtgztcmcly96ac9mrtf5n2k98dhmunu`, preferred `ETH.ETH`) and ETH-alias tx
`CE63FBEA611FB13DFACE9A1B7A0936FD214FF6CADE823FA2F85DAD1D4AA9C947`. Both signed TxRaw are the
golden KAT vectors in `crates/acct/tests/thorchain.rs`: this tool reproduces them byte for byte and
verifies their on-chain signatures.

## Tests

`crates/acct/tests/thorchain.rs` (KAT, the two mainnet txs + a sign/verify round-trip on a public
key) and `scripts/e2e.d/thorchain.sh` (build → decode → pty sign through the sealed boundary,
asserting the register TxRaw). Gas is not estimated (THORChain does not price it); the default
20000000 covers a deposit. UNTESTED here: the live `/simulate` and broadcast (run once by hand for
`swapchan`, not in CI).
