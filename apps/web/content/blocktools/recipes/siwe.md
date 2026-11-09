# Build or check a Sign-In with Ethereum (EIP-4361) message

> ⚠️ DANGEROUS: use at your own risk. Code that handles keys and signs transactions should
> always be read and audited by you before you trust it with real funds. Used incorrectly,
> it can destroy your money.

`siwe` is a stdin/stdout filter. It reads no keys and makes no signatures.

- `siwe build [--raw] < fields.json` turns the JSON fields (spruceid/siwe camelCase names: `scheme`,
  `domain`, `address`, `statement`, `uri`, `version`, `chainId`, `nonce`, `issuedAt`, `expirationTime`,
  `notBefore`, `requestId`, `resources`) into the message text. Unknown keys and invalid values are
  refused (exit 2). `--raw` prints only the message bytes (no newline), ready for `msg-sign` or
  `msg-verify --message-file`.
- `siwe parse` accepts only valid, canonical EIP-4361 text: exactly what `build` prints for the same
  fields (no CR, no trailing newline or extra spaces). Anything else is refused (exit 1).
  The checks are opt-in: `--domain D` and `--nonce N` (exact match), and `--now RFC3339` or
  `--check-time` (`expired` at or after Expiration Time, `not_yet_valid` before Not Before). The output
  lists what was `checked` and what was not (`unchecked` always holds `signature`).

**The signature is never checked by `siwe`.** Check it with `msg-verify --chain eth` on the same text.
Sources for the test vectors and what is untested: docs/PROVENANCE-siwe.md.

## Tested examples

Build the message from spruceid/siwe's "example message" fields:

<!-- e2e: expect="status":"ok" ; expect=login.xyz wants you to sign in with your Ethereum account -->
    siwe build < recipes/fixtures/siwe/example-message.json

Parse it back with a domain, nonce and time check:

<!-- e2e: expect="checked":["domain","nonce","time"] ; expect="status":"ok" -->
    siwe build --raw < recipes/fixtures/siwe/example-message.json | siwe parse --domain login.xyz --nonce bTyXgcQxn2htgkjJn --now 2026-01-01T00:00:00Z

A message for another site is refused (exit 1):

<!-- e2e: expect=domain_mismatch ; rc=1 -->
    siwe build --raw < recipes/fixtures/siwe/example-message.json | siwe parse --domain evil.example

## Untested

- Messages made by real wallets and dapps beyond spruceid's published vectors.
- Wasm: there is no wasm export for `siwe` yet (CLI only).
