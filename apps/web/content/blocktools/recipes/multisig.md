# m-of-n multisig: build, carry into a Plan, each cosigner partial-signs, combine

> ⚠️ DANGEROUS: use at your own risk. Code that handles keys and signs transactions should
> always be read and audited by you before you trust it with real funds. Used incorrectly,
> it can destroy your money.

A multisig output needs **m of n** cosigners to spend. blocktools builds the script, carries it
through the declarative Plan, lets each cosigner sign **in turn on their own offline machine**
(no key ever leaves it), and combines the partial signatures into one finished transaction. It
is standard BIP174 PSBT throughout, so it interoperates with Bitcoin Core, hardware wallets and
Electrum. This recipe covers Bitcoin **P2WSH** (ECDSA); for the **Taproot script-path** variant
swap `multisig` → `taproot-multisig` and `--witness-script` → `--tap-leaf-script` — every other
step is identical.

The five tools, as a pipeline:

```
multisig  ->  tx-plan input --witness-script  ->  resolve  ->  tx-sign --partial (×m)  ->  tx-combine
(address)      (declare the input in the Plan)   (PSBT)       (each cosigner, offline)    (finished tx)
```

- `multisig` and `taproot-multisig` are **offline and keyless** — they read only public pubkeys
  and print the script, address and a `wsh(multi(…))` descriptor. The pubkey **order is
  consensus-significant** and is preserved exactly as you pass it.
- `tx-sign --partial` adds **only this cosigner's** signature and prints the still-unfinalized
  PSBT — no finished transaction. It runs the Plan/policy check first, so a cosigner only
  partial-signs a transaction that satisfies the agreed assertions (recipient, fee cap).
- `tx-combine` merges the cosigners' partial PSBTs and finalizes **once the threshold is met**;
  below threshold it refuses with `not_enough_signatures`. It is keyless.

## 1. Build the address (offline, keyless, shareable)

Build a 3-of-5 P2WSH from the five cosigners' compressed pubkeys. The output's `address` is the
deposit address; the `witness_script` is what every spender needs later; the `descriptor` imports
into Core/Electrum as a watch-only wallet:

```sh
multisig 3 --pubkey <PK1> --pubkey <PK2> --pubkey <PK3> --pubkey <PK4> --pubkey <PK5> --network bitcoin
```

## 2. Declare the input in a Plan

After the address is funded, carry the `witness_script` into a Plan so the spend is fully
described and checkable before anyone signs. `tx-plan check` runs the **same** `policy::check`
the signer runs, so pass-check ⟺ sign holds:

```sh
tx-plan new --chain btc \
  | tx-plan input --txid <TXID> --vout <N> --amount <SATS> --address <P2WSH> --witness-script <WS> \
  | tx-plan output --to <DEST> --amount <SATS> \
  | tx-plan change --to <CHANGE> \
  | tx-plan fee-rate --satvb <RATE> \
  | tx-plan expect-to --address <DEST> \
  | tx-plan cap-fee --max <SATS> > plan.json
tx-plan resolve --plan plan.json --context ctx.json > unsigned.json   # the PSBT
tx-plan check   --plan plan.json --context ctx.json                   # must be clean
```

## 3. Each cosigner partial-signs (offline, in turn)

Each of the m cosigners takes the PSBT to their own offline machine and runs `tx-sign --partial`
with the Plan. It shows the summary on the terminal and only signs after they type the code it
prints; it emits a PSBT with **one more** partial signature and no finished transaction:

```sh
./blocktools run 'tx-sign --partial --plan /in/plan.json < /in/psbt.txt' > partial-1.psbt
# …repeat on cosigner 2's and cosigner 3's machines, each starting from the previous partial…
```

## 4. Combine into the finished transaction

`tx-combine` merges the collected partials and finalizes once the quorum is reached; decode the
result to confirm the P2WSH input is spent and the outputs are what the Plan declared:

```sh
tx-combine partial-1.psbt partial-2.psbt partial-3.psbt > signed.txt
tx-decode --text < signed.txt      # read it: outputs, fee, no surprises
```

Below the threshold `tx-combine` refuses (`not_enough_signatures`); a signature from a key
outside the script is rejected; a tampered Plan assertion makes `tx-sign --partial` refuse. The
full round-trip (and these refusals) is proven end to end, no network, in
`scripts/e2e.d/multisig.sh` and `scripts/e2e.d/taproot-multisig.sh`.

## Tested example

The offline, keyless build on public test keys (secp256k1 generator multiples 1–5) — a 3-of-5
P2WSH with its `wsh(multi(…))` descriptor:

<!-- e2e: expect="status":"ok" ; expect=wsh(multi( -->
    multisig 3 --pubkey 0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798 --pubkey 02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5 --pubkey 02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9 --pubkey 02e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13 --pubkey 022f8bde4d1a07209355b4a7250a5c5128e88b84bddc619ab7cba8d569b240efe4 --network bitcoin
