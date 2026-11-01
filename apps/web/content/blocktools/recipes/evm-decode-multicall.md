# EVM: decode a multicall or a Universal Router execute

> ⚠️ DANGEROUS: use at your own risk. Code that handles keys and signs transactions should
> always be read and audited by you before you trust it with real funds. Used incorrectly,
> it can destroy your money.

Task: one transaction carries several calls packed as `bytes[]`. Decode the outer call, then each inner one. No tool
recurses for you: it is a pipeline of `abi-decode` steps, each one given the layout you read from the contract's source.
Part of the [EVM contract recipes](evm-contract-data.md).

Fixtures are raw Ethereum mainnet JSON-RPC responses in [fixtures/evm-mainnet/](fixtures/evm-mainnet/) (requests in
[PROVENANCE.md](fixtures/evm-mainnet/PROVENANCE.md)).

## Uniswap Universal Router execute(bytes,bytes[],uint256)

`02a` is a mainnet Universal Router swap. The outer call: a command string (one byte per command), one input per
command, and a deadline:

<!-- e2e: expect="commands":"0x0a10" ; expect="inputs":2 ; expect="deadline":"1792984331" ; rc=0 -->
    jq -r .result.input recipes/fixtures/evm-mainnet/02a-swap-tx.json | abi-decode --sig 'execute(bytes,bytes[],uint256)' | jq -c '{commands: .args[0].value, inputs: (.args[1].value | length), deadline: .args[2].value}'

Command `0x0a` is `PERMIT2_PERMIT` and `0x10` is `V4_SWAP` in Uniswap's `Commands.sol` (read from their source, not from
a tool). The `PERMIT2_PERMIT` input is a `PermitSingle` plus its signature:
`((token, amount, expiration, nonce), spender, sigDeadline), signature`:

<!-- e2e: expect=["0xc8Fb80fCc03f699C70ff0CC08C09106288888888","713135902875675667654","1792984331","3270"] ; expect="0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af" ; rc=0 -->
    jq -r .result.input recipes/fixtures/evm-mainnet/02a-swap-tx.json | abi-decode --sig 'execute(bytes,bytes[],uint256)' | jq -r '.args[1].value[0]' | abi-decode --types '(((address,uint160,uint48,uint48),address,uint256),bytes)' | jq -c '.args[0].value'

That signature is checked offline in [evm-permit2-signing-request.md](evm-permit2-signing-request.md). The `V4_SWAP`
input is `(bytes actions, bytes[] params)`:

<!-- e2e: expect="actions":"0x060c0f" ; expect="params":3 ; rc=0 -->
    jq -r .result.input recipes/fixtures/evm-mainnet/02a-swap-tx.json | abi-decode --sig 'execute(bytes,bytes[],uint256)' | jq -r '.args[1].value[1]' | abi-decode --types '(bytes,bytes[])' | jq -c '{actions: .args[0].value, params: (.args[1].value | length)}'

NOT BUILT: naming Universal Router command bytes or Uniswap v4 action bytes, and decoding each v4 action's parameter
struct. You can decode each `params` element with `--types` once you have the struct layout from Uniswap's
`Actions.sol` and router source; that step is not shown or tested here.

## A plain multicall(bytes[])

The same pattern for the common `multicall(bytes[])`. The calldata here is constructed with `abi-encode` from two inner
calls (no fixture); each inner call is decoded against the signatures you supply:

<!-- e2e: expect="signature":"approve(address,uint256)" ; expect="signature":"transfer(address,uint256)" ; expect="5050510000" ; rc=0 -->
    abi-encode --raw 'multicall(bytes[])' "[\"$(abi-encode --raw 'approve(address,uint256)' 0x000000000022d473030f116ddee9f6b43ac78ba3 1000)\",\"$(abi-encode --raw 'transfer(address,uint256)' 0x264bd8291fae1d75db2c5f573b07faa6715997b5 5050510000)\"]" | abi-decode --sig 'multicall(bytes[])' | jq -r '.args[0].value[]' | while read -r c; do abi-decode --sig 'approve(address,uint256)' --sig 'transfer(address,uint256)' "$c" | jq -c '{signature, args: [.args[].value]}'; done

An inner call with an unknown selector prints `no_match`; look it up with [evm-unknown-selector.md](evm-unknown-selector.md).
