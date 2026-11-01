# EVM: decode a revert

> ⚠️ DANGEROUS: use at your own risk. Code that handles keys and signs transactions should
> always be read and audited by you before you trust it with real funds. Used incorrectly,
> it can destroy your money.

Task: an `eth_call` or simulation failed and you want the reason. `Error(string)` and `Panic(uint256)` decode with no
signature; a custom error needs its declaration. Part of the [EVM contract recipes](evm-contract-data.md).

Fixtures are raw Ethereum mainnet JSON-RPC responses in [fixtures/evm-mainnet/](fixtures/evm-mainnet/); the request
behind each file is in [PROVENANCE.md](fixtures/evm-mainnet/PROVENANCE.md). Live `curl` lines are UNTESTED here: CI never
touches the network.

`04d` is a USDC `transferFrom` without allowance:

<!-- e2e: expect="signature":"Error(string)" ; expect="value":"ERC20: transfer amount exceeds allowance" ; rc=0 -->
    jq .error recipes/fixtures/evm-mainnet/04d-error-string-eth_call.json | abi-decode

A custom error (`04e`), with the declaration found in [evm-unknown-selector.md](evm-unknown-selector.md):

<!-- e2e: expect="signature":"TransactionDeadlinePassed()" ; expect="kind":"error" ; rc=0 -->
    jq .error recipes/fixtures/evm-mainnet/04e-custom-error-eth_call.json | abi-decode --abi recipes/fixtures/evm/candidate-errors.txt

A mined transaction's receipt does not carry revert data. Replaying it with `eth_call` can give a different answer
because the state differs: see [evm-tx-end-to-end.md](evm-tx-end-to-end.md).
