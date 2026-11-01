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
