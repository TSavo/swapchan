# EVM contract recipes: index

> ⚠️ DANGEROUS: use at your own risk. Code that handles keys and signs transactions should
> always be read and audited by you before you trust it with real funds. Used incorrectly,
> it can destroy your money.

Short, one-task recipes for contract data on any EVM chain. The tools are offline stdin→stdout filters (`sig-hash`,
`abi-decode`, `abi-encode`, `log-decode`, `create-address`, `abi-inspect`, `bytecode-inspect`, `typed-data-verify`)
plus two host-side RPC tools (`contract-call`, `contract-trace`). No built-in chain list and no signature database:
you supply signatures and fetch JSON-RPC responses yourself. Every marked example runs in CI on recorded public
mainnet responses ([fixtures/evm-mainnet/](fixtures/evm-mainnet/)) or public test vectors; anything not run there is
labelled UNTESTED or NOT BUILT in the recipe.

| Task | Recipe |
|---|---|
| Decode a transaction's calldata; encode calldata | [evm-decode-calldata.md](evm-decode-calldata.md) |
| Look up an unknown selector | [evm-unknown-selector.md](evm-unknown-selector.md) |
| Decode event logs | [evm-decode-logs.md](evm-decode-logs.md) |
| Decode a revert (`Error(string)`, `Panic`, custom errors) | [evm-decode-revert.md](evm-decode-revert.md) |
| Run an `eth_call` and decode the return; state overrides and traces | [evm-eth-call.md](evm-eth-call.md) |
| Compute a CREATE or CREATE2 address | [evm-contract-address.md](evm-contract-address.md) |
| Inspect a deployed contract: code, ABI, selectors, offline source/metadata check | [evm-inspect-contract.md](evm-inspect-contract.md) |
| Check an EIP-712 signature and digest | [evm-eip712-verify.md](evm-eip712-verify.md) |
| Check an ERC-20 approve or EIP-2612 permit before signing | [evm-check-approval.md](evm-check-approval.md) |
| Decode a multicall or a Universal Router `execute` | [evm-decode-multicall.md](evm-decode-multicall.md) |
| Tx hash → decoded call, logs and revert, end to end | [evm-tx-end-to-end.md](evm-tx-end-to-end.md) |
| What a Permit2 signing request commits to, verified offline | [evm-permit2-signing-request.md](evm-permit2-signing-request.md) |
| Check an EIP-1167 proxy or EIP-7702 delegation before interacting | [evm-check-proxy-delegation.md](evm-check-proxy-delegation.md) |
| Build, verify, sign and broadcast a contract call or deployment | [evm-contract-tx.md](evm-contract-tx.md) |

A quick check that the tools are on your PATH (the selector of `owner()`):

<!-- e2e: expect="selector":"0x8da5cb5b" ; rc=0 -->
    sig-hash 'owner()'
