# rpc: talk to node and wallet RPC endpoints

`rpc` is a small host-side network tool that works as a pipe filter, in the style of netcat. It sends one call, or a stdin
batch, to a node or wallet endpoint. The raw response goes to stdout. Errors go to stderr as one JSON line.
It uses the same HTTP client (`crates/net`, minreq + rustls, no Tokio) and the same per-chain endpoint table
(`blocktools_net::ENDPOINTS`) as `utxo-fetch` and `tx-broadcast`. Like them, it is excluded from the sealed image (Dockerfile,
`scripts/docs-check.sh` rule 4) and sealed-run never allows it.

`rpc` has no config or project files. The man page is `man/man1/rpc.1`, generated from `rpc --help` by `scripts/gen-man.py`.

Platform: everything on this page was measured on Linux (x86_64). Nothing here was run on macOS.

## Shapes

```
rpc URL METHOD [PARAMS-JSON]      one JSON-RPC call (EVM, bitcoind and forks, Solana)
... | rpc URL                     JSON-RPC request(s) on stdin: one object or a batch array, sent byte-for-byte
rpc URL /PATH [BODY-JSON]         REST: GET, or POST when BODY is given (Tron, Cosmos LCD, Esplora, Blockbook)
rpc URL SHORTCUT [ARG]            height | chainid | balance ADDR | nonce ADDR | account ADDR | utxos ADDR | tx ID | receipt ID | fee | blockhash
rpc URL rawtx TXID [BLOCKHASH]    bitcoind: {"protocol","txid","tx":HEX[,"blockhash"]}, hash-checked; pipes into tx-decode
rpc URL block [HEIGHT|HASH]       bitcoind: {"protocol","height","hash","time","n_tx","previous","txids"} (default: tip)
rpc URL blockinfo                 bitcoind: {"protocol","chain","blocks","headers","best","progress","pruned"}
... | rpc URL prevtxs             bitcoind: tx on stdin -> one rawtx line per input txid, for tx-decode --prevtxs
... | rpc URL sendraw             broadcast ONE signed tx; decoded summary + typed code on the terminal
                                 (UTXO: input values and fee shown; unknown fee needs ACK FEE-UNKNOWN too)
```

Two output shapes: shortcuts print one tidy JSON object per line. Passthrough (`METHOD` or stdin) prints the node's
raw envelope `{"result":...,"error":...,"id":...}`, so read `.result`. `PARAMS-JSON` is ONE argument holding a JSON
array (or object): `rpc URL getblockhash '[2]'`. `rpc URL getblockhash 2` and two separate params are `bad_input`
(exit 2) and nothing is sent.

Refusal or node answer? Read `status` in the stderr JSON line. `refused` means rpc sent nothing. `rpc_error` or
`http_error` means the node answered. All three exit 1. `bad_input` (exit 2, e.g. `auth_empty` for an empty
`--auth-file`) is decided before any connection. In a pipeline (`rpc ... | tx-decode`), the exit status is the last
command's: `rpc URL dumpprivkey '["x"]' | cat` exits 0 in bash with `PIPESTATUS` `1 0`. Use `set -o pipefail` or
branch on `status`. These rules are tested in `tools/rpc/tests/cli.rs` and `scripts/e2e.d/rpc-decode.sh`. Worked
pipeline: [recipes/rpc-decode.md](../recipes/rpc-decode.md).

`URL` can also be a chain name from the shared table (`btc`, `ltc`, `eth`, `ada`, `dot`, `ton`, `atom`, `xlm`, `algo`) or the
EVM chain id `1`. For any other EVM chain, pass its RPC URL and pin the chain id as a plain argument: `--chain-id 137`.

Exit status: 0 ok, 2 bad input, 1 everything else (RPC or HTTP error, refused, aborted): the shared rule in docs/EXIT-CODES.md.

Options: `--protocol P`, `--chain-id N`, `--chain C` (UTXO chain for address checks and sendraw decoding; default btc),
`--auth-file FILE`, `--auth-env NAME`, `--policy FILE`, `--allow-wallet-sign`, `--timeout N` (1..300, default 30).

## Auto-detection

Detection runs in this order. The first rule that matches wins. `--protocol` overrides all of them.

1. **URL substring** (`URL_RULES` in `tools/rpc/src/lib.rs`):
   - `solana`, `:8899`, `helius` → sol
   - `tron`, `:8090` → tron
   - `blockbook`, `/api/v2` → blockbook
   - `esplora`, `blockstream.info`, `mempool.space`, `litecoinspace` → esplora
   - `cosmos-rest`, `lcd`, `:1317`, `cosmos.directory`, `polkachu` → cosmos
   - bitcoind-family ports `:8332 :18332 :18443 :38332 :9332 :19332 :22555 :44555` → btc
   - `:8545`, `infura`, `alchemy`, `-rpc.publicnode.com`, `flashbots`, `drpc`, `llamarpc` → evm
2. **Method name**:
   - `eth_` / `net_` / `web3_` / `personal_` / `wallet_` / `debug_` / `txpool_` → evm
   - a known Solana camelCase method → sol
   - all-lowercase → btc (bitcoind, litecoind, dogecoind and other forks)
3. **Shortcuts only**, read-only probes in this order:
   - `eth_chainId` returns a string → evm
   - `getVersion` has `solana-core` → sol
   - `getblockchaininfo` has `chain` → btc
   - otherwise the call is refused with `protocol_unknown`; pass `--protocol`.

Passthrough calls do not need a protocol. Their bytes are sent as given.

## Per-protocol usage

The output below was captured from the binary against `scripts/mock-chain.py` (port shown as PORT) and a one-shot local mock.
The one public endpoint call is labelled.

### EVM JSON-RPC (any chain)

Measured on 2026-10-25 20:39 PDT on the Linux box (x86_64). This is a harmless read-only call to a public endpoint:

```
$ rpc https://ethereum-rpc.publicnode.com eth_blockNumber
{"jsonrpc":"2.0","result":"0x190e9b3","id":1}
$ rpc eth height
{"height":26274227,"protocol":"evm"}
```

Mock:

```
$ rpc --protocol evm http://127.0.0.1:PORT account 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf
{"balance":"1000000000000000000","chain_id":1,"max_fee_per_gas":"2100000000","max_priority_fee_per_gas":"100000000","nonce":5}
$ rpc --protocol evm http://127.0.0.1:PORT nonce 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf
{"address":"0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf","nonce":5,"protocol":"evm"}
```

The `account` shortcut prints the same object as `utxo-fetch --chain eth` (the file that `tx-build --account FILE` reads). The
e2e script checks this.

The default shortcut set maps to the read-only EVM methods that SwapChan uses (`readchain.ts`):

| shortcut | method |
|---|---|
| `height` | `eth_blockNumber` |
| `chainid` | `eth_chainId` |
| `balance ADDR` | `eth_getBalance [ADDR,"latest"]` |
| `nonce ADDR` | `eth_getTransactionCount [ADDR,"pending"]` |
| `tx HASH` | `eth_getTransactionByHash` |
| `receipt HASH` | `eth_getTransactionReceipt` |
| `fee` | `eth_gasPrice` + `eth_maxPriorityFeePerGas` |
| `account ADDR` | chainId + nonce + balance + fees (utxo-fetch shape) |

`eth_call`, `eth_getStorageAt`, `eth_getCode`, `eth_getLogs` and `eth_getBlockByNumber` / `eth_getBlockByHash` go through
passthrough, for example `rpc URL eth_getCode '["0x...","latest"]'`.

Public RPCs usually refuse a full-range `eth_getLogs`, one with no `fromBlock` or with `fromBlock` set to `earliest`/`0x0`. In
that case `rpc` prints a `getlogs_full_range` warning on stderr and still sends the call.

`--chain-id N` refuses the call (`chain_id_mismatch`) unless the endpoint's `eth_chainId` equals N.

**Flashbots Protect**: `https://rpc.flashbots.net/fast` is an optional private broadcast URL, for example
`... | rpc https://rpc.flashbots.net/fast sendraw`. No code is specific to Flashbots. It is simply a URL. Untested: no
broadcast was made.

### Bitcoin Core-style JSON-RPC (bitcoind, litecoind, dogecoind, other forks)

```
rpc --auth-file ~/.bitcoin/.cookie http://127.0.0.1:8332 getblockcount
rpc --auth-file ~/.bitcoin/.cookie http://127.0.0.1:8332 utxos bc1q...      # scantxoutset; prints utxo-fetch lines
rpc --chain ltc --auth-file ~/.litecoin/.cookie http://127.0.0.1:9332 balance ltc1q...
```

- `utxos` turns the node's decimal amounts into integer base units with an exact decimal parse, not floats. `0.29` becomes
  `29000000`.
- For legacy inputs, `utxos` adds `prev_tx` using `getblockhash` + `getrawtransaction`, using the same rule as utxo-fetch.
- `fee` uses `estimatesmartfee 6` and reports sat/vB.
- `rawtx TXID [BLOCKHASH]` calls `getrawtransaction TXID false [BLOCKHASH]` and checks that the hex hashes to TXID
  (`node_tx_hash_differs` otherwise). A pruned node without `-txindex` returns error -5 unless you give the block
  hash; rpc passes the error on (`rpc_error`, exit 1) and adds a `hint`.
- `block [HEIGHT|HASH]` calls `getblockhash` (when given a height) and then `getblock HASH 1`, so it returns txids only
  and stays under the response cap. `blockinfo` is `getblockchaininfo`.
- `prevtxs` reads a tx (hex or rawtx JSON) on stdin and runs `rawtx` once per distinct input txid, with no block
  hash, so it needs `-txindex`. Its output is the `--prevtxs FILE` for `tx-decode`, which then reports input
  values and the fee. tx-decode itself never opens a socket.
- All four use allowlisted read methods and work without `--allow-unlisted`.

### Solana JSON-RPC

```
rpc https://solana-rpc.publicnode.com getSlot
rpc --protocol sol URL balance ADDR      # lamports
rpc --protocol sol URL blockhash
```

### Tron HTTP API

```
rpc --protocol tron https://tron-rpc.publicnode.com balance TXYZ...           # POST wallet/getaccount {"address":..,"visible":true}
rpc https://tron-rpc.publicnode.com /wallet/getnowblock '{}'
```

Tron quirks:
- Reads work on PublicNode, but broadcast goes to TronGrid.
- Requests need `"visible":true` so that addresses are base58. The shortcuts add it. With raw `/PATH` calls you must include
  it yourself.
- `rpc` does not broadcast Tron transactions. `wallet/broadcasttransaction` is refused with `broadcast_needs_sendraw`, and
  `sendraw` does not support Tron (`sendraw_unsupported_protocol`). Untested.

### Cosmos REST / LCD

```
rpc atom height
rpc atom balance cosmos1...        # /cosmos/bank/v1beta1/balances/ADDR
rpc atom nonce cosmos1...          # account_number + sequence
rpc atom /cosmos/base/tendermint/v1beta1/node_info
```

### Esplora and Blockbook REST (GET passthrough)

```
$ rpc --protocol esplora http://127.0.0.1:PORT utxos bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4
{"address":"bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4","amount":50000,"txid":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","vout":0}
rpc btc /blocks/tip/height
rpc https://btc1.trezor.io/api/v2 utxos bc1q...      # blockbook
```

The Esplora `utxos` shortcut calls the same `blocktools_net::esplora_utxos` function as `utxo-fetch`. The e2e script checks
that both commands print identical bytes.

## Per-provider UTXO REST field differences

`rpc` passes these responses through as raw bytes. Only Esplora, Blockbook and bitcoind are normalised by the `utxos` shortcut.
Normalise other providers in your own pipeline:

| provider | txid / index fields | amount |
|---|---|---|
| Esplora | `txid` / `vout` | `value`, integer base units |
| Blockbook | `txid` / `vout` | `value`, decimal string in base units |
| bitcoind `scantxoutset` | `txid` / `vout` | `amount`, coins (decimal) |
| chainz.cryptoid.info | `tx_hash` / `tx_ouput_n` (sic, misspelled) | `value`, always 1e8 units, whatever the coin's decimals |
| qtum.info | `transactionId` / `outputIndex` | `value` |
| WhatsOnChain | `tx_hash` / `tx_pos` | `value` |
| Insight | `txid` / `vout` | `satoshis` (plus `amount` in coins) |

## Rate limits and pacing

`rpc` has no hidden retries, and it never runs requests in parallel. Each run makes one request, plus any requests a shortcut
needs, done in sequence. Pace the runs yourself (for example `sleep` between calls in a loop) and choose providers in this
order:

- novacoin explorers returned 503 at 8 parallel requests. Keep calls sequential.
- cryptoid allows about 1 call per 10 s without a key.
- the GRS explorer returned 429 on 2026-10-25.
- keyless TronGrid returns 429. Try PublicNode first for Tron reads.

These are SwapChan's field observations from `/workspace/handoff/rpc-knife-requirements.md`. `rpc` did not measure them
(unmeasured).

## Slow methods and timeouts

Every rpc request has one wall-clock timeout covering the whole request. It is 30 s by default.
These methods get 3600 s instead: `dumptxoutset`, `loadtxoutset`, `scantxoutset` (also behind the `utxos`
shortcut), `gettxoutsetinfo`, `rescanblockchain`, `verifychain`, `importmulti` and `rescanwallet`.
`importdescriptors` is on the slow list too, but the deny-list refuses it first (it carries secrets), so it is
never sent. `--timeout SECS` (1..86400) overrides both.

When the timeout passes, rpc writes stderr status `"timeout"`, not `http_error`. The status includes
`timeout_secs` and `timeout_source` (`--timeout`, `slow_method_default` or `default`), and rpc exits 1.
A timeout only stops rpc from waiting. The node may still be running the call.

`dumptxoutset` is not on the read allowlist, because it writes a file. It needs `--allow-unlisted`:

    rpc --allow-unlisted --auth-file ~/.bitcoin/.cookie http://127.0.0.1:8332 dumptxoutset '["/path/utxo.dat"]'

The file is written **on the node host**, at a path the node chooses, not where rpc runs. If you
time out, the node keeps writing the file. Wait for it to finish rather than starting a second dump.
`contract-call` and `contract-trace` take `--timeout` 1..300 and report the same `"timeout"` status.
`tx-broadcast` keeps a fixed 30 s, and a timeout there reads `timeout: no complete response within 30 s`.

## Credentials (wallet RPC)

- `--auth-file FILE` or `--auth-env NAME` accepts these forms:
  - `user:pass` or a bitcoind `.cookie` → `Authorization: Basic`
  - `Bearer TOKEN` or a bare token → `Authorization: Bearer`
  - `Header-Name: value` lines (e.g. `TRON-PRO-API-KEY: ...`) → those headers
- `--user`, `--password`, `--token`, `--header`, `-u` and `-H` are refused with `credential_on_command_line`.
- Userinfo in the URL (`http://u:p@host`) is refused with the same code.
- The raw value, the password, the token and the Base64 form are all redacted (`[REDACTED]`) from stdout and from stderr. This
  covers the case where a server echoes them back.
- Values shorter than 4 characters are not redacted, because that would mangle unrelated output. Do not use a password that
  short.

## sendraw shows the fee

A signed UTXO transaction does not carry its input amounts, so on its own the confirmation could only say
"fee: UNKNOWN". `sendraw` now fills them in before it prompts: from `--prevtxs FILE` (the output of
`rpc URL prevtxs`, or one hex tx per line), or else by asking the endpoint it is about to broadcast to
(bitcoind `getrawtransaction`, Esplora `GET tx/ID/hex`), through the same allowlist as every other call. Each
previous tx must hash to the txid the input names. With them the summary shows each input's address and value and
`fee : … (~N sat/vB)`. If any are missing (pruned node without `-txindex`, Blockbook, a 404), the summary starts with a
`FEE UNKNOWN` banner saying which txids were not found, and you must type `ACK FEE-UNKNOWN` before the usual code;
anything else aborts and nothing is sent. On a pruned node, run `rpc URL rawtx TXID BLOCKHASH` for each input, then
pass the lines to `--prevtxs`. Tested against scripts/mock-bitcoind.py (a fake regtest node, not bitcoind) by
`scripts/e2e.d/sendraw-fee.sh`: the fee 0.00001000 is in the confirmation text, and refusing the ACK sends nothing.
`tx-broadcast` given bare signed UTXO hex (no input values, so no fee) shows the same banner and wants the same
`ACK FEE-UNKNOWN`; the tx-sign JSON output carries the input values and needs only the code. Tested in
`scripts/e2e.d/net.sh` against scripts/mock-chain.py: refusing the ACK posts nothing, the ACK plus the code posts once.
A hostile endpoint can force the banner by answering "not found" (docs/SECURITY.md, known limits).

## Safety: what is refused

The agent must never see keys, seeds or passwords. Every refusal exits 1 (status refused), and nothing is sent to the server:

| code | when |
|---|---|
| `method_exports_secrets` | a method from the table below that prints keys or seeds, or `listdescriptors` / `gethdkeys` with private=true |
| `method_imports_secrets` | the method takes a private key or seed as a parameter |
| `method_unlocks_wallet` | the method sends a wallet passphrase (`walletpassphrase`, `personal_unlockAccount`, `createwallet` with a passphrase) |
| `method_wallet_signs` | the wallet signs with its own key (always refused, flag or not) |
| `method_wallet_spends` | the wallet builds, signs and sends (`sendtoaddress`, `payto`, `transfer`, ...) |
| `wallet_sign_needs_flag` | `eth_sendTransaction` / `eth_signTypedData_v4` without `--allow-wallet-sign` |
| `wallet_sign_undecodable` | the flagged request cannot be decoded completely into a summary |
| `wallet_sign_chain_mismatch` | the flagged request's chain id differs from the endpoint's `eth_chainId` (or from `--chain-id`) |
| `wallet_sign_chain_unknown` | the flagged request has no chain id and none was given with `--chain-id` |
| `wallet_sign_permit_unasserted` | `eth_signTypedData_v4` is a recognised permit (EIP-2612, DAI, Permit2) and `--expect-spender` was not given |
| `wallet_sign_seaport_unasserted` | `eth_signTypedData_v4` is a Seaport order (OrderComponents / BulkOrder, or domain name Seaport) and neither `--allow-seaport-order` nor `--expect-min-consideration` was given |
| `seaport_no_consideration` / `seaport_dust_consideration` / `seaport_unknown_deployment` / `seaport_not_checkable` | the Seaport order returns nothing nonzero to the offerer, less than every `--expect-min-consideration` floor, is not Seaport 1.5 / 1.6 at its canonical address, or cannot be read |
| `wallet_sign_spender_unrecognised` | `eth_signTypedData_v4` is not a recognised permit but has address fields named like a spender (spender, operator, delegate, approved, allowed) |
| `spender_not_expected` / `amount_not_expected` / `unlimited_approval` | the permit's spender or an amount differs from `--expect-spender` / `--expect-amount`, or an amount is unlimited (>= 2^128, uint160 max, DAI `allowed=true`) without `--expect-unlimited` |
| `method_not_allowlisted` | the method or REST path is not in the protocol's read allowlist (below) and `--allow-unlisted` was not given |
| `method_denied_by_policy` | the method is in the `--policy` file's `rpc.deny` list |
| `request_contains_secret_field` | the params contain a field named privateKey, password, mnemonic, seed, wif, xprv, ... |
| `broadcast_needs_sendraw` | a raw broadcast (`eth_sendRawTransaction`, `sendrawtransaction`, POST `/tx`, Tron broadcast, ...) outside `sendraw` |
| `response_contains_secret` | the response has a key-like field (privkey, mnemonic, ...) or an xprv/tprv string. Nothing is printed |
| `credential_on_command_line` | a credential was given as an argument or in the URL |
| `chain_id_mismatch` | `--chain-id`, or a sendraw tx's chain id, differs from the endpoint |
| `protocol_unknown` | a shortcut could not detect the protocol |
| `unsupported_for_protocol` | the shortcut does not exist for that protocol |
| `not_signed`, `chain_or_signature_mismatch`, `sendraw_unsupported_protocol` | sendraw input checks |
| `policy_unknown_key` | the policy file has a key other than `version`, `rpc.deny` or `chains` (exit 2) |

Other statuses on stderr: `rpc_error` (the server returned a JSON-RPC error, exit 1), `http_error` (non-2xx, a non-JSON
reply, a redirect, a timeout or an oversized response, exit 1), `bad_input` (exit 2), and `aborted` (sendraw got no terminal
or a wrong code, exit 1).

### The read allowlist (fail closed)

`ALLOW` in `tools/rpc/src/lib.rs` is the only allowlist. A call is sent only if its method (JSON-RPC) or path (REST,
leading `/` and query string ignored, case ignored) is a row for the endpoint's protocol; when the protocol is not
detected, a row of any protocol counts. `…` marks a prefix row. Anything else is refused with `method_not_allowlisted`
and nothing is sent, unless `--allow-unlisted` is given. `--allow-unlisted` never opens a deny-list row, a secret-field
request or a broadcast: broadcasts still go only through `sendraw`. The lib test `allow_table_documented` fails if a row
is missing below, and the CLI test `unlisted_methods_send_zero_bytes` sends unlisted and made-up wallet-style methods
(EVM, bitcoind, Solana, Tron, Cosmos, Esplora, and a mixed batch) to a recording mock node and asserts it received
zero connections.

| protocol | allowed reads |
|---|---|
| evm | `eth_blocknumber`, `eth_chainid`, `eth_getbalance`, `eth_gettransactioncount`, `eth_getcode`, `eth_getstorageat`, `eth_call`, `eth_estimategas`, `eth_gasprice`, `eth_maxpriorityfeepergas`, `eth_feehistory`, `eth_blobbaseprice`, `eth_getblockbynumber`, `eth_getblockbyhash`, `eth_getblockreceipts`, `eth_getblocktransactioncountbynumber`, `eth_getblocktransactioncountbyhash`, `eth_gettransactionbyhash`, `eth_gettransactionreceipt`, `eth_gettransactionbyblocknumberandindex`, `eth_gettransactionbyblockhashandindex`, `eth_getlogs`, `eth_getproof`, `eth_syncing`, `eth_protocolversion`, `eth_createaccesslist`, `net_version`, `net_listening`, `net_peercount`, `web3_clientversion`, `web3_sha3` |
| btc | `getblockchaininfo`, `getblockcount`, `getbestblockhash`, `getblockhash`, `getblock`, `getblockheader`, `getblockstats`, `getchaintips`, `getdifficulty`, `getrawtransaction`, `decoderawtransaction`, `decodescript`, `decodepsbt`, `gettxout`, `gettxoutsetinfo`, `gettxoutproof`, `scantxoutset`, `getmempoolinfo`, `getrawmempool`, `getmempoolentry`, `testmempoolaccept`, `estimatesmartfee`, `getnetworkinfo`, `getconnectioncount`, `getindexinfo`, `validateaddress`, `getdescriptorinfo`, `uptime` |
| sol | `getaccountinfo`, `getbalance`, `getblock`, `getblockheight`, `getblocktime`, `getepochinfo`, `getfeeformessage`, `getgenesishash`, `gethealth`, `getlatestblockhash`, `getminimumbalanceforrentexemption`, `getmultipleaccounts`, `getprogramaccounts`, `getrecentprioritizationfees`, `getsignaturestatuses`, `getsignaturesforaddress`, `getslot`, `gettokenaccountbalance`, `gettokenaccountsbyowner`, `gettransaction`, `getversion`, `isblockhashvalid`, `simulatetransaction` |
| tron | `wallet/getnowblock`, `wallet/getblockbynum`, `wallet/getblockbyid`, `wallet/getaccount`, `wallet/getaccountresource`, `wallet/gettransactionbyid`, `wallet/gettransactioninfobyid`, `wallet/triggerconstantcontract`, `wallet/getchainparameters`, `wallet/getnodeinfo`, `wallet/validateaddress`, `walletsolidity/getaccount`, `walletsolidity/gettransactioninfobyid` |
| cosmos | `cosmos/base/tendermint/v1beta1/`…, `cosmos/bank/v1beta1/`…, `cosmos/auth/v1beta1/accounts/`…, `cosmos/staking/v1beta1/`…, `cosmos/distribution/v1beta1/`…, `cosmos/tx/v1beta1/txs/`…, `cosmos/tx/v1beta1/txs`, `cosmos/tx/v1beta1/simulate`, `cosmos/gov/v1beta1/`…, `cosmos/gov/v1/`… |
| esplora | `blocks/`…, `block/`…, `block-height/`…, `tx/`…, `address/`…, `scripthash/`…, `fee-estimates`, `mempool`… |
| blockbook | `api/v2`, `api/v2/tx/`…, `api/v2/tx-specific/`…, `api/v2/address/`…, `api/v2/xpub/`…, `api/v2/utxo/`…, `api/v2/block/`…, `api/v2/block-index/`…, `api/v2/estimatefee/`… |

### The deny-list (single source of truth)

`DENY` in `tools/rpc/src/lib.rs` is the only table. Matching ignores case and reads the whole method or path. The lib test
`deny_table_documented` fails if a row is missing below. SwapChan's key-export list is a subset of these rows
(`swapchan_key_export_list_is_a_subset`): dumpprivkey, dumpwallet, importprivkey, backupwallet, `listdescriptors true`, sethdseed,
personal_importRawKey, personal_unlockAccount, keystore exports (`personal_*`, `parity_*`, `account_*`), and Electrum
getprivatekeys/getseed.

| method (case-insensitive) | match | refusal code | family |
|---|---|---|---|
| `dumpprivkey` | exact | `method_exports_secrets` | bitcoind |
| `dumpwallet` | exact | `method_exports_secrets` | bitcoind |
| `backupwallet` | exact | `method_exports_secrets` | bitcoind |
| `dumpmasterprivkey` | exact | `method_exports_secrets` | bitcoind fork |
| `dumphdinfo` | exact | `method_exports_secrets` | dashd |
| `importprivkey` | exact | `method_imports_secrets` | bitcoind |
| `importwallet` | exact | `method_imports_secrets` | bitcoind |
| `importmulti` | exact | `method_imports_secrets` | bitcoind |
| `importdescriptors` | exact | `method_imports_secrets` | bitcoind |
| `sethdseed` | exact | `method_imports_secrets` | bitcoind |
| `upgradetohd` | exact | `method_imports_secrets` | dashd |
| `signrawtransactionwithkey` | exact | `method_imports_secrets` | bitcoind |
| `signmessagewithprivkey` | exact | `method_imports_secrets` | bitcoind |
| `walletpassphrase` | exact | `method_unlocks_wallet` | bitcoind |
| `walletpassphrasechange` | exact | `method_unlocks_wallet` | bitcoind |
| `encryptwallet` | exact | `method_unlocks_wallet` | bitcoind |
| `signrawtransactionwithwallet` | exact | `method_wallet_signs` | bitcoind |
| `signrawtransaction` | exact | `method_wallet_signs` | bitcoind (old) |
| `walletprocesspsbt` | exact | `method_wallet_signs` | bitcoind |
| `signmessage` | exact | `method_wallet_signs` | bitcoind |
| `sendtoaddress` | exact | `method_wallet_spends` | bitcoind |
| `sendmany` | exact | `method_wallet_spends` | bitcoind |
| `send` | exact | `method_wallet_spends` | bitcoind |
| `sendall` | exact | `method_wallet_spends` | bitcoind |
| `sendfrom` | exact | `method_wallet_spends` | bitcoind (old) |
| `bumpfee` | exact | `method_wallet_spends` | bitcoind |
| `personal_unlockaccount` | exact | `method_unlocks_wallet` | geth |
| `personal_importrawkey` | exact | `method_imports_secrets` | geth |
| `personal_exportrawkey` | exact | `method_exports_secrets` | geth |
| `personal_` | prefix | `method_wallet_signs` | geth |
| `eth_sign` | exact | `method_wallet_signs` | geth |
| `eth_signtransaction` | exact | `method_wallet_signs` | geth |
| `eth_signtypeddata` | exact | `method_wallet_signs` | geth |
| `eth_signtypeddata_v1` | exact | `method_wallet_signs` | wallet |
| `eth_signtypeddata_v3` | exact | `method_wallet_signs` | wallet |
| `account_` | prefix | `method_wallet_signs` | clef |
| `parity_exportaccount` | exact | `method_exports_secrets` | openethereum |
| `parity_` | prefix | `method_wallet_signs` | openethereum |
| `getprivatekeys` | exact | `method_exports_secrets` | electrum |
| `getseed` | exact | `method_exports_secrets` | electrum |
| `getmasterprivate` | exact | `method_exports_secrets` | electrum |
| `export_privkeys` | exact | `method_exports_secrets` | electrum |
| `importprivkey` | exact | `method_imports_secrets` | electrum |
| `signtransaction` | exact | `method_wallet_signs` | electrum |
| `password` | exact | `method_unlocks_wallet` | electrum |
| `payto` | exact | `method_wallet_spends` | electrum |
| `paytomany` | exact | `method_wallet_spends` | electrum |
| `query_key` | exact | `method_exports_secrets` | monero-wallet-rpc |
| `restore_deterministic_wallet` | exact | `method_imports_secrets` | monero-wallet-rpc |
| `generate_from_keys` | exact | `method_imports_secrets` | monero-wallet-rpc |
| `open_wallet` | exact | `method_unlocks_wallet` | monero-wallet-rpc |
| `transfer` | exact | `method_wallet_spends` | monero-wallet-rpc |
| `sweep_all` | exact | `method_wallet_spends` | monero-wallet-rpc |
| `wallet/easytransfer` | prefix | `method_imports_secrets` | tron |
| `wallet/gettransactionsign` | exact | `method_imports_secrets` | tron |
| `wallet/addtransactionsign` | exact | `method_imports_secrets` | tron |
| `wallet/createaddress` | exact | `method_exports_secrets` | tron |
| `wallet/generateaddress` | exact | `method_exports_secrets` | tron |
| `wallet/getaddressbyprivatekey` | exact | `method_imports_secrets` | tron |
| `wallet/getspendingkey` | exact | `method_exports_secrets` | tron |
| `wallet/getexpandedspendingkey` | exact | `method_exports_secrets` | tron |
| `wallet/getakfromask` | exact | `method_exports_secrets` | tron |
| `wallet/getnkfromnsk` | exact | `method_exports_secrets` | tron |
| `wallet/getnewshieldedaddress` | exact | `method_exports_secrets` | tron |
| `wallet/createshieldedtransaction` | exact | `method_imports_secrets` | tron |
| `wallet/createshieldedcontractparameters` | exact | `method_imports_secrets` | tron |
| `wallet/createspendauthsig` | exact | `method_imports_secrets` | tron |
| `keys` | prefix | `method_exports_secrets` | cosmos lcd (legacy) |
| `eth_sendtransaction` | exact | `wallet_sign_needs_flag` | geth / wallet (opened only by `--allow-wallet-sign`) |
| `eth_signtypeddata_v4` | exact | `wallet_sign_needs_flag` | geth / wallet (opened only by `--allow-wallet-sign`) |

A `--policy FILE` (`{"version":1,"rpc":{"deny":["eth_call","debug_*"]}}`) can only **add** refusals. A trailing `*` makes the
entry a prefix match. No key exists for allowing a method, and unknown keys are refused.

### `--allow-wallet-sign`

Only `eth_sendTransaction` and `eth_signTypedData_v4` can be opened, and only with the flag. With the flag, the wallet's own
UI is the human confirmation. Before anything is sent, `rpc`:

1. Decodes the request completely, or refuses it with `wallet_sign_undecodable`.
   - For sendTransaction, only known keys are accepted. `from` and `to` must be 20-byte addresses, and contract creation is
     refused. Quantities must be hex, and `data` and `input` must agree.
   - For typed data, `types`, `primaryType`, `domain` and `message` are required, and the message fields must equal the primary
     type's fields exactly. No hidden or extra fields are allowed.
   - For typed data, a recognised permit (EIP-2612, DAI, Permit2 PermitSingle / PermitBatch / PermitTransferFrom /
     PermitBatchTransferFrom) is refused unless `--expect-spender ADDR` matches its spender (and every batch entry
     matches `--expect-amount N`, if given); an unlimited amount also needs `--expect-unlimited`. A permit for exactly
     your balance is below 2^128, so only the spender catches a drainer. Typed data with spender-like address fields
     that is not a recognised permit is refused (`wallet_sign_spender_unrecognised`); there is no blanket allow. The
     same check is `typed-data-verify --expect-spender` (shared `permit::apply`).
   - A Seaport order (1.5 / 1.6 `OrderComponents` or `BulkOrder`) is refused (`wallet_sign_seaport_unasserted`) unless
     `--allow-seaport-order` or `--expect-min-consideration SPEC` is given (SPEC: `N` or `native:N` for the native
     currency, `0xTOKEN:N` for an ERC20, smallest units, comma-separated; at least one floor must be met). Even then an
     order that returns nothing to the signer (`seaport_no_consideration`), one below every floor
     (`seaport_dust_consideration`), another version or address (`seaport_unknown_deployment`) or an unreadable one
     (`seaport_not_checkable`) is refused. Same check: `typed-data-verify --expect-min-consideration`.
2. Fetches the endpoint's `eth_chainId`. The call is refused if it differs from the request's chain id (or from `--chain-id`),
   or if neither one gives a chain id.
3. Prints this summary on stderr, then sends the exact stdin or argument bytes:

```
wallet-sign eth_sendTransaction (the wallet will ask you to approve)
  from:     0x1111111111111111111111111111111111111111
  to:       0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
  value:    0 wei
  data:     selector 0xa9059cbb, 68 bytes
  chain id: 1
  endpoint chain id: 1 (matches)
```
```
wallet-sign eth_signTypedData_v4 (the wallet will ask you to approve)
  signer:      0x1111111111111111111111111111111111111111
  domain:
    name: USD Coin
    chainId: 1
    verifyingContract: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
  primaryType: Permit
  message:
    owner: 0x1111111111111111111111111111111111111111
    spender: 0x3333333333333333333333333333333333333333
    value: 1000000
    nonce: 0
    deadline: 1767225600
  endpoint chain id: 1 (matches)
```

The flag does not open `eth_sign`, `personal_sign`, `eth_signTransaction`, the other `personal_*` methods, or
`eth_signTypedData` v1/v3. Those are always refused. TronLink signing is a browser wallet, not an RPC method, so it is out of
scope.

### Untrusted responses

- Response bodies are data only. When stdout is a terminal, control characters are replaced so that escape sequences cannot
  act on the terminal.
- Responses larger than 8 MiB are refused.
- Redirects are never followed, to any host. A 3xx is an `http_error`, and v1 has no flag to change this.
- Only https URLs are accepted, except plain http to localhost/127.0.0.1.
- Shortcuts re-check what the server returns: txid hex, amounts, and the prev_tx hex.

## contract-call: eth_call with decoding, and one-shot state reads

`contract-call URL ADDRESS 'balanceOf(address) returns (uint256)' 0x...` builds the calldata from the signature and
arguments (same encoder as `abi-encode`), asks the endpoint for `eth_chainId` (printed on every line; `--chain-id N`
refuses any other chain before `eth_call` is sent), sends `eth_call` at `--block` (tag, number, or block hash as an
EIP-1898 `{"blockHash"}` object) and decodes the return data with the `returns (...)` types. `--abi FILE --read`
calls every view/pure function without inputs. JSON lines `{"to","sig","args","block","from"}` on stdin batch calls
(up to 1000). Both requests go through the same `check_call_in` as `rpc` (read allowlist, deny-list, `--policy`,
secret fields), responses carrying key material are withheld, and `--auth-file`/`--auth-env` values are redacted.

Results that are not a decoded value are never printed as one: a revert is `reverted` on stderr with the revert data
decoded (`Error(string)`, `Panic(uint256)`, custom errors from `--abi`/`--error`, exit 1); `0x` for a function that
declares returns is `empty_return` (no code at the address on that chain/block, or no such function); return data that
does not decode cleanly under the declared types (for example a `uint8` above 255) is `bad_return`. Tested against a
127.0.0.1 mock in `tools/contract-call/tests/cli.rs` and in `recipes/evm-eth-call.md`; not measured against a
live node. Decode the logs a node returns (`eth_getLogs`, receipts) with the offline `log-decode`.

## contract-trace: state overrides and debug_traceCall

`contract-trace URL ADDRESS SIGNATURE [ARG...]` (or `--data HEX|@FILE`) simulates the call. `--call-only` sends
`eth_call` with the `--state FILE` overrides as the third parameter (read allowlist). Without it the call goes to
`debug_traceCall` with `{"tracer","tracerConfig","stateOverrides"}`; that method is not in the read allowlist, so it
is refused (exit 1, nothing sent) unless `--allow-unlisted` is given. `callTracer` (default) output is one JSON line
per call frame, depth first, with the node's fields passed through and `--abi` selectors decoded into `"call"`; any
other `--tracer` name (or `struct` for no tracer) prints the raw result on one line. A reverted top frame still
prints its frames, then `reverted` on stderr and exit 1. The state file is validated locally (addresses, quantities,
32-byte slots, `state` and `stateDiff` exclusive). Same `check_call_in`, response secret check, credential
redaction and transport bounds as `contract-call`. Tested against a 127.0.0.1 mock in
`tools/contract-trace/tests/cli.rs` and in `recipes/evm-eth-call.md`; not measured against a live node.

## Cookbook (mock round trips, run by `scripts/e2e.d/rpc.sh`)

```
# BTC: rpc utxos | tx-build | tx-sign | rpc sendraw (esplora mock)
rpc --protocol esplora $U utxos $ADDR > utxos.jsonl
tx-build --chain btc --utxos utxos.jsonl --to $DEST --sweep --fee-rate 5 > unsigned
tx-sign --tx unsigned --expect-to $DEST < key > signed     # typed code on the terminal
rpc --protocol esplora $U sendraw < signed                 # summary + typed code; server id compared with local txid

# EVM: rpc account | tx-build | tx-sign | rpc sendraw
rpc --protocol evm $U account $ADDR > acct.json
tx-build --chain eth --chain-id 1 --account acct.json --to $DEST --sweep > unsigned
tx-sign --tx unsigned --chain-id 1 --expect-to $DEST < key > signed
rpc --protocol evm $U sendraw < signed                     # also refuses when the tx chain id differs from eth_chainId
```

Per-chain recipes live in the docs index, which the docs worker owns.

## What was run, and what is untested

Run on Linux (x86_64) on 2026-10-25:
- `cargo test -p rpc`: the lib tests, plus CLI tests against an in-process mock that records the raw request bytes.
- `scripts/e2e.d/rpc.sh`.
- `scripts/e2e.d/rpc-timeout.sh`: the mock holds the response open. It measured the 30 s default timeout
  (status `timeout` at 30.0 s), plus `--timeout 2`, the slow-method default and the dumptxoutset allowlist refusal.
- `scripts/e2e.d/rpc-decode.sh`: the recipes/rpc-decode.md pipeline against `scripts/mock-bitcoind.py`, a deterministic
  fake pruned regtest bitcoind (pruned and `-txindex` modes). It is a mock, not bitcoind.
- The single public read shown above.

Untested:
- Any real broadcast, including Flashbots, Tron broadcast and every mainnet `sendraw`.
- Real bitcoind, geth, Solana, Tron, Cosmos and Blockbook servers. Only mocks were used, except for the one publicnode read.
- macOS.
- The provider pacing figures (taken from SwapChan's notes).
- A wasm facade, which is not exposed. The pure logic in `tools/rpc/src/lib.rs` needs no network, but v1 ships only the CLI.
