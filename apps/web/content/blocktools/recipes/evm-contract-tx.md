# EVM contract calls and contract creation: build, verify, sign, broadcast

Works on any EVM chain: the chain is the `--chain-id N` you pin (tx-build writes it into the
transaction, tx-verify and tx-sign refuse any other). BlockTools has no compiler and no
deploy/project management: you bring the calldata's function signature, or the init code bytes.

## Contract call

1. Calldata from a signature and arguments with `abi-encode`, then an unsigned tx with
   `tx-build --data` (`--gas` is required and is never guessed: take it from your node's
   `eth_estimateGas`, see "Gas" below;
   `--send WEI` adds value for payable functions). 2. Re-verify it: `tx-verify --call SIGNATURE`
   decodes the calldata strictly (it must re-encode byte for byte) and prints the function and
   arguments; only an exact match lifts the generic `unknown_contract_call` refusal, and the
   destination must still be your `--expect-to` (the contract):

<!-- e2e: expect="signature":"setValue(uint256)" ; expect="value":"42" ; expect="status":"ok" ; rc=0 -->
    tx-build --chain eth --chain-id 8453 --nonce 3 --max-fee-per-gas 2000000000 --gas 132358 --to 0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF --data $(abi-encode 'setValue(uint256)' 42 | jq -r .data) | tx-verify --chain-id 8453 --expect-to 0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF --call 'setValue(uint256)'

Without a matching `--call` (or `--abi FILE`), the selector is flagged and the tx is refused:

<!-- e2e: expect="status":"unknown_selector" ; expect=unknown_contract_call ; rc=1 -->
    tx-build --chain eth --chain-id 1 --nonce 3 --max-fee-per-gas 2000000000 --gas 60000 --to 0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF --data $(abi-encode 'setValue(uint256)' 42 | jq -r .data) | tx-verify --chain-id 1 --expect-to 0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF

3. Sign with the same assertions; the terminal summary shows `Contract call: setValue(uint256)`
   and each argument before you type the code:

    tx-sign --tx unsigned.json --chain-id 8453 --expect-to 0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF --call 'setValue(uint256)' < key

4. Broadcast: `tx-broadcast --chain eth --url URL < signed.json` (it shows the tx and asks for its own code).

## Contract creation

`tx-build --create INITCODE_HEX` (or `@FILE`) builds a tx with no `to` and prints
`initcode_keccak256`. tx-verify and tx-sign approve a creation only with `--create-hash` equal to
keccak256 of the exact init code (no `--expect-to`: there is no destination yet):

<!-- e2e: expect="kind":"create" ; expect="status":"ok" ; rc=0 -->
    tx-build --chain eth --chain-id 1 --nonce 0 --max-fee-per-gas 2000000000 --gas 226175 --create 600a600c600039600a6000f3602a60005260206000f3 | tx-verify --chain-id 1 --create-hash $(sig-hash --keccak 600a600c600039600a6000f3602a60005260206000f3 | jq -r .keccak256)

The tx-sign summary then shows the init code size and hash and `New contract address:` (CREATE from
the signer and nonce; cross-check with `create-address --deployer ADDR --nonce N`).

## Gas

Every `--gas` above is a number a node returned from `eth_estimateGas`, never a constant to copy: re-run the
estimate on your chain, from your sender, before building. The gas schedule differs between chains and forks.
The same 23-byte init code costs 56,132 on Ethereum mainnet but 226,175 on Sepolia (measured 2026-10-27 on
publicnode; Sepolia runs the Amsterdam schedule, which reprices contract and account creation). An earlier
version of this recipe used `--gas 100000`. On Sepolia that ran out of gas: tx
`0xfff41592bc416223d668d3e878e9999e518e59bd5bf97054312c9f832c2cd59a` got status `0x0` with gasUsed equal to the
100000 limit. The init code itself was correct; `eth_call` of it returns the 10-byte runtime `0x602a60005260206000f3`.

    rpc URL eth_estimateGas '[{"from":"0xYOUR_SENDER","data":"0x600a600c600039600a6000f3602a60005260206000f3"}]'
    rpc URL eth_estimateGas '[{"from":"0xYOUR_SENDER","to":"0xCONTRACT","data":"0x<abi-encode calldata>"}]'

Read `.result` (hex) as `--gas`. The setValue example's 132358 is geth `--dev`'s estimate for a fresh storage
write to the handwritten store contract in `scripts/e2e.d/evm-devnet.sh` (untested); your contract will differ.

## Tests

`scripts/e2e.d/contract-tx.sh` covers the build, verify, sign (pty) and broadcast path against a local mock that
accepts bytes but does not execute the EVM. `scripts/e2e.d/evm-devnet.sh` (untested) runs the same path against a real geth
`--dev` node (version and sha256 pinned in `scripts/evm-pins/geth`), under both the default dev schedule and
Amsterdam. With gas from `eth_estimateGas` it checks that each creation gets receipt status `0x1`, that `eth_getCode`
equals the runtime, and that `contract-call` reads 42. A `setValue(7)` call on a store contract gets status `0x1`
and reads back 7, and a plain value transfer gets status `0x1`. Gas below the estimate gets status `0x0`, and on
Amsterdam `--gas 100000` reproduces the Sepolia failure.
