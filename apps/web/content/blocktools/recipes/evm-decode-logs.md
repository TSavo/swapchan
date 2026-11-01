# EVM: decode event logs

> ⚠️ DANGEROUS: use at your own risk. Code that handles keys and signs transactions should
> always be read and audited by you before you trust it with real funds. Used incorrectly,
> it can destroy your money.

Task: turn `eth_getLogs` output or a receipt's `logs` into named fields. Part of the
[EVM contract recipes](evm-contract-data.md).

Fixtures are raw Ethereum mainnet JSON-RPC responses in [fixtures/evm-mainnet/](fixtures/evm-mainnet/); the request
behind each file is in [PROVENANCE.md](fixtures/evm-mainnet/PROVENANCE.md). Live `curl` lines are UNTESTED here: CI never
touches the network.

`01c-usdc-transfer-getLogs.json` is an `eth_getLogs` result; each log becomes one JSON line, indexed topics decoded:

<!-- e2e: expect="signature":"Transfer(address,address,uint256)" ; expect="indexed":true ; expect="value":"154943368057" ; rc=0 -->
    abi-decode --sig 'event Transfer(address indexed from, address indexed to, uint256 value)' < recipes/fixtures/evm-mainnet/01c-usdc-transfer-getLogs.json

`log-decode` does the same and keeps where each log came from (`address`, `block_number`, `log_index`,
`transaction_hash`); it also reads receipts and JSON lines, and filters with `--address`/`--only-matched`. Logs
matching none of your signatures are `no_match` lines, never guessed:

<!-- e2e: expect="event":"Transfer" ; expect="block_number": ; expect="value":"154943368057" ; rc=0 -->
    log-decode --only-matched --sig 'Transfer(address indexed from, address indexed to, uint256 value)' recipes/fixtures/evm-mainnet/01c-usdc-transfer-getLogs.json

Live (UNTESTED here): `curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x…","toBlock":"0x…","address":"0x…"}]}' "$RPC" | log-decode --sig 'Transfer(address indexed from, address indexed to, uint256 value)'`
