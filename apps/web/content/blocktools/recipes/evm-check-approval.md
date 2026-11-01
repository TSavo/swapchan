# EVM: check an ERC-20 approve or permit before signing

> ⚠️ DANGEROUS: use at your own risk. Code that handles keys and signs transactions should
> always be read and audited by you before you trust it with real funds. Used incorrectly,
> it can destroy your money.

Task: a dApp asks you to sign an `approve` transaction or an EIP-2612 `permit`. Before signing, read three things:
**who** gets the allowance (spender), **how much** (an unlimited amount lets the spender move every token you hold, now
and later), and **until when** (permit deadline). Part of the [EVM contract recipes](evm-contract-data.md).

NOT BUILT: no tool here flags unlimited approvals for you or knows whether a spender is trustworthy. The
`unlimited` field below is a plain `jq` comparison with the largest uint256; you judge the spender.

## An approve transaction

The calldata here is constructed with `abi-encode` (spender: the Permit2 contract, amount: the largest uint256), the
same bytes a wallet would show in the tx `data` field:

<!-- e2e: expect="signature":"approve(address,uint256)" ; expect="spender":"0x000000000022D473030F116dDEE9F6B43aC78BA3" ; expect="unlimited":true ; rc=0 -->
    abi-encode --raw 'approve(address,uint256)' 0x000000000022d473030f116ddee9f6b43ac78ba3 115792089237316195423570985008687907853269984665640564039457584007913129639935 | abi-decode --sig 'approve(address,uint256)' | jq -c '{signature, spender: .args[0].value, amount: .args[1].value, unlimited: (.args[1].value == "115792089237316195423570985008687907853269984665640564039457584007913129639935")}'

If the data is not an `approve` at all, `abi-decode` says `no_match` (exit 0) instead of guessing; try
`--sig 'increaseAllowance(address,uint256)'` or `--sig 'setApprovalForAll(address,bool)'` (NFTs) as well (UNTESTED here).
To go on and build or verify the transaction itself, see [evm-contract-tx.md](evm-contract-tx.md).

## An EIP-2612 permit (typed data, no transaction)

A permit is a signature, not a transaction, so your wallet shows typed data. [fixtures/evm/eip2612-permit-usdc.json](fixtures/evm/eip2612-permit-usdc.json)
is a constructed, unsigned USDC permit (see [fixtures/evm/PROVENANCE.md](fixtures/evm/PROVENANCE.md)). Check the
domain (which token contract, which chain) and the digest your wallet would sign:

<!-- e2e: expect="primary_type":"Permit" ; expect="chain_id":1 ; expect="digest":"0xe502dff4782ad1219589bfd62ec9844336aac2d3e0a063218bbe1ac5d14e5691" ; rc=0 -->
    typed-data-verify recipes/fixtures/evm/eip2612-permit-usdc.json | jq -c '{primary_type, chain_id, encode_type, domain_separator, digest}'

Then the fields that matter:

<!-- e2e: expect="spender":"0x000000000022d473030f116ddee9f6b43ac78ba3" ; expect="unlimited":true ; rc=0 -->
    jq -c '.message | {spender, value, deadline, unlimited: (.value == "115792089237316195423570985008687907853269984665640564039457584007913129639935")}' recipes/fixtures/evm/eip2612-permit-usdc.json

With the wallet's signature you can also recover the signer: `typed-data-verify --sig 0x… --signer 0x… FILE`
([evm-eip712-verify.md](evm-eip712-verify.md)); a signed, real-world example is in
[evm-permit2-signing-request.md](evm-permit2-signing-request.md). Live (UNTESTED here): compare `domain_separator` with
the token's own `DOMAIN_SEPARATOR()` via `contract-call "$RPC" TOKEN 'DOMAIN_SEPARATOR() returns (bytes32)'`.
