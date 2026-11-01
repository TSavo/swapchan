# Inspect a BOLT11 Lightning invoice

> ⚠️ DANGEROUS: use at your own risk. Code that handles keys and signs transactions should
> always be read and audited by you before you trust it with real funds. Used incorrectly,
> it can destroy your money.

`bolt11` decodes a BOLT11 Lightning invoice to its fields and re-encodes it byte-identically.
It is offline, holds no keys, and signs nothing. It is a **reader**: blocktools builds and
signs on-chain transactions, not the live Lightning channel protocol (commitments, HTLCs,
routing), which needs a running node and is out of scope. Use `bolt11` to see exactly what an
invoice asks for — the amount, the destination node, the description, the expiry — before you
pay it from whatever Lightning wallet you use.

```sh
bolt11 <invoice>              # decode: one JSON line of fields
bolt11 --reencode <invoice>   # re-encode and report whether it is byte-identical
```

The decode recovers the **payee node pubkey from the signature** (`recovered_payee`), so you
learn who the invoice is really payable to even when the invoice carries no explicit payee
field. A tampered checksum or signature is rejected (nonzero exit); a string that is not a
Lightning invoice is rejected with `not_a_lightning_invoice`.

Fields you get: `network`, `currency`, `amount_msat` (absent for a zero-amount/donation
invoice), `timestamp`, `payment_hash`, `description` (or `description_hash`), `payment_secret`,
`recovered_payee`, `expiry`, and the raw tagged fields. Amounts are in **millisatoshi**:
`2500u` BTC = 2500 × 100,000 = 250,000,000 msat.

## Before you pay an invoice

1. **Decode it:** `bolt11 <invoice>`.
2. **Read it yourself.** Check `amount_msat` is what you expect, `recovered_payee` is the node
   you mean to pay, the `description` matches the thing you are buying, and the `expiry` has
   not passed.
3. **Pay** from your own Lightning wallet. blocktools does not open channels or route payments.

## Tested examples

Decode a public BOLT11 spec invoice (2500u, "1 cup coffee"); it recovers the spec node id and
reports the amount in millisatoshi:

<!-- e2e: expect=250000000 ; expect=03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad ; expect="status":"ok" -->
    bolt11 lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh

A non-Lightning string is rejected (exit 2):

<!-- e2e: expect=not_a_lightning_invoice ; rc=2 -->
    bolt11 bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4
