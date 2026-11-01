# EVM: inspect a deployed contract (code, ABI, selectors, sources)

> ⚠️ DANGEROUS: use at your own risk. Code that handles keys and signs transactions should
> always be read and audited by you before you trust it with real funds. Used incorrectly,
> it can destroy your money.

Task: before interacting, see what is deployed and what its ABI claims. Part of the
[EVM contract recipes](evm-contract-data.md). Proxies and EIP-7702 delegations:
[evm-check-proxy-delegation.md](evm-check-proxy-delegation.md).

Fixtures are raw Ethereum mainnet JSON-RPC responses in [fixtures/evm-mainnet/](fixtures/evm-mainnet/); the request
behind each file is in [PROVENANCE.md](fixtures/evm-mainnet/PROVENANCE.md). Live `curl` lines are UNTESTED here: CI never
touches the network.

## What is deployed: eth_getCode → bytecode-inspect

`06` is the runtime code of a small mainnet contract. The metadata trailer says solc 0.8.20; the dispatcher's
PUSH4/EQ constants are listed as selector candidates (a heuristic: confirm each with `sig-hash`):

<!-- e2e: expect="solc":"0.8.20" ; expect="0x8da5cb5b" ; rc=0 -->
    bytecode-inspect < recipes/fixtures/evm-mainnet/06-getCode-small.json | jq -c '{kind, size, exceeds_eip170, solc: .metadata.solc, selector_candidates}'

`0x8da5cb5b` is `owner()`:

<!-- e2e: expect="owner()" ; rc=0 -->
    sig-hash 'owner()'

## What an ABI implements, and selector collisions

[fixtures/evm/erc20-plus-collision.txt](fixtures/evm/erc20-plus-collision.txt) is the EIP-20 function list plus
`gasprice_bit_ether(int128)`, whose selector is also `0x23b872dd` (`transferFrom`):

<!-- e2e: expect="selector":"0x23b872dd" ; rc=0 -->
    abi-inspect recipes/fixtures/evm/erc20-plus-collision.txt | jq -c .selector_collisions

<!-- e2e: expect="complete":true,"interface":"ERC-20" ; rc=0 -->
    abi-inspect recipes/fixtures/evm/erc20-plus-collision.txt | jq -c '.interfaces[0]'

A compiler artifact (`{"abi": [...]}`) or a bare ABI array works the same.

## Are these the sources? Offline metadata check (no compiler)

solc appends a CBOR trailer holding the IPFS hash of the exact `metadata.json` it wrote, which lists every source's
keccak256. `bytecode-inspect --metadata FILE [--sources DIR]` re-hashes them and compares: no compiler runs, so this
proves the files are the ones the build hashed, nothing more. Fixture: a solc 0.8.26 build
([fixtures/evm-sol/PROVENANCE.md](fixtures/evm-sol/PROVENANCE.md)):

<!-- e2e: expect="metadata_match":true ; expect="status":"match" ; expect="sources_missing":0 ; expect="status":"ok" ; rc=0 -->
    bytecode-inspect --metadata recipes/fixtures/evm-sol/Counter.metadata.json --sources recipes/fixtures/evm-sol < recipes/fixtures/evm-sol/Counter.runtime.hex

A changed source is `"status":"mismatch"`, exit 1. Not included: ABI or verified-source fetching.

Live (UNTESTED here): `curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["0x…","latest"]}' "$RPC" | bytecode-inspect`
