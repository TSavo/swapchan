# EVM: check an EIP-1167 proxy or EIP-7702 delegation before interacting

> ⚠️ DANGEROUS: use at your own risk. Code that handles keys and signs transactions should
> always be read and audited by you before you trust it with real funds. Used incorrectly,
> it can destroy your money.

Task: the address you are about to call or sign for may run someone else's code. An EIP-1167 minimal proxy forwards
every call to a fixed implementation; an EIP-7702 delegated account (an EOA with code `0xef0100` + address) runs the
delegate's code. Read `eth_getCode` and classify it, offline. Part of the [EVM contract recipes](evm-contract-data.md).

EIP-1167 (the reference code from the EIP, implementation `0xbebe…`):

<!-- e2e: expect="kind":"eip1167_proxy" ; expect="implementation":"0xBEbeBeBEbeBebeBeBEBEbebEBeBeBebeBeBebebe" ; rc=0 -->
    bytecode-inspect 0x363d3d373d3d3d363d73bebebebebebebebebebebebebebebebebebebebe5af43d82803e903d91602b57fd5bf3 | jq -c '{kind, implementation}'

EIP-7702 delegation designator (`0xef0100` followed by the delegate address; constructed, same placeholder address):

<!-- e2e: expect="kind":"eip7702_delegation" ; expect="delegate":"0xBEbeBeBEbeBebeBeBEBEbebEBeBeBebeBeBebebe" ; rc=0 -->
    bytecode-inspect 0xef0100bebebebebebebebebebebebebebebebebebebebe | jq -c '{kind, delegate}'

Ordinary contract code is `"kind":"code"` (fixture `06`, a mainnet `eth_getCode` response):

<!-- e2e: expect="kind":"code" ; rc=0 -->
    bytecode-inspect < recipes/fixtures/evm-mainnet/06-getCode-small.json | jq -c '{kind, solc: .metadata.solc}'

Then inspect the implementation or delegate the same way ([evm-inspect-contract.md](evm-inspect-contract.md)): fetch its
code and run `bytecode-inspect` on it.

NOT BUILT: upgradeable proxies that keep the implementation in a storage slot (EIP-1967, transparent, UUPS, beacon).
`bytecode-inspect` reports their code as `"kind":"code"`; reading the slot needs `eth_getStorageAt`, which no tool here
decodes for you. Live (UNTESTED here): `curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["0x…","latest"]}' "$RPC" | bytecode-inspect`
