# EVM: compute a CREATE or CREATE2 address

> ⚠️ DANGEROUS: use at your own risk. Code that handles keys and signs transactions should
> always be read and audited by you before you trust it with real funds. Used incorrectly,
> it can destroy your money.

Task: know where a contract is (or will be) deployed before you trust or fund that address. Part of the
[EVM contract recipes](evm-contract-data.md).

Fixtures are raw Ethereum mainnet JSON-RPC responses in [fixtures/evm-mainnet/](fixtures/evm-mainnet/); the request
behind each file is in [PROVENANCE.md](fixtures/evm-mainnet/PROVENANCE.md). Live `curl` lines are UNTESTED here: CI never
touches the network.

CREATE: `keccak256(rlp([deployer, nonce]))`. `05a` is a deployment tx; `create-address` reads `from` and `nonce`, and
the result matches `contractAddress` in its receipt `05b`:

<!-- e2e: expect="address":"0x0a0e5274D286A72614a4E4015370395Ef9E42EEd" ; rc=0 -->
    create-address < recipes/fixtures/evm-mainnet/05a-create-tx.json

CREATE2 (EIP-1014): `keccak256(0xff ++ deployer ++ salt ++ keccak256(init_code))`. `05c`/`05d` create the Uniswap V3
USDT pool (token0 `0x3246…8edb`, token1 USDT, fee 100). The salt is `keccak256(abi.encode(token0, token1, fee))`; the
init-code hash is the factory's fixed `POOL_INIT_CODE_HASH` from Uniswap's `PoolAddress.sol` (not fetched):

<!-- e2e: expect="address":"0x7fF72b3aab6db0398e7fbCaB8efcd37159323EcF" ; rc=0 -->
    abi-encode --raw '(address,address,uint24)' 0x3246806c924fab68dd6db5d39b516ade72618edb 0xdac17f958d2ee523a2206206994597c13d831ec7 100 | sig-hash --keccak | jq -c '{deployer: "0x1F98431c8aD98523631AE4a59f267346ea31F984", salt: .keccak256, init_code_hash: "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54"}' | create-address | jq -c '{scheme,address}'

It matches the pool address in the `PoolCreated` log of `05d`:

<!-- e2e: expect=0x7ff72b3aab6db0398e7fbcab8efcd37159323ecf ; rc=0 -->
    jq -r '.result.logs[0].data' recipes/fixtures/evm-mainnet/05d-create2-pool-receipt.json | abi-decode --types '(int24,address)' | jq -r '.args[1].value' | tr A-F a-f

Live (UNTESTED here): `curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionByHash","params":["0x…"]}' "$RPC" | create-address`
