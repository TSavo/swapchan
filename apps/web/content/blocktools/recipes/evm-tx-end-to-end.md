# EVM: from a tx hash to the decoded call, logs and revert

> ⚠️ DANGEROUS: use at your own risk. Code that handles keys and signs transactions should
> always be read and audited by you before you trust it with real funds. Used incorrectly,
> it can destroy your money.

Task: you have a transaction hash. Fetch the transaction and its receipt, then decode the input, the logs and, if it
failed, the reason. Part of the [EVM contract recipes](evm-contract-data.md).

The fetch is plain `curl` to your node (`$RPC`). In CI, `$ETH/<id>` is a local mock on 127.0.0.1 that answers with the
recorded mainnet response `<id>` from [fixtures/evm-mainnet/](fixtures/evm-mainnet/) (requests and capture times in
[PROVENANCE.md](fixtures/evm-mainnet/PROVENANCE.md)); replace it with `"$RPC"`. The live network path is UNTESTED here.

## A successful USDC transfer

The transaction, decoded:

<!-- e2e: expect="signature":"transfer(address,uint256)" ; expect="value":"5050510000" ; rc=0 -->
    curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionByHash","params":["0xc0ee5b5618437369d0925560368ee87b84569ef1e6a2763983efa5fc437231ab"]}' $ETH/01a | abi-decode --sig 'transfer(address,uint256)'

Its receipt: did it succeed, and what did it emit?

<!-- e2e: expect="status":"0x1" ; expect="logs":1 ; rc=0 -->
    curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0xc0ee5b5618437369d0925560368ee87b84569ef1e6a2763983efa5fc437231ab"]}' $ETH/01b | jq -c '.result | {status, logs: (.logs | length)}'

<!-- e2e: expect="event":"Transfer" ; expect="value":"5050510000" ; rc=0 -->
    curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0xc0ee5b5618437369d0925560368ee87b84569ef1e6a2763983efa5fc437231ab"]}' $ETH/01b | log-decode --sig 'Transfer(address indexed from, address indexed to, uint256 value)'

## A failed Universal Router swap

The receipt says it failed (`status` `0x0`) and has no logs:

<!-- e2e: expect="status":"0x0" ; expect="logs":0 ; rc=0 -->
    curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0x61495cbde17c4adbbae9760b2bc94b485b782d9c3c8e11d94398815eff36bb14"]}' $ETH/04b | jq -c '.result | {status, logs: (.logs | length)}'

What it tried to do (nested inputs: [evm-decode-multicall.md](evm-decode-multicall.md)):

<!-- e2e: expect="commands":"0x0a10" ; rc=0 -->
    curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionByHash","params":["0x61495cbde17c4adbbae9760b2bc94b485b782d9c3c8e11d94398815eff36bb14"]}' $ETH/04a | jq -r .result.input | abi-decode --sig 'execute(bytes,bytes[],uint256)' | jq -c '{commands: .args[0].value, deadline: .args[2].value}'

A receipt carries no revert data. Replaying the call with `eth_call` at the parent block is the usual next step, but
it runs against end-of-block state, not the state at the tx's position: for this tx the recorded replay (`04c`)
**succeeded** with `0x`, so it did not reproduce the revert:

<!-- e2e: expect="result":"0x" ; rc=0 -->
    curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x66a9893cc07d91d95644aedd05d03f95e1dba8af","data":"0x…"},"0x190e925"]}' $ETH/04c | jq -c '{result}'

When a replay does revert, decode its `error` (here `04d`, a USDC `transferFrom` without allowance; more in
[evm-decode-revert.md](evm-decode-revert.md)):

<!-- e2e: expect="signature":"Error(string)" ; expect="value":"ERC20: transfer amount exceeds allowance" ; rc=0 -->
    curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"from":"0x0000000000000000000000000000000000000001","to":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","data":"0x23b872dd000000000000000000000000000000000000000000000000000000000000dead00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001"},"latest"]}' $ETH/04d | jq .error | abi-decode

NOT BUILT: tracing a mined transaction (`debug_traceTransaction`); `contract-trace` traces a call you describe
(`debug_traceCall`), see [evm-eth-call.md](evm-eth-call.md). The mock returns the recorded response whatever the
request body says; the request bodies shown are the ones to send to a real node (the `04c` data is elided here; the
full request is in PROVENANCE.md).
