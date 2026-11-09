# Chain: BitConnect (BCC), an old coin as a worked example

BitConnect (BCC, collapsed January 2018) is here as a demo of an old `wallet.dat` from a coin
blocktools did not know. The row `bcc` is **unverified**: its bytes come from the coin's own
source (bitconnectcoin/bitconnectcoin@3ab3d19, `src/base58.h` lines 279-280 and 408), but it has
no SLIP-44 entry and is not enabled for transaction building/signing. Historical mainnet bytes
now confirm its `nTime` layout (see [verification evidence](../docs/BITCONNECT-VERIFICATION.md));
that evidence does not promote the row to supported. Unverified rows never appear in auto-detect or default chain lists; name the chain with `--chain bcc`.

| field | value | source line |
|---|---|---|
| p2pkh | 18 (addresses start with `8`) | base58.h:279 `PUBKEY_ADDRESS = 18` |
| p2sh | 85 (`b...`; same byte as Blackcoin p2sh) | base58.h:280 `SCRIPT_ADDRESS = 85` |
| WIF | 146 | base58.h:408 `128 + PUBKEY_ADDRESS` |
| checksum | sha256d | base58.h:136/152 `Hash()` (util.h:450, double SHA-256) |
| tx format | PoS, `nTime` in every tx | main.h:443 |
| network magic | `32 5e 6f 86` | main.cpp:2852 |
| SLIP-44 | none (268 "BCC" is BCChain, not BitConnect) | satoshilabs/slips slip-0044.md |

The demo wallet is self-made by `scripts/make-fixtures.py` (`legacy-bcc.dat`: Berkeley DB, three
throwaway keys, `name` address-book records with the BCC addresses computed in Python). The client
is a Bitcoin 0.8-era fork, so its `walletdb.cpp` writes the same `key`/`name` records as Bitcoin
Core and `dat-read` reads it unchanged.

Step 1: it is a wallet.dat.

<!-- e2e: expect="class":"wallet_dat" -->
    ./blocktools run 'classify /in/legacy-bcc.dat'

Step 2: keys out, BCC addresses in. All three match the wallet's own address book.

<!-- e2e: expect="chain":"bcc" ; expect=8XFa9Ce4Pf6d3Rvpr3jnp6sm8279Ec1V92 ; expect=8N9YB8om5U9b1PFkG56TUWuLJequvGmBDQ ; expect=8YApAinsWVUtKyHJgm46mab8u3gtKDxT6s -->
    ./blocktools run 'read-file /secrets/empty.pw /in/legacy-bcc.dat | dat-read | key-to-addresses --chain bcc'

Step 3: data source. This demo uses no live network; its source is a file of unspent outputs
(`/in/u-bcc.json`, one synthetic 0.01 BCC output at the first address). The build step refuses,
because the row remains unverified and no BCC build/sign path is enabled. The archival layout
check is evidence, not a signing authorization. Run directly, `tx-build` exits 2 with
`"error":"unverified chain parameters: not supported"`; under `sealed-run agent` the error text is
redacted and only the status reaches the agent:

<!-- e2e: expect="status":"bad_input" ; expect="tool":"tx-build" -->
    ./blocktools run 'tx-build --chain bcc --utxos /in/u-bcc.json --to 8N9YB8om5U9b1PFkG56TUWuLJequvGmBDQ --sweep --fee-rate 5 --time 1792800000'

That refusal is where this example stops. Keys and addresses are recovered offline; building,
signing and broadcasting need a verified row (see docs/ADDING-A-CHAIN.md).
