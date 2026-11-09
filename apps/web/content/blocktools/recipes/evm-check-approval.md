# EVM: check an ERC-20 approve or permit before signing

> ⚠️ DANGEROUS: use at your own risk. Code that handles keys and signs transactions should
> always be read and audited by you before you trust it with real funds. Used incorrectly,
> it can destroy your money.

Task: a dApp asks you to sign an `approve` transaction or an EIP-2612 `permit`. Before signing, read three things:
**who** gets the allowance (spender), **how much** (an unlimited amount lets the spender move every token you hold, now
and later), and **until when** (permit deadline). Part of the [EVM contract recipes](evm-contract-data.md).

`tx-verify` flags unlimited approvals and checks the spender and amount you expect (next section). NOT BUILT: no tool
here knows whether a spender is trustworthy; you still judge who the spender is.

## An approve transaction

The calldata here is constructed with `abi-encode` (spender: the Permit2 contract, amount: the largest uint256), the
same bytes a wallet would show in the tx `data` field:

<!-- e2e: expect="signature":"approve(address,uint256)" ; expect="spender":"0x000000000022D473030F116dDEE9F6B43aC78BA3" ; expect="unlimited":true ; rc=0 -->
    abi-encode --raw 'approve(address,uint256)' 0x000000000022d473030f116ddee9f6b43ac78ba3 115792089237316195423570985008687907853269984665640564039457584007913129639935 | abi-decode --sig 'approve(address,uint256)' | jq -c '{signature, spender: .args[0].value, amount: .args[1].value, unlimited: (.args[1].value == "115792089237316195423570985008687907853269984665640564039457584007913129639935")}'

If the data is not an `approve` at all, `abi-decode` says `no_match` (exit 0) instead of guessing; try
`--sig 'increaseAllowance(address,uint256)'` or `--sig 'setApprovalForAll(address,bool)'` (NFTs) as well (UNTESTED here).
To go on and build or verify the transaction itself, see [evm-contract-tx.md](evm-contract-tx.md).

## Let tx-verify check spender and amount

`tx-verify` decodes the approval itself (`approve`, `increaseAllowance`, EIP-2612 and DAI `permit` calldata, Permit2
`approve` and `permit`, `setApprovalForAll`) and reports it under `approvals` as `{path, signature, token, spender,
amount, unlimited}`. An amount at or above 2^128, or an approval of all tokens (`setApprovalForAll(true)`, DAI
`allowed=true`), fails with `unlimited_approval` unless you pass `--expect-unlimited`, which needs `--expect-spender`.
The checks are deny by default: nothing passes without your exact assertions. The transactions below are built
unsigned with `tx-build`, so nothing is signed here.

An unlimited approve to Permit2, with no assertions, fails (exit 1):

<!-- e2e: expect="unlimited_approval" ; expect="unlimited":true ; expect="status":"failed" ; rc=1 -->
    tx-build --chain eth --chain-id 1 --nonce 0 --max-fee-per-gas 1000000000 --gas 200000 --to 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --data $(abi-encode --raw 'approve(address,uint256)' 0x000000000022d473030f116ddee9f6b43ac78ba3 115792089237316195423570985008687907853269984665640564039457584007913129639935) | tx-verify --chain-id 1 --expect-to 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48

You expected a different spender, so the check fails even though you accepted an unlimited amount:

<!-- e2e: expect="spender_not_expected" ; expect="status":"failed" ; rc=1 -->
    tx-build --chain eth --chain-id 1 --nonce 0 --max-fee-per-gas 1000000000 --gas 200000 --to 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --data $(abi-encode --raw 'approve(address,uint256)' 0x000000000022d473030f116ddee9f6b43ac78ba3 115792089237316195423570985008687907853269984665640564039457584007913129639935) | tx-verify --chain-id 1 --expect-to 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --expect-spender 0x1111111111111111111111111111111111111111 --expect-unlimited

When the token (`--expect-to`), spender and amount all match your assertions, the approve passes (exit 0). The generic
`token_call_not_transfer` refusal is lifted only in this case:

<!-- e2e: expect="status":"ok" ; expect="amount":"1000000" ; expect="unlimited":false ; rc=0 -->
    tx-build --chain eth --chain-id 1 --nonce 0 --max-fee-per-gas 1000000000 --gas 200000 --to 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --data $(abi-encode --raw 'approve(address,uint256)' 0x000000000022d473030f116ddee9f6b43ac78ba3 1000000) | tx-verify --chain-id 1 --expect-to 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --expect-spender 0x000000000022d473030f116ddee9f6b43ac78ba3 --expect-amount 1000000

`setApprovalForAll(operator, true)` on an NFT contract hands over every token in the collection, so it is flagged as unlimited:

<!-- e2e: expect="unlimited_approval" ; expect="amount":"all" ; expect="signature":"setApprovalForAll(address,bool)" ; rc=1 -->
    tx-build --chain eth --chain-id 1 --nonce 0 --max-fee-per-gas 1000000000 --gas 200000 --to 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D --data $(abi-encode --raw 'setApprovalForAll(address,bool)' 0x000000000022d473030f116ddee9f6b43ac78ba3 true) | tx-verify --chain-id 1

## Batches and delegatecall

A batch can hide the call that matters. `tx-verify` reports every inner call of `multicall(bytes[])`, Multicall3
`aggregate*`, Universal Router `execute`, Safe `execTransaction` and Safe `multiSend` under `inner_calls`. Approvals and
transfers inside a batch are checked like top-level ones. Each inner call must be named by `--allow-inner-call TO:SELECTOR`
(for Universal Router, SELECTOR is the 1-byte command), else `inner_calls_not_asserted`:

<!-- e2e: expect="inner_calls_not_asserted" ; expect="unlimited_approval" ; expect="path":"multicall[0]" ; rc=1 -->
    tx-build --chain eth --chain-id 1 --nonce 0 --max-fee-per-gas 1000000000 --gas 200000 --to 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --data $(abi-encode --raw 'multicall(bytes[])' "[\"$(abi-encode --raw 'approve(address,uint256)' 0x000000000022d473030f116ddee9f6b43ac78ba3 115792089237316195423570985008687907853269984665640564039457584007913129639935)\"]") | tx-verify --chain-id 1 --call 'multicall(bytes[])'

With every inner call named and the inner transfer's recipient and amount asserted, the batch passes:

<!-- e2e: expect="status":"ok" ; expect="recipient":"0x264bd8291fAE1D75DB2c5F573b07faA6715997B5" ; rc=0 -->
    tx-build --chain eth --chain-id 1 --nonce 0 --max-fee-per-gas 1000000000 --gas 200000 --to 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --data $(abi-encode --raw 'multicall(bytes[])' "[\"$(abi-encode --raw 'transfer(address,uint256)' 0x264bd8291fae1d75db2c5f573b07faa6715997b5 5050510000)\"]") | tx-verify --chain-id 1 --call 'multicall(bytes[])' --allow-inner-call 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48:0xa9059cbb --expect-recipient 0x264bd8291fae1d75db2c5f573b07faa6715997b5 --expect-amount 5050510000

A Safe `execTransaction` with `operation = 1` runs the target's code with the Safe's own storage and funds
(delegatecall). It fails with `delegatecall` unless `--allow-delegatecall TO` names that exact target:

<!-- e2e: expect="delegatecall" ; expect="operation":"delegatecall" ; expect="selector":"0x8d80ff0a" ; rc=1 -->
    tx-build --chain eth --chain-id 1 --nonce 0 --max-fee-per-gas 1000000000 --gas 200000 --to 0x5555555555555555555555555555555555555555 --data $(abi-encode --raw 'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)' 0x40A2aCCbd92BCA938b02010E17A5b8929b49130D 0 $(abi-encode --raw 'multiSend(bytes)' 0x) 1 0 0 0 0x0000000000000000000000000000000000000000 0x0000000000000000000000000000000000000000 0x) | tx-verify --chain-id 1

NOT BUILT: naming Universal Router commands; checking what a delegatecall target's code does. UNTESTED: these checks
on transactions captured from a live wallet (CI runs only the constructed examples above).

## An EIP-2612 permit (typed data, no transaction)

A permit is a signature, not a transaction, so your wallet shows typed data. [fixtures/evm/eip2612-permit-usdc.json](fixtures/evm/eip2612-permit-usdc.json)
is a constructed, unsigned USDC permit (see [fixtures/evm/PROVENANCE.md](fixtures/evm/PROVENANCE.md)). Check the
domain (which token contract, which chain) and the digest your wallet would sign:

<!-- e2e: expect="primary_type":"Permit" ; expect="chain_id":1 ; expect="digest":"0xe502dff4782ad1219589bfd62ec9844336aac2d3e0a063218bbe1ac5d14e5691" ; rc=0 -->
    typed-data-verify recipes/fixtures/evm/eip2612-permit-usdc.json | jq -c '{primary_type, chain_id, encode_type, domain_separator, digest}'

Assert the domain instead of reading it: `--expect-chain-id` and `--expect-verifying-contract` fail with status
`chain_id_mismatch` / `verifying_contract_mismatch` (exit 1) when the permit is for another chain or token:

<!-- e2e: expect="status":"ok" ; expect="verifying_contract":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" ; rc=0 -->
    typed-data-verify --expect-chain-id 1 --expect-verifying-contract 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 recipes/fixtures/evm/eip2612-permit-usdc.json | jq -c '{status, chain_id, verifying_contract}'

<!-- e2e: expect="status":"chain_id_mismatch" ; expect="expected_chain_id":137 ; rc=1 -->
    typed-data-verify --expect-chain-id 137 recipes/fixtures/evm/eip2612-permit-usdc.json

The amount alone does not catch a drainer: a permit for exactly your balance is below 2^128 and looks "limited".
What matters is the spender. `--expect-spender` (and optionally `--expect-amount N`, or `--expect-unlimited` to
accept an unlimited amount) fails closed with `spender_not_expected` / `amount_not_expected` / `unlimited_approval`
(exit 1) for EIP-2612, DAI and Permit2 (PermitSingle, PermitBatch, PermitTransferFrom, PermitBatchTransferFrom; every
batch entry must match). [fixtures/evm/permit-drainer-exact-balance.json](fixtures/evm/permit-drainer-exact-balance.json)
is the same USDC permit with a small amount and another spender:

<!-- e2e: expect="status":"spender_not_expected" ; expect="spender":"0x1111111111111111111111111111111111111111" ; expect="unlimited_approval":false ; rc=1 -->
    typed-data-verify --expect-spender 0x000000000022d473030f116ddee9f6b43ac78ba3 recipes/fixtures/evm/permit-drainer-exact-balance.json

<!-- e2e: expect="status":"ok" ; expect="kind":"eip2612" ; expect="spender_unasserted":false ; rc=0 -->
    typed-data-verify --expect-spender 0x000000000022d473030f116ddee9f6b43ac78ba3 --expect-unlimited recipes/fixtures/evm/eip2612-permit-usdc.json

Without `--expect-*` the status is unchanged; the output still has `permit`, `spender_unasserted:true` and
`unlimited_approval` as advice. Typed data that is not a recognised permit fails `spender_not_checkable` /
`amount_not_checkable` when asserted, and lists address fields named like a spender in `unrecognised_spender_fields`.

Then the fields that matter:

<!-- e2e: expect="spender":"0x000000000022d473030f116ddee9f6b43ac78ba3" ; expect="unlimited":true ; rc=0 -->
    jq -c '.message | {spender, value, deadline, unlimited: (.value == "115792089237316195423570985008687907853269984665640564039457584007913129639935")}' recipes/fixtures/evm/eip2612-permit-usdc.json

With the wallet's signature you can also recover the signer: `typed-data-verify --sig 0x… --signer 0x… FILE`
([evm-eip712-verify.md](evm-eip712-verify.md)); a signed, real-world example is in
[evm-permit2-signing-request.md](evm-permit2-signing-request.md). Live (UNTESTED here): compare `domain_separator` with
the token's own `DOMAIN_SEPARATOR()` via `contract-call "$RPC" TOKEN 'DOMAIN_SEPARATOR() returns (bytes32)'`.
