# Chain: Litecoin and Dogecoin

Same pipeline as Bitcoin with `--chain ltc` / `--chain doge`. Sweep is built (UTXO PSBT). Dogecoin
has no segwit, so its inputs carry the full previous transaction.

<!-- e2e: expect=LUWPbpM43E2p7ZSh8cyTBEkvpHmr3cB8Ez ; expect=ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh ; expect=DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC -->
    ./blocktools run 'seed-repair < /in/seed.txt | seed-to-master | derive --chain ltc,doge --count 1'

<!-- e2e: expect=ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh ; fund=ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh -->
    recipes/recover.sh /in/seed.txt - --chain ltc --goal balance

Sweep: `recipes/recover.sh in/seed.txt ltc1q... --chain ltc` (e2e: full sweep for both ltc and doge on the 127.0.0.1 mock chain,
both codes typed by the pty driver). Defaults: litecoinspace.org. Dogecoin has no
default Esplora, so pass `--url`.
UNTESTED against a live LTC or DOGE network.

## Dogecoin (or any fork) without dumptxoutset

Dogecoin 1.14 has no `dumptxoutset`. Stop the node (or copy `chainstate/` while it is stopped), then
build the dump from its chainstate directly and search your notes against it:

    dogecoin-cli stop
    utxo-set --chainstate ~/.dogecoin/chainstate --write-dump /in/doge-utxo.dat --stats
    wallet-finder --dump /in/doge-utxo.dat --chain doge < /in/notes.txt > /secrets/hits.jsonl

Tested against a real Dogecoin 1.14.9 regtest chainstate, end to end through wallet-finder.
To list the coins themselves (JSON lines, or `--addresses-only`, or a `--census` summary):

    chainstate-dump --chain doge --census ~/.dogecoin/chainstate

Mainnet chainstates are not measured here. Details: docs/CHAINS.md.
