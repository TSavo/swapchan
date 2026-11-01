# EVM: what a Permit2 signing request commits to, verified offline

> ⚠️ DANGEROUS: use at your own risk. Code that handles keys and signs transactions should
> always be read and audited by you before you trust it with real funds. Used incorrectly,
> it can destroy your money.

Task: a dApp (here Uniswap) asks your wallet to sign Permit2 typed data. See exactly what the signature authorises
and check who signed it, with no network. Part of the [EVM contract recipes](evm-contract-data.md).

[fixtures/evm/permit2-single-02a.json](fixtures/evm/permit2-single-02a.json) is a real request: the `PermitSingle` and
signature carried inside the mainnet Universal Router tx `02a` (decoded in
[evm-decode-multicall.md](evm-decode-multicall.md)); provenance in [fixtures/evm/PROVENANCE.md](fixtures/evm/PROVENANCE.md).

## What it commits to

- domain: `Permit2` on chain 1, contract `0x000000000022D473030F116dDEE9F6B43aC78BA3`. A different chain id or contract is a different digest.
- `details.token`, `details.amount`: which token and how much the spender may pull (`uint160`; the largest
  `uint160` means unlimited).
- `details.expiration`: when that allowance ends (unix seconds); `details.nonce`: replay protection.
- `spender`: who may pull (here the Universal Router); `sigDeadline`: until when this signature can be used.

<!-- e2e: expect="token":"0xc8fb80fcc03f699c70ff0cc08c09106288888888" ; expect="amount":"713135902875675667654" ; expect="spender":"0x66a9893cc07d91d95644aedd05d03f95e1dba8af" ; rc=0 -->
    jq -c '.typed_data | {chain: .domain.chainId, contract: .domain.verifyingContract, token: .message.details.token, amount: .message.details.amount, expiration: .message.details.expiration, spender: .message.spender, sigDeadline: .message.sigDeadline}' recipes/fixtures/evm/permit2-single-02a.json

## Who signed it

`typed-data-verify` recomputes the domain separator, message hash and digest, recovers the signer and compares it with
`signer` (the tx sender):

<!-- e2e: expect="primary_type":"PermitSingle" ; expect="digest":"0x12e92b4796975f2f79b35759c3a397ad332da12ce7087c03f590fc37611e66f1" ; expect="recovered":"0x7E9578235485f0e8CD0761eC6E570a2aB144F406" ; expect="status":"valid" ; rc=0 -->
    typed-data-verify recipes/fixtures/evm/permit2-single-02a.json | jq -c '{primary_type, chain_id, digest, recovered, status}'

Change one field (say the spender) and the same signature recovers someone else:

<!-- e2e: expect="status":"signer_mismatch" ; rc=1 -->
    jq '.typed_data.message.spender = "0x000000000000000000000000000000000000dead"' recipes/fixtures/evm/permit2-single-02a.json | typed-data-verify

Before signing, the wallet shows you the request, not a signature: run `typed-data-verify request.json` on the
`eth_signTypedData_v4` params (without `--sig`) and compare `digest` with what the wallet displays (UNTESTED here:
no wallet in CI). Permit2 `PermitBatch` and `PermitTransferFrom` have other types; they are not shown here.
