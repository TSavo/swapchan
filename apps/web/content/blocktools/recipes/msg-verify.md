# Check a signed message (proof of control) on Ethereum, Bitcoin, Tron, Solana or Cosmos

> ⚠️ DANGEROUS: use at your own risk. Code that handles keys and signs transactions should
> always be read and audited by you before you trust it with real funds. Used incorrectly,
> it can destroy your money.

`msg-verify` checks that a signature over a text message was made by the key behind an address.
It reads no keys. The chain comes from the address; options that do not apply to that chain are
refused. Solana needs `--format raw` (wallet `signMessage`) or `--format offchain-v0`
(`solana sign-offchain-message`). Cosmos ADR-036 needs `--pubkey` (base64 33-byte compressed key).
Sources for the vectors below and what is untested: docs/PROVENANCE-msg.md.

## Tested examples

A Tron signMessageV2 signature (Trust Wallet Core's public test vector):

<!-- e2e: expect="chain":"tron" ; expect="status":"ok" -->
    msg-verify --address TWWb9EjUWai17YEVB7FR8hreupYJKG9sMR --message "Hello World" --sig bc0753c070cc55693097df11bc11e1a7c4bd5e1a40b9dc94c75568e59bcc9d6b50a7873ef25b469e494490a54de37327b4bc7fc825c81a377b555e34fb7261ba1c

A Solana raw signature (Trust Wallet Core's public test vector):

<!-- e2e: expect="format":"raw" ; expect="status":"ok" -->
    msg-verify --address H3imdwa5VQMB5V6yBNyrWwPdSKs4k9Pcpsu4diogoAcg --message "Hello world" --format raw --sig 2iBZ6zrQRKHcbD8NWmm552gU5vGvh1dk3XV4jxnyEdRKm8up8AeQk1GFr9pJokSmchw7i9gMtNyFBdDt8tBxM1cG

Without `--format`, a Solana check is refused (exit 2):

<!-- e2e: expect=solana_format_required ; rc=2 -->
    msg-verify --address H3imdwa5VQMB5V6yBNyrWwPdSKs4k9Pcpsu4diogoAcg --message "Hello world" --sig 2iBZ6zrQRKHcbD8NWmm552gU5vGvh1dk3XV4jxnyEdRKm8up8AeQk1GFr9pJokSmchw7i9gMtNyFBdDt8tBxM1cG

## Untested

A Cosmos ADR-036 signature from a real wallet, and a real `solana sign-offchain-message` signature,
have not been checked here (see docs/PROVENANCE-msg.md).
