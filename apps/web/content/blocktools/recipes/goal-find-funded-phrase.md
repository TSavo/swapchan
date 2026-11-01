# Goal: find which of your phrases still holds coins (offline UTXO set)

You have text you wrote yourself (old notes, a diary, a password list) and suspect one sentence in it was a
brainwallet. Checking every candidate on a block explorer leaks every guess, and is slow. Instead, take a
copy of the whole UTXO set from your own node and test the candidates against it **offline**.

1. On your node (Bitcoin Core 25 or newer), write the UTXO set to a file. This is public chain data, no keys:

        bitcoin-cli dumptxoutset /path/utxo.dat

   Or use rpc, which needs `--allow-unlisted` because the call writes a file. The slow-method default timeout
   is 3600 s; use `--timeout` to change it:

        rpc --allow-unlisted --auth-file ~/.bitcoin/.cookie http://127.0.0.1:8332 dumptxoutset '["/path/utxo.dat"]'

   Either way the file is written on the node host. Copy it to wherever `utxo-set` runs. If rpc reports
   status `timeout`, the node is still writing the file, so wait for it to finish.

   Both file layouts are read: Core 25-27 (no header magic) and Core 28+ (`utxo` magic, network
   magic, version). The format is detected from the first bytes; the network comes from the Core 28+ header,
   and addresses on stdin are matched by their scriptPubKey, so you do not need `--chain`.

2. Ask whether particular addresses are funded (`utxo-set`): one JSON line each, with `value_sat` (the sum
   of every unspent output paying exactly that script) and `outputs`.

<!-- e2e: expect="status":"funded" ; expect="value_sat":1001 ; expect=1BoatSLRHtKNngkdXEeobR76b53LETtpyT ; expect="status":"empty" -->
    utxo-set --dump /in/utxo.dat < /in/addresses.txt

3. Search your text for a funded brainwallet (`wallet-finder`). Every line, every sentence and every run of
   1 to 6 words becomes a candidate; each candidate's sha256 key gives the five address shapes (p2pkh,
   p2pkh-uncompressed, p2sh-p2wpkh, p2wpkh, p2tr), and each is looked up in the set. A hit prints the
   phrase, scheme, address and balance. **No key is printed and nothing is signed.** The phrase itself is
   printed, so send stdout to a private file (as below), not to a terminal log or an agent; the count of hits
   goes to stderr. Both tools run on the host for now, not in the sealed image (neither opens a network
   connection). Turn a hit into a key inside the sealed container with `phrase-to-key` (see input-brainwallet.md).

<!-- e2e: expect="hits":5 ; expect="status":"ok" -->
    wallet-finder --dump /in/utxo.dat < /in/notes.txt > /secrets/hits.jsonl

   Exit 0 means at least one hit, 1 means none (like `grep`). More candidates: `--rules case,swap,typo,digit`
   (the pw-candidates rules) and a wider `--window`. WarpWallet: `--scheme warpwallet --salt EMAIL`
   (scrypt: far slower per candidate, measured below). Hits print in the dump's network encoding (`--chain` overrides).

Measured (`sh scripts/utxo-bench.sh`, synthetic Core-25 dump, Intel Xeon 8 threads, Linux x86_64, at 751299a):

* load: a 20,000,000-coin dump in 9.1 seconds (2.2M coins/s), one thread (box load and page cache move this 5.8-20.8 s);
* memory: peak RSS of 0.99 GB, that is 48 bytes per distinct script plus the bloom filter;
* bloom: over 1,000,000 never-funded queries the bloom filter passed 0.31%, and the exact set reported 0 funded;
* `wallet-finder`, one thread: 20380 sha256 candidates/s, five addresses each;
* WarpWallet: 200 candidates in 118.8 seconds.

Scale to mainnet is not measured here: memory grows with the number of distinct funded scripts, not with
chain size.

How the set works: every funded scriptPubKey is held in RAM, sorted, with its summed value; a bloom filter
in front answers most misses without touching the sorted array, and every bloom "maybe" is confirmed by
an exact binary search, so a bloom false positive is never reported as funded. Scripts other than the five
standard templates (P2PK, multisig, ...) are keyed by their SHA-256. Measured size, speed and bloom
false-positive rate are in docs/CLAIMS.md (`utxo-*` claims); the test that a known-funded address is found
and a never-funded one is not runs against a dump written by real Bitcoin Core 25.2
(scripts/e2e.d/utxo-real.sh).

NOT BUILT: reading the node's chainstate LevelDB directly (use `dumptxoutset`), non-Bitcoin dumps other
than those Core writes, and keeping the loaded set between runs (each run re-reads the dump).
