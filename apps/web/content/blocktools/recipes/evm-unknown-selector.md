# EVM: look up an unknown selector

> ⚠️ DANGEROUS: use at your own risk. Code that handles keys and signs transactions should
> always be read and audited by you before you trust it with real funds. Used incorrectly,
> it can destroy your money.

Task: calldata or a revert starts with a 4-byte selector you do not recognise. `sig-hash` has no database: you supply candidate
signatures (from the contract's source or ABI) and it tells you which one hashes to the selector. Part of the
[EVM contract recipes](evm-contract-data.md).

Fixtures are raw Ethereum mainnet JSON-RPC responses in [fixtures/evm-mainnet/](fixtures/evm-mainnet/); the request
behind each file is in [PROVENANCE.md](fixtures/evm-mainnet/PROVENANCE.md). Live `curl` lines are UNTESTED here: CI never
touches the network.

A revert came back as bare `0x5bf6f916` (fixture `04e`: `eth_call` of Universal Router
`execute(bytes,bytes[],uint256)` with deadline 1). Candidates are the errors typed from the router's source,
[fixtures/evm/candidate-errors.txt](fixtures/evm/candidate-errors.txt):

<!-- e2e: expect="matches":["error TransactionDeadlinePassed()"] ; expect="status":"ok" ; rc=0 -->
    sig-hash --lookup "$(jq -r .error.data recipes/fixtures/evm-mainnet/04e-custom-error-eth_call.json)" --sigs recipes/fixtures/evm/candidate-errors.txt

Forward direction, to check one guess:

<!-- e2e: expect="selector":"0x5bf6f916" ; rc=0 -->
    sig-hash 'error TransactionDeadlinePassed()'

Now decode it: [evm-decode-revert.md](evm-decode-revert.md).
