# EVM: check an EIP-712 signature and digest

> ⚠️ DANGEROUS: use at your own risk. Code that handles keys and signs transactions should
> always be read and audited by you before you trust it with real funds. Used incorrectly,
> it can destroy your money.

Task: see what a typed-data signature commits to (domain separator, message hash, digest) and who signed it, offline.
Part of the [EVM contract recipes](evm-contract-data.md). Real dApp requests:
[evm-permit2-signing-request.md](evm-permit2-signing-request.md), [evm-check-approval.md](evm-check-approval.md).

[fixtures/evm/eip712-mail-signed.json](fixtures/evm/eip712-mail-signed.json) is the Mail example from the EIP-712
specification with its published signature:

<!-- e2e: expect="status":"valid" ; expect=0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826 ; rc=0 -->
    typed-data-verify recipes/fixtures/evm/eip712-mail-signed.json | jq -c '{primary_type, chain_id, recovered, status}'

A different expected signer is a mismatch (exit 1):

<!-- e2e: expect=signer_mismatch ; rc=1 -->
    typed-data-verify --signer 0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB recipes/fixtures/evm/eip712-mail-signed.json

An `eth_signTypedData_v4` request (`{"params": [address, typedData]}`) can be piped in as-is with `--sig`; its address
becomes the expected signer. Live (UNTESTED here): capture the request a dApp sends and the signature the wallet returns,
then `typed-data-verify --sig 0x… request.json`.
