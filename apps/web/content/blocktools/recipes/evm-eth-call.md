# EVM: run an eth_call and decode the return

> ⚠️ DANGEROUS: use at your own risk. Code that handles keys and signs transactions should
> always be read and audited by you before you trust it with real funds. Used incorrectly,
> it can destroy your money.

Task: read contract state (`balanceOf`, `decimals`, …) and get typed values back. Part of the
[EVM contract recipes](evm-contract-data.md).

Fixtures are raw Ethereum mainnet JSON-RPC responses in [fixtures/evm-mainnet/](fixtures/evm-mainnet/); the request
behind each file is in [PROVENANCE.md](fixtures/evm-mainnet/PROVENANCE.md). Live `curl` lines are UNTESTED here: CI never
touches the network.

## Decode a return you fetched yourself

`03c` is an `eth_call` of USDC `balanceOf`. Give the output types (USDC has six decimals, see `03a`):

<!-- e2e: expect="value":"58142937468866" ; rc=0 -->
    abi-decode --types uint256 < recipes/fixtures/evm-mainnet/03c-usdc-balanceOf.json

## Let contract-call send it

`contract-call` sends the `eth_call` (host-side, network; through `rpc`'s read allowlist and secret checks), reads
the chain id first and prints it on every line, then decodes with the `returns (...)` part. Here `$ETH/03a` is a
local mock on 127.0.0.1 answering with the recorded `03a` fixture; on a real node give its URL (`--chain-id N`
refuses any other chain):

<!-- e2e: expect="chain_id":1 ; expect="function":"decimals()" ; expect="value":"6" ; rc=0 -->
    contract-call $ETH/03a 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 'decimals() returns (uint8)'

`--abi FILE --read` calls every no-input view/pure function; `--block` pins a block. A revert comes back decoded with
exit 1; an empty `0x` reply to a function that declares returns is `empty_return` (no code there, or no such
function), never a zero. These two paths are tested in the tool's own tests, not in this recipe.

## State overrides and traces: contract-trace

`contract-trace` builds the same call (or raw `--data HEX|@FILE`) and either sends `eth_call` with state overrides
(`--call-only --state FILE`) or asks the node for `debug_traceCall`, one JSON line per call frame:

<!-- e2e: expect="status":"ok" ; expect="chain_id":1 ; expect="state_overrides":0 ; rc=0 -->
    contract-trace $ETH/03a 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --data 0x313ce567 --call-only

`debug_traceCall` is not in the read allowlist, so without `--allow-unlisted` it is refused and nothing is sent:

<!-- e2e: expect="status":"refused" ; expect="code":"method_not_allowlisted" ; rc=1 -->
    contract-trace $ETH/03a 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 'decimals()'

Live (UNTESTED here): `contract-trace "$RPC" 0x… --data @data.hex --from 0x… --state over.json --allow-unlisted`; most
public endpoints do not serve `debug_traceCall`. Both tools are tested against a mock RPC only, never a live node.
