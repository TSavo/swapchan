# Cross-chain swap: send an EVM token into THORChain (router `depositWithExpiry`)

Swap a token on an EVM chain (BNB, Ethereum, Avalanche, ...) to an asset on another chain — Bitcoin,
Dogecoin, Litecoin, RUNE — by depositing it into THORChain's router with a swap memo. Two txs from
your EVM wallet: an ERC-20 `approve` to the router, then `router.depositWithExpiry(vault, asset,
amount, memo, expiry)`. BlockTools builds, verifies and signs both; a THORChain node (or any quote
service) gives you the vault, memo and expiry. No new tool: this is `tx-build --data` plus the
`--policy allow_calls` path from [evm-contract-tx.md](evm-contract-tx.md).

## 1. Quote → vault, memo, expiry

Ask a THORChain node for the inbound of a swap from your token to the destination asset:

    rpc NODE '/thorchain/quote/swap?from_asset=BSC.BTCB-0X7130D2A12B9BCBFAE4F2634D864A1EE1CE3EAD9C&to_asset=DOGE.DOGE&amount=AMOUNT_1E8&destination=DOGE_ADDR'

It returns `router`, `inbound_address` (the vault), `memo` and `expiry`. The deposit calldata is `depositWithExpiry(vault, token, amount, memo, expiry)`; decode it offline
with `abi-decode` and confirm every field — the vault, the exact amount, and the memo's destination:

<!-- e2e: expect="signature":"depositWithExpiry(address,address,uint256,string,uint256)" ; expect=DTWd9kMm3EULnVRmkVFehaDTzPQJ3nqQ5r ; expect="status":"ok" ; rc=0 -->
    abi-decode --sig 'depositWithExpiry(address,address,uint256,string,uint256)' 0x44bc937b000000000000000000000000718f6c9df785bc4e323086de024ca822efbe8ab90000000000000000000000007130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c0000000000000000000000000000000000000000000000000001c6d982b7d80000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000006ae1250c00000000000000000000000000000000000000000000000000000000000000613d3a643a44545764396b4d6d3345554c6e56526d6b564665686144547a50514a336e715135722f3078656230654337613238453442364231373538303645323144394433616645343537393243356337423a35303038303138363139392f312f3000000000000000000000000000000000000000000000000000000000000000

## 2. Approve the router (exact amount, authorized by policy)

The approve is a token call, which BlockTools refuses by default. A `--policy` with an `allow_calls`
entry for exactly `(token, 0x095ea7b3)` authorizes this one approve and nothing else:

    tx-build --chain eth --chain-id 56 --nonce 0 --max-fee-per-gas 1000000000 --priority-fee 1000000000 --gas 60000 --to 0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c --data $(abi-encode 'approve(address,uint256)' 0xb30ec53f98ff5947ede720d32ac2da7e52a5f56b 500112480000000 | jq -r .data) | tx-verify --chain-id 56 --expect-to 0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c --policy /in/thor-approve-policy.json

where the policy is `{"version":1,"chains":{"eth":{"chain_id":56,"allow_calls":[{"to":"0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c","selector":"0x095ea7b3"}]}}}`.
Sign with the same policy and `tx-broadcast`; wait for the approve to confirm before the deposit.

## 3. Deposit (the swap)

The router call is an unknown selector, so authorize it the same way — an `allow_calls` entry for
`(router, 0x44bc937b)`:

    tx-build --chain eth --chain-id 56 --nonce 1 --max-fee-per-gas 1000000000 --priority-fee 1000000000 --gas 250000 --to 0xb30ec53f98ff5947ede720d32ac2da7e52a5f56b --data 0xDEPOSIT_CALLDATA | tx-verify --chain-id 56 --expect-to 0xb30ec53f98ff5947ede720d32ac2da7e52a5f56b --policy /in/thor-deposit-policy.json
    tx-sign --tx deposit.json --chain-id 56 --expect-to 0xb30ec53f98ff5947ede720d32ac2da7e52a5f56b --policy /in/thor-deposit-policy.json < key
    tx-broadcast --chain eth --url NODE < deposit.signed

Gas is from `eth_estimateGas` where it can be estimated; the deposit reverts until the approve lands,
so it cannot be estimated beforehand — set a limit generously (a token deposit is ~120k–250k). Track
the cross-chain leg at `/thorchain/tx/status/<deposit-hash>`; the destination asset arrives on its own
chain, so an EVM simulation shows only the token leaving (that is expected, not a failure).

## Measured on mainnet

This path swapped 0.00050011 BTCB (BNB Chain) to ~511 DOGE on 2026-10-27: approve
`0x3072220843c48be8fab90cb5f344bf4117b13bd8624470fa761cabfa99eb3a22`, deposit
`0x1f41f03ffb1f5f818ff0739c7553edc6265188d99fafc4aa5f20142513b48f0c`, DOGE payout
`6b83d91caf63b051dd87d9b0c6ea015ee348800938f15f79f4f6617cd8e56db0`.

## Tests

`scripts/e2e.d/approve-policy.sh` covers approve/deposit authorization under `allow_calls` (verify and
pty sign, pass and deny). The build/verify/sign/broadcast mechanics are `scripts/e2e.d/contract-tx.sh`
and `evm-devnet.sh`. UNTESTED in CI: the live THORChain quote and the cross-chain settlement.

See [thorchain-swap-utxo.md](thorchain-swap-utxo.md) for the reverse direction (a UTXO coin into a
swap) and [thorchain-thorname.md](thorchain-thorname.md) for affiliate names.
