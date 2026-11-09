# Offline policy file

`tx-verify --policy FILE`, `tx-sign --policy FILE` and wasm `checkTxPolicy(tx, chain, json)` check a
transaction against declarative rules **before** signing. tx-sign checks again on the signed bytes.
It works offline and refuses anything the file does not allow. The rule used is the one named by
`--chain` (or the detected chain). `tx-verify` reports the file's sha256, so you can tell which
policy made each decision.

```json
{"version": 1, "chains": {
  "btc": {"allow_to": ["bc1q..."], "change": ["bc1q..."], "max_value": 5000000, "max_fee": 20000, "max_outputs": 2},
  "bsc": {"chain_id": 56, "allow_to": ["0x..."], "max_value": "1000000000000000000",
          "allow_tokens": ["0x...token"], "allow_calls": [{"to": "0x...", "selector": "0x095ea7b3"}]}
}}
```

| key | meaning | refusal |
|---|---|---|
| (chain has no entry) | deny | `policy:no_rule_for_chain` |
| `chain_id` | EVM: required, must equal the tx chain id | `policy:chain_id` |
| `allow_to` | every recipient: UTXO outputs that are not `change`; EVM `to`, or the ERC-20 recipient | `policy:allow_to` |
| `change` | UTXO outputs that are allowed and not counted in `max_value` | — |
| `max_value` | UTXO: sum of non-change outputs (sats). EVM: native wei, or token base units | `policy:max_value` |
| `max_fee` | sats, or wei (gas × max fee per gas). Defaults to tx-sign's default cap | `policy:max_fee` |
| `max_outputs` | UTXO output count | `policy:max_outputs` |
| `allow_tokens` | ERC-20 contracts allowed for `transfer()` | `policy:allow_tokens` |
| `allow_calls` | any other contract call needs a matching (`to`, 4-byte `selector`) pair. A listed `approve` also accepts its `token_approve` warning | `policy:allow_calls` |

The flag checks still refuse any contract call they cannot read (`unknown_contract_call`), so a file-allowed
call also needs `--call SIGNATURE` (or `--abi FILE`) on tx-verify/tx-sign: the calldata must decode exactly and is
shown as function + arguments. Contract creation is approved with `--create-hash KECCAK` (keccak256 of the init
code), not by the file. See [recipes/evm-contract-tx.md](../recipes/evm-contract-tx.md).

`tx-verify` also checks the approvals and transfers it can decode, whatever the file says (deny by default): an
approval of 2^128 or more, or of all tokens, fails with `unlimited_approval` unless `--expect-spender ADDR
--expect-unlimited` are given; batch inner calls need `--allow-inner-call TO:SELECTOR`; a Safe delegatecall needs
`--allow-delegatecall TO`. `--expect-spender`, `--expect-amount`, `--expect-recipient` and `--expect-value` are optional
exact assertions. `tx-sign` runs the same checks with the same flags before reading a key and again on the signed bytes (also with `--plan`). See
[recipes/evm-check-approval.md](../recipes/evm-check-approval.md).

Numbers can be JSON integers or decimal strings (needed above 2^53). Unknown keys are errors
(`policy_unknown_key`), so a typo cannot silently drop a rule. The base checks always apply and
cannot be turned off by the file: `legacy_input_amount_unproven`, `has_warnings`,
`no_replay_protection`, `eth_value_with_token_call` and `fee_unknown`. Flags given with the file
(`--expect-to`, `--chain-id`, ...) are checked as well. The file can only add refusals.

The design follows the public descriptions of hosted policy engines (allowlists, value caps,
chain pins, deny by default), but it runs locally with no server. See docs/ROADMAP-PARITY.md.
