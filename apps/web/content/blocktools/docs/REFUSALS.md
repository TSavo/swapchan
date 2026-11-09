# Refusals and status codes

Every blocktools tool prints JSON lines. The last line carries `status`, and a refusal adds a
`failures` list. This page covers every status and every failure code the tools can emit. For each
one it gives the cause and what you should do. The code examples are run by `scripts/e2e.d/refusals.sh`
(`scripts/e2e-only/doc-run.py`). That check also fails if a code the source can emit has no section here.

**Measured on Linux only.** The examples below run in the e2e gate on Linux. Exit codes on other
platforms have not been measured.

The fixtures are built inside the runner from public test values, so you can run the commands
yourself. `$FX/btc.psbt` is a one-input sweep of a made-up UTXO to `$BTC_TO`. The `$FX/evm-*.hex`
files are unsigned EVM transactions built by hand by `scripts/e2e-only/evm-fixture.py`. `$FX/key2`
is the integer 2 used as a private key. None of these commands touches a real network.

## Exit codes (measured)

| exit | meaning |
|---|---|
| 0 | `ok` / `done` / `checksum_ok` (success) |
| 1 | `failed` (verification found problems), `refused` (a signer or broadcaster would not act), `aborted` (no confirmation) |
| 2 | `bad_input` (the input could not be parsed, or a required flag is missing) |

## Statuses

### `ok`
A result line for one item, for example one derived master key. You don't need to do anything.

### `done`
The final line of a run that streams results, with `count`. A `count` of 0 means the tool found nothing. That is not an error.

<!-- run rc=0 expect=done -->
```sh
echo "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" | seed-repair
```

### `checksum_ok`
`seed-repair`: this candidate mnemonic passes the BIP-39 checksum. A passing checksum does **not**
prove the phrase is yours. Derive addresses from it and match them against an address you know.

### `checksum_fail`
In the vocabulary but not emitted by any current tool, so no example has been run. `seed-repair` reports
only candidates that pass. A phrase with no passing candidate ends with `done` and `count: 0`.

### `no_candidates`
`seed-repair` and the address planner: no candidate fits the input. Check the words or the address
for typos. Allowing more changed words widens the search. Not run here.

### `not_found`
`wallet-finder`: no candidate from your text derives a funded address in the UTXO set you gave it
(exit 1, like `grep`). Try `--rules`, a wider `--window`, or the other `--scheme`. Run in the man page
example and in scripts/e2e.d/utxo-real.sh.

### `too_many_candidates`
The search space is larger than the cap. Narrow it down: fix the words you are sure of, give the
known address, or reduce the number of edits allowed. Not run here.

### `bad_input`
The input could not be parsed, or a required flag is missing. The `error` field says which one. Fix the input. Nothing was done.

<!-- run rc=2 expect=bad_input,bad_hex -->
```sh
echo zz | tx-verify
```

### `wrong_password`
A wallet reader (`dat-read`, `keystore-open`, `electrum-read`, `multibit-read`, `armory-read`,
`blockchain-read`, bitcoinj) decrypted with the given password and the integrity check failed. Try
other candidates, for example with `pw-candidates`. Not run here, because the encrypted fixtures live in the crate tests.

### `unsupported`
The file format, version, or script type is recognised but not handled. Nothing was extracted.
Report the `error` field. Do not try to force it. Not run here.

### `error`
An internal or I/O error, for example a network error in `utxo-fetch` or `tx-broadcast`. Nothing was
signed or sent. Retry, or report it with the line shown.

### `failed`
`tx-verify` found problems. See `failures` and the codes below.

### `refused`
`tx-sign` or `tx-broadcast` would not act. See `failures` or `error`. Nothing was signed or sent.

<!-- run rc=1 expect=refused,not_signed -->
```sh
tx-broadcast --chain btc --url http://127.0.0.1:9 < "$FX/btc.psbt"
```

### `aborted`
The signer needs a typed confirmation on a TTY (`/dev/tty`) and did not get one. With no controlling terminal (the runner uses a new session) it always aborts.
That is deliberate: scripts cannot sign without a human. Run it in a terminal and type the confirmation.

<!-- run rc=1 expect=aborted -->
```sh
tx-sign --tx "$FX/evm-transfer.hex" --chain-id 1 --expect-to "$EVM_TO" --allow-warnings < "$FX/key2"
```

## Failure codes (`tx-verify`, `tx-sign`)

### `has_warnings`
The transaction has warnings (any warning except `unsigned`). Read each one in `warnings`.
Pass `--allow-warnings` only once you understand every warning.

<!-- run rc=1 expect=has_warnings,high_fee_pct -->
```sh
tx-verify --chain-id 1 --expect-to "$EVM_TO" < "$FX/evm-transfer.hex"
```

### `fee_over_10pct_of_inputs`
The fee is more than 10% of what the inputs hold (UTXO chains), even though it is under the cap. This is
usually a wrong change output or a unit slip. Rebuild the transaction. Pass an explicit `--max-fee` only if you
meant to pay that share.

### `fee_above_cap`
The fee is above the cap. `fee_cap.source` says where the cap came from (`explicit`, `default_evm`,
`chain_rate_x_vsize`). Rebuild the transaction with a lower fee. Raise `--max-fee` only if you meant to pay that much.

<!-- run rc=1 expect=fee_above_cap -->
```sh
tx-verify --max-fee 100 --expect-to "$BTC_TO" < "$FX/btc.psbt"
```

### `fee_unknown`
The fee cannot be computed, because a raw Bitcoin transaction does not carry its input amounts.
Verify the PSBT, which carries them, rather than the raw transaction.

<!-- run rc=1 expect=fee_unknown,input_amounts_unknown -->
```sh
tx-verify --chain btc --expect-to "$BTC_TO" < "$FX/btc-raw.hex"
```

### `chain_id_mismatch`
The transaction's EVM chain id differs from `--chain-id`. Signing would make it valid on a different
chain. Rebuild it for the chain you meant.

<!-- run rc=1 expect=chain_id_mismatch -->
```sh
tx-verify --chain-id 8453 --allow-warnings --expect-to "$EVM_TO" < "$FX/evm-transfer.hex"
```

### `chain_id_not_pinned`
An EVM transaction was verified without `--chain-id`. Pass the chain id you intend to use.

<!-- run rc=1 expect=chain_id_not_pinned -->
```sh
tx-verify --allow-warnings --expect-to "$EVM_TO" < "$FX/evm-transfer.hex"
```

### `no_chain_id`
You pinned a chain id, but the transaction has none (a pre-EIP-155 legacy transaction). Rebuild it with a chain id.

### `no_replay_protection`
The EVM transaction has no chain id, so anyone could replay it on every EVM chain. Rebuild it with a chain id.
The signer refuses as well (`refuse_no_chain_id`).

<!-- run rc=1 expect=no_chain_id,no_replay_protection,refused -->
```sh
tx-sign --tx "$FX/evm-legacy-no-chain-id.hex" --chain-id 1 --expect-to "$EVM_TO" < "$FX/key2"
```

### `token_call_not_transfer`
The calldata calls a known token function that is not `transfer` (here, an unlimited `approve`).
Approvals let someone else spend your tokens. Do not sign unless you set it up yourself.

<!-- run rc=1 expect=token_call_not_transfer,unlimited_approve,unlimited_approval -->
```sh
tx-verify --chain-id 1 --expect-to "$EVM_TO" < "$FX/evm-approve.hex"
```

### `unlimited_approval`
The calldata approves 2^128 or more tokens, or all of them (`setApprovalForAll(true)`, DAI `permit` with
`allowed=true`). Do not sign unless you meant it; to accept it, assert both `--expect-spender ADDR --expect-unlimited`.

<!-- run rc=1 expect=unlimited_approval,token_call_not_transfer -->
```sh
tx-verify --chain-id 1 --expect-to "$EVM_TO" < "$FX/evm-approve.hex"
```

`tx-sign` runs the same check before it reads a key (nothing is signed):

<!-- run rc=1 expect=unlimited_approval,refused -->
```sh
tx-sign --tx "$FX/evm-approve.hex" --chain-id 1 --expect-to "$EVM_TO" < "$FX/key2"
```

### `spender_not_expected`
A decoded approval names a different spender than `--expect-spender`.
`typed-data-verify --expect-spender` (and the wasm `evmTypedDataVerify` option `expect_spender`) gives the same status
for a signed permit (EIP-2612, DAI, Permit2): a permit for exactly your balance is below 2^128, so only the spender
catches a drainer. Typed data that is not a recognised permit gives `spender_not_checkable` / `amount_not_checkable`.

<!-- run rc=1 expect=spender_not_expected -->
```sh
tx-verify --chain-id 1 --expect-to "$EVM_TO" --expect-spender 0x1111111111111111111111111111111111111111 --expect-unlimited < "$FX/evm-approve.hex"
```

### `amount_not_expected`
A decoded approval or transfer amount differs from `--expect-amount` (or is not unlimited under `--expect-unlimited`).

<!-- run rc=1 expect=amount_not_expected -->
```sh
tx-verify --chain-id 1 --expect-to "$EVM_TO" --expect-spender "$EVM_TO" --expect-amount 1 < "$FX/evm-approve.hex"
```

### `recipient_not_expected`
A decoded `transfer`/`transferFrom` sends to a different address than `--expect-recipient`.

<!-- run rc=1 expect=recipient_not_expected -->
```sh
tx-build --chain eth --chain-id 1 --nonce 0 --max-fee-per-gas 1000000000 --gas 200000 --to 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --data $(abi-encode --raw 'transfer(address,uint256)' 0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF 5) | tx-verify --chain-id 1 --expect-recipient 0x1111111111111111111111111111111111111111
```

### `value_not_expected`
The native value (wei) differs from `--expect-value`.

<!-- run rc=1 expect=value_not_expected -->
```sh
tx-verify --chain-id 1 --expect-to "$EVM_TO" --expect-value 1 < "$FX/evm-transfer.hex"
```

### `spender_not_checkable`
`--expect-spender` was given but the transaction has no approval to compare it with.

<!-- run rc=1 expect=spender_not_checkable -->
```sh
tx-verify --chain-id 1 --expect-to "$EVM_TO" --expect-spender 0x1111111111111111111111111111111111111111 < "$FX/evm-transfer.hex"
```

### `amount_not_checkable`
`--expect-amount` was given but the transaction has no approval or token transfer to compare it with.

<!-- run rc=1 expect=amount_not_checkable -->
```sh
tx-verify --chain-id 1 --expect-to "$EVM_TO" --expect-amount 1 < "$FX/evm-transfer.hex"
```

### `recipient_not_checkable`
`--expect-recipient` was given but the transaction has no token transfer to compare it with.

<!-- run rc=1 expect=recipient_not_checkable -->
```sh
tx-verify --chain-id 1 --expect-to "$EVM_TO" --expect-recipient 0x1111111111111111111111111111111111111111 < "$FX/evm-transfer.hex"
```

### `inner_calls_not_asserted`
A batch (multicall, Multicall3, Universal Router, Safe, multiSend) has an inner call you did not name with
`--allow-inner-call TO:SELECTOR`. Read `inner_calls` in the output before you name anything.

<!-- run rc=1 expect=inner_calls_not_asserted -->
```sh
tx-build --chain eth --chain-id 1 --nonce 0 --max-fee-per-gas 1000000000 --gas 200000 --to 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --data $(abi-encode --raw 'multicall(bytes[])' '["0xa9059cbb00"]') | tx-verify --chain-id 1 --call 'multicall(bytes[])'
```

`tx-sign` refuses the same batch before it reads a key:

<!-- run rc=1 expect=inner_calls_not_asserted,refused -->
```sh
tx-build --chain eth --chain-id 1 --nonce 0 --max-fee-per-gas 1000000000 --gas 200000 --to 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --data $(abi-encode --raw 'multicall(bytes[])' '["0xa9059cbb00"]') > mc.json; tx-sign --tx mc.json --chain-id 1 --expect-to 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --call 'multicall(bytes[])' < "$FX/key2"
```

### `delegatecall`
A Safe call with `operation = 1` runs another contract's code with the Safe's storage and funds. Refused unless
`--allow-delegatecall TO` names that target.

<!-- run rc=1 expect=delegatecall -->
```sh
tx-build --chain eth --chain-id 1 --nonce 0 --max-fee-per-gas 1000000000 --gas 200000 --to 0x5555555555555555555555555555555555555555 --data $(abi-encode --raw 'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)' 0x40A2aCCbd92BCA938b02010E17A5b8929b49130D 0 0x8d80ff0a 1 0 0 0 0x0000000000000000000000000000000000000000 0x0000000000000000000000000000000000000000 0x) | tx-verify --chain-id 1
```

### `bad_inner_calldata`
A batch's inner calls do not decode strictly (here a truncated Safe `multiSend` payload). Do not sign it.

<!-- run rc=1 expect=bad_inner_calldata -->
```sh
tx-build --chain eth --chain-id 1 --nonce 0 --max-fee-per-gas 1000000000 --gas 200000 --to 0x40A2aCCbd92BCA938b02010E17A5b8929b49130D --data $(abi-encode --raw 'multiSend(bytes)' 0x00aaaa) | tx-verify --chain-id 1
```

### `unknown_contract_call`
The calldata is not a recognised call. blocktools cannot tell what it does. Do not sign it.

<!-- run rc=1 expect=unknown_contract_call,unknown_calldata -->
```sh
tx-verify --chain-id 1 --expect-to "$EVM_TO" < "$FX/evm-unknown-call.hex"
```

Calldata with bytes appended after the call (an ERC-2771 sender, a referral tag, an extra word) is refused the
same way, even with a matching `--call`: the strict decoder rejects trailing bytes (`call.status` is `bad_calldata`),
so the transfer is not recognised and its recipient is not checked. tx-verify has no flag to accept a suffix. To
proceed, inspect the bytes yourself with `abi-decode --allow-trailing` (see [ABI-STRICT.md](ABI-STRICT.md)), then
sign only calldata without the suffix, or decide outside blocktools.

<!-- run rc=1 expect=bad_calldata,unknown_contract_call,destination_not_expected -->
```sh
tx-build --chain eth --chain-id 1 --nonce 0 --max-fee-per-gas 1000000000 --gas 200000 --to 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --data $(abi-encode --raw 'transfer(address,uint256)' "$EVM_TO" 1000)2222222222222222222222222222222222222222 | tx-verify --chain-id 1 --expect-to "$EVM_TO" --call 'transfer(address,uint256)'
```

### `eth_value_with_token_call`
A token `transfer` also sends ETH to the token contract. That ETH is almost certainly lost. Rebuild the transaction with value 0.

<!-- run rc=1 expect=eth_value_with_token_call -->
```sh
tx-verify --chain-id 1 --expect-to "$EVM_TO" < "$FX/evm-value-and-token.hex"
```

### `destination_not_expected`
The EVM recipient (or the token recipient) is not one of the `--expect-to` addresses. Check the address character by character.
Shown above together with `token_call_not_transfer`.

### `unexpected_output`
A Bitcoin-family output goes to an address that is neither `--expect-to` nor `--change`. Do not sign.
The address may have been swapped.

### `expected_destination_missing`
None of the outputs pays an `--expect-to` address. Rebuild the transaction or correct the flag.

<!-- run rc=1 expect=unexpected_output,expected_destination_missing,refused -->
```sh
tx-sign --tx "$FX/btc.psbt" --expect-to bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4 < "$FX/key2"
```

### `input_without_key`
`tx-sign` was given a key that signs none of the inputs (the wrong key, or the wrong derivation path).
Supply the key for the address the coins are on.

<!-- run rc=1 expect=input_without_key,refused -->
```sh
tx-sign --tx "$FX/btc.psbt" --expect-to "$BTC_TO" < "$FX/key2"
```

### `legacy_input_amount_unproven`
A non-segwit input's amount is not proven by its previous transaction, so the fee could be a lie.
Supply `prev_tx`. Not run here: `tx-build` already refuses such inputs earlier
(`legacy_input_needs_prev_tx`, rc=2). Only an externally built PSBT reaches this check.

## EVM contract tools (`sig-hash`, `abi-decode`, `abi-encode`, `create-address`)

These offline filters print `{"status":"bad_input","error":CODE}` and exit 2 on malformed input; they never
guess. A selector, topic or error with no signature you supplied is not an error: `{"status":"no_match"}`,
exit 0. Codes come from `crates/evm`; the strict decoder refuses any encoding Solidity would not produce.

| Group | Codes | Human action |
|---|---|---|
| Hex | `bad_hex`, `odd_length_hex` | Pass `0x` hex with an even number of digits |
| Signatures | `empty_signature`, `signature_needs_parens`, `unbalanced_parens`, `bad_signature_name`, `bad_signature_suffix`, `bad_type`, `bad_param`, `empty_param`, `bad_array_suffix`, `bad_array_length`, `tuple_needs_components`, `returns_needs_parens`, `signature_too_long`, `too_deep` | Fix the Solidity signature (for example `uint7` or `bytes33` do not exist) |
| ABI JSON | `bad_abi_json`, `abi_json_needs_array`, `bad_abi_item_type`, `bad_abi_item_name`, `bad_abi_params`, `abi_param_needs_type`, `abi_too_deep` | Pass a compiler ABI array, `{abi:[…]}`, or one signature per line |
| Strict decode | `data_too_short`, `data_shorter_than_selector`, `offset_out_of_bounds`, `offset_overflow`, `offset_or_length_out_of_bounds`, `offset_or_length_too_large`, `bytes_out_of_bounds`, `array_length_out_of_bounds`, `bytes_padding_missing`, `dirty_address`, `dirty_bool`, `dirty_uint`, `dirty_int`, `dirty_bytes_padding`, `string_not_utf8` | The data does not match the signature, or is truncated or non-canonical: check the signature and that the whole field was copied |
| Logs | `bad_topic`, `topic_not_32_bytes`, `more_than_4_topics`, `topic_count_mismatch`, `no_matching_event`, `types_need_data_not_a_log` | Give the event declaration with the right `indexed` markers |
| Input JSON | `bad_input_json`, `input_json_has_no_input_data_or_topics`, `rpc_error_without_data`, `missing_input`, `missing_sig`, `output_needs_sig`, `output_needs_data`, `empty_input` | Pipe the JSON-RPC response or the hex field itself |
| Encode values | `bad_uint`, `uint_overflow`, `int_out_of_range`, `value_too_large_for_uint`, `number_not_integer_use_a_string`, `bad_bool`, `address_needs_0x`, `address_not_20_bytes`, `bad_eip55_checksum`, `expected_json_array`, `expected_scalar`, `too_many_values`, `missing_args` | Pass integers as decimal or `0x` strings, addresses with a correct EIP-55 checksum (or all one case) |
| Addresses | `missing_deployer`, `create_needs_nonce_or_salt`, `bad_nonce`, `nonce_out_of_range_eip2681`, `bad_salt`, `salt_not_32_bytes`, `init_code_hash_not_32_bytes`, `create2_needs_exactly_one_of_init_code_hash_init_code` | Give `--nonce` (CREATE), or `--salt` with exactly one of `--init-code-hash`/`--init-code` (CREATE2) |
| Lookup | `lookup_needs_4_or_32_bytes`, `no_signature`, `cannot_read_file`, `cannot_read_abi_file` | Pass a selector or an event topic, and an existing signature file |

<!-- run rc=2 expect=data_too_short -->
```sh
echo 0xa9059cbb00 | abi-decode --sig 'transfer(address,uint256)'
```

<!-- run rc=2 expect=value_too_large_for_uint8 -->
```sh
abi-encode 'f(uint8)' 256
```

<!-- run rc=2 expect=create_needs_nonce_or_salt -->
```sh
create-address --deployer 0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0
```

<!-- run rc=2 expect=bad_abi_json -->
```sh
echo '[' | abi-inspect
```

<!-- run rc=2 expect=odd_length_hex -->
```sh
bytecode-inspect 0x1
```

<!-- run rc=2 expect=signer_needs_sig -->
```sh
echo '{}' | typed-data-verify --signer 0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB
```

<!-- run rc=2 expect=not_sol_or_tron -->
```sh
sol-tron-tx decode ff00ff
```

<!-- run rc=1 expect=verify_failed,unexpected_recipient -->
```sh
sol-tron-tx verify --expect '{"to":"TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7"}' < "$FX/tron-transfer.hex"
```

<!-- run rc=1 expect=blind_hash_message -->
```sh
printf '%064x\n' 1 | msg-sign --address 1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH --message 0xc0a96273d5c3fbe4d4000491f08daef9c17f88df846c1d6f57eb5f33c1fbd035
```

<!-- run rc=1 expect=address_not_p2pkh -->
```sh
printf '%064x\n' 1 | msg-sign --address bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4 --message hi
```

<!-- run rc=1 expect=address_does_not_match_key -->
```sh
printf '%064x\n' 1 | msg-sign --address 19cAJn4Ms8jodBBGtroBNNpCZiHAWGAq7X --message hi
```

<!-- run rc=1 expect=solana_format_required -->
```sh
printf '%064x\n' 1 | msg-sign --address H3imdwa5VQMB5V6yBNyrWwPdSKs4k9Pcpsu4diogoAcg --message hi
```

<!-- run rc=1 expect=blind_hash_message -->
```sh
printf '%064x\n' 1 | msg-sign --address TWWb9EjUWai17YEVB7FR8hreupYJKG9sMR --message c0a96273d5c3fbe4d4000491f08daef9c17f88df846c1d6f57eb5f33c1fbd035
```

<!-- run rc=2 expect=address_not_p2pkh -->
```sh
msg-verify --address bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4 --message hi --sig AA==
```

<!-- run rc=1 expect=cosmos_hrp_without_vector -->
```sh
printf '%064x' 1 | acct-tx keys --chain atom --hrp canto
```

<!-- run rc=1 expect=cosmos_hrp_without_vector -->
```sh
acct-tx build --chain atom --from canto1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqgfwgkv --pubkey 0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798 --to canto1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqgfwgkv --amount 1 --fee 1 --gas 1 --sequence 0 --account-number 1
```

<!-- run rc=1 expect=bad_header -->
```sh
printf 'hello' | siwe parse
```

<!-- run rc=2 expect=missing chainId -->
```sh
printf '{"domain":"a"}' | siwe build
```
