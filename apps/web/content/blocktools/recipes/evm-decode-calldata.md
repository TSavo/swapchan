# EVM: decode a transaction's calldata (and encode it back)

> ⚠️ DANGEROUS: use at your own risk. Code that handles keys and signs transactions should
> always be read and audited by you before you trust it with real funds. Used incorrectly,
> it can destroy your money.

Task: you have a transaction and want its function arguments. `abi-decode` is offline and has no signature
database: you give it the signature. Part of the [EVM contract recipes](evm-contract-data.md).

Fixtures are raw Ethereum mainnet JSON-RPC responses in [fixtures/evm-mainnet/](fixtures/evm-mainnet/); the request
behind each file is in [PROVENANCE.md](fixtures/evm-mainnet/PROVENANCE.md). Live `curl` lines are UNTESTED here: CI never
touches the network.

`01a-erc20-transfer-tx.json` is `eth_getTransactionByHash` for a USDC transfer. Pull `input` with `jq`:

<!-- e2e: expect="signature":"transfer(address,uint256)" ; expect="value":"0x264bd8291fAE1D75DB2c5F573b07faA6715997B5" ; expect="value":"5050510000" ; rc=0 -->
    jq -r .result.input recipes/fixtures/evm-mainnet/01a-erc20-transfer-tx.json | abi-decode --sig 'transfer(address,uint256)'

The whole response works too. A wrong signature is `no_match` with the selector (exit 0; exit 2 is malformed
input); it never guesses:

<!-- e2e: expect="status":"no_match" ; expect="selector":"0xa9059cbb" ; rc=0 -->
    abi-decode --sig 'approve(address,uint256)' < recipes/fixtures/evm-mainnet/01a-erc20-transfer-tx.json

Bytes appended after the call (an ERC-2771 sender, a referral tag) are refused by default (exit 2,
`trailing_data`). `--allow-trailing` decodes the call and returns exactly the extra bytes as `trailing_hex`
([ABI-STRICT.md](../docs/ABI-STRICT.md)):

<!-- e2e: expect="error":"trailing_data" ; rc=2 -->
    abi-decode --sig 'transfer(address,uint256)' 0xa9059cbb0000000000000000000000002b5ad5c4795c026514f8317c7a215e218dccd6cf00000000000000000000000000000000000000000000000000000000000003e82222222222222222222222222222222222222222

<!-- e2e: expect="value":"1000" ; expect="trailing_hex":"0x2222222222222222222222222222222222222222" ; rc=0 -->
    abi-decode --sig 'transfer(address,uint256)' --allow-trailing 0xa9059cbb0000000000000000000000002b5ad5c4795c026514f8317c7a215e218dccd6cf00000000000000000000000000000000000000000000000000000000000003e82222222222222222222222222222222222222222

<!-- e2e: expect="trailing_hex":"0xdeadbeef" ; rc=0 -->
    abi-decode --sig 'transfer(address,uint256)' --allow-trailing 0xa9059cbb0000000000000000000000002b5ad5c4795c026514f8317c7a215e218dccd6cf00000000000000000000000000000000000000000000000000000000000003e8deadbeef

A return value longer than the declared outputs, here `(uint112,uint112)` over 3 words:

<!-- e2e: expect="error":"trailing_data" ; rc=2 -->
    abi-decode --types '(uint112,uint112)' 0x000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000003

<!-- e2e: expect="value":"2" ; expect="trailing_hex":"0x0000000000000000000000000000000000000000000000000000000000000003" ; rc=0 -->
    abi-decode --types '(uint112,uint112)' --allow-trailing 0x000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000003

Decoding one tuple out of a longer argument list (here its offset is `0x60`, after two words the types do not
cover) is refused by default with `non_canonical_offset`. `--allow-gaps` accepts tails that start later than the
canonical position, never earlier, and reports the skipped bytes as `gap_bytes`:

<!-- e2e: expect="error":"non_canonical_offset" ; rc=2 -->
    abi-decode --types '((uint256,string))' 0x0000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000007000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000046e65617200000000000000000000000000000000000000000000000000000000

<!-- e2e: expect="gap_bytes":64 ; expect="status":"ok" ; rc=0 -->
    abi-decode --types '((uint256,string))' --allow-gaps 0x0000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000007000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000046e65617200000000000000000000000000000000000000000000000000000000

Selector unknown? See [evm-unknown-selector.md](evm-unknown-selector.md).

## Encode: arguments → calldata

`abi-encode` is the inverse. The Solidity ABI spec example `baz(uint32,bool)` with `69, true` gives selector
`0xcdcd77c0`:

<!-- e2e: expect="selector":"0xcdcd77c0" ; rc=0 -->
    abi-encode 'baz(uint32,bool)' 69 true | jq -c '{signature,selector}'

Re-encoding the decoded arguments of `01a` round-trips:

<!-- e2e: expect="value":"5050510000" ; rc=0 -->
    abi-encode --raw 'transfer(address,uint256)' 0x264bd8291fae1d75db2c5f573b07faa6715997b5 5050510000 | abi-decode --sig 'transfer(address,uint256)'

Live (UNTESTED here): `curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionByHash","params":["0x…"]}' "$RPC" | jq -r .result.input | abi-decode --sig 'transfer(address,uint256)'`
