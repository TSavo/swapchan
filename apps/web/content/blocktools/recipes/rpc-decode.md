# Fetch a transaction from your node and decode it (rpc | tx-decode)

`rpc` talks to a node you run. It refuses secret methods, has a read allowlist and never prints credentials.
`tx-decode` is offline and never opens a socket. The fee needs the previous transactions, so `rpc` fetches them
and `tx-decode` reads them from a file. This keeps every network byte inside rpc's guard.

## What the tests cover

There is **no real bitcoind in CI**. `scripts/mock-bitcoind.py` stands in for it: a deterministic fake of a
pruned regtest node on 127.0.0.1, with 3 synthetic blocks and one spend
(mock spend: 50000 sat in, 49000 sat out, fee 1000 sat). `scripts/e2e.d/rpc-decode.sh` runs the script block below against that mock, once as a pruned node and
once with `-txindex`, and checks every result shown in the comments. The example after it runs in
`scripts/recipe-check.py` on recorded mock output. The mock's replies copy bitcoind's shapes and error codes
(-5 for a tx it can't find, -8 for a bad height), but it is a mock. This recipe has not been run against a
real bitcoind (regtest or mainnet) (untested).

## The pipeline

Point `U` at your node (`http://127.0.0.1:8332` on mainnet). Put `user:password` in a file and pass
`--auth-file FILE`. Never put it in the URL or on the command line, where rpc refuses it.

<!-- rpc-decode: script (run by scripts/e2e.d/rpc-decode.sh against scripts/mock-bitcoind.py) -->
```sh
set -o pipefail                        # without it, `rpc ... | tx-decode` returns tx-decode's status only
rpc "$U" blockinfo                     # {"best":...,"blocks":2,"chain":"regtest",...,"pruned":true}
rpc "$U" block                         # tip: {"hash":...,"height":2,"n_tx":1,...,"txids":[TXID]}
TXID=$(rpc "$U" block | jq -r '.txids[0]')
BH=$(rpc "$U" block | jq -r .hash)
rpc "$U" rawtx "$TXID" "$BH" > tx.json # {"blockhash":...,"protocol":"btc","tx":HEX,"txid":TXID}, hash-checked
tx-decode < tx.json                    # summary + outputs; warnings: input_amounts_unknown (no prevouts yet)
rpc "$U" prevtxs < tx.json > prev.jsonl  # one rawtx line per input txid (needs -txindex on the node)
tx-decode --prevtxs prev.jsonl < tx.json # summary now has "fee":1000 and the input amount 50000
```

The same decode on the recorded mock output (this is what `recipe-check.py` runs):

<!-- e2e: expect="fee":1000 ; expect="amount":50000 ; expect="role":"input" -->
    jq -c . recipes/fixtures/rpc-decode/spend.json | tx-decode --prevtxs recipes/fixtures/rpc-decode/prevtxs.jsonl

## Gotchas

Each item is checked by `cargo test -p rpc --test cli`, `cargo test -p blocktools-tx --test prevtxs` or
`scripts/e2e.d/rpc-decode.sh`, as noted.

1. **Two output shapes.** Shortcuts (`height`, `rawtx`, `block`, `blockinfo`, `prevtxs`, ...) print one tidy
   JSON object per line. Passthrough (`rpc URL METHOD [PARAMS]` or a request on stdin) prints the node's raw
   envelope `{"result":...,"error":...,"id":...}`. So `rpc URL getrawtransaction ...` needs `jq -r .result`
   before tx-decode, while `rpc URL rawtx ...` pipes straight in, because tx-decode reads the `"tx"` field.
   (cli: `btc_rawtx_tidy_object_hash_checked_no_allow_unlisted`, `passthrough_is_raw_envelope_and_params_are_one_json_array`)
2. **Refused or answered? Read the `status` field** of the JSON error line on stderr. `"refused"` means rpc sent
   nothing (deny-list, allowlist, secret in the response). `"rpc_error"` and `"http_error"` mean the node
   answered. All three exit 1. `"bad_input"` exits 2 and is decided locally before any connection.
   (cli: `btc_secret_methods_refused_even_with_allow_unlisted_nothing_sent`; e2e: request log empty after refusals)
3. **`--allow-unlisted` lifts only the read allowlist.** `dumpprivkey`, `dumpwallet`, `walletpassphrase`,
   `signrawtransactionwithwallet` and the rest of the deny-list stay refused. A response that carries a private
   key is still withheld. (cli: `btc_secret_methods_refused_even_with_allow_unlisted_nothing_sent`, `response_with_private_key_withheld`)
4. **Auth fails closed, locally.** An empty `--auth-file` gives `{"error":"auth_empty","status":"bad_input"}` and
   exit 2 with no connection. The secret is never echoed in output or errors.
   (cli: `empty_auth_file_fails_closed_exit_2`, `auth_file_secret_never_on_stdout_or_stderr`)
5. **Params are ONE JSON-array argument:** `rpc "$U" getblockhash '[2]'`, or
   `rpc "$U" getrawtransaction '["TXID", false, "BLOCKHASH"]'`. `rpc "$U" getblockhash 2` and two separate
   arguments are refused with exit 2. (cli: `passthrough_is_raw_envelope_and_params_are_one_json_array`)
6. **A pipe masks rpc's exit code.** `rpc "$U" dumpprivkey '["x"]' | cat` exits 0 in bash, and `PIPESTATUS` is
   `1 0`. Use `set -o pipefail` (the pipeline then exits 1), or capture rpc's output first and branch on
   `jq -r .status`. (e2e: `rpc-decode.sh` measures both)
7. **Pruned node.** Without `-txindex`, `getrawtransaction TXID` fails with node error -5 (`rpc_error`, exit 1;
   rpc adds a `hint`). Give the block hash: `rpc "$U" rawtx TXID BLOCKHASH`. `prevtxs` doesn't know the
   previous transactions' blocks, so it needs `-txindex`. Without it, decode without `--prevtxs` and the fee
   stays unknown. (e2e: pruned and `-txindex` runs; cli: `btc_rawtx_tidy_object_hash_checked_no_allow_unlisted`)
8. **tx-decode reads stdin only.** `tx-decode HEX` is `bad_transaction`, exit 2. Pipe the hex or the rawtx JSON in.
9. **Prev txs are hash-checked.** Each `--prevtxs` line must hash to an input's outpoint txid. A forged line
   (say, a bigger value) matches no input and is refused (`prevtx_unused`), so it can't fake the fee.
   `rawtx` also checks that the node's hex hashes to the txid you asked for (`node_tx_hash_differs`).
   (tx: `missing_unused_and_bad_prevtx`; cli: `btc_rawtx_tidy_object_hash_checked_no_allow_unlisted`)
10. **Size cap.** rpc caps the response size (see docs/RPC.md, Safety), so a full `getblock HASH 2` on a big
    mainnet block can hit it. `block` uses verbosity 1 (txids only).
11. **Broadcasting: see the fee first.** `rpc URL sendraw` looks the prevouts up the same way (or takes
   `--prevtxs prevtxs.jsonl`) and prints the fee in the confirmation. On a pruned node with no `--prevtxs` it
   prints a FEE UNKNOWN banner and wants `ACK FEE-UNKNOWN` before the code. Test: `scripts/e2e.d/sendraw-fee.sh`.
