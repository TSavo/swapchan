import { readFileSync } from "node:fs";
import { CHAIN_COUNT, UTXO_CHAIN_COUNT } from "@swapchan/shared";
import { parseTransaction, recoverMessageAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEV_TOOLS, devToolRoutes, MAX_BODY, refuseSecrets, runDevTool } from "./devtools.js";

const XPUB =
  "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8";
const XPRV =
  "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi";
const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const ALICE_HEX = "d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";

const post = (app: ReturnType<typeof devToolRoutes>, fn: string, body: unknown, ip = "1.2.3.4") =>
  app.request(`/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const ok = (fn: string, i: unknown) => {
  const r = runDevTool(fn, i);
  if (!r.ok) throw new Error(`${fn}: ${r.error_code}`);
  return r.result as Record<string, unknown>;
};

describe("dev tools (blocktools, public input only)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("address detect / validate / convert / cashaddr / script", () => {
    expect(
      ok("detect-address", { address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" }).chains,
    ).toContainEqual({
      chain: "btc",
      kind: "P2pkh",
    });
    expect(
      ok("validate-address", { chain: "btc", address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb" }).valid,
    ).toBe(false);
    expect(
      ok("validate-address", { chain: "btc", address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" }),
    ).toMatchObject({
      valid: true,
      kind: "P2pkh",
    });
    expect(
      runDevTool("convert-address", { address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", to: "eth" }),
    ).toMatchObject({
      ok: false,
      error_code: "no_equivalent",
    });
    expect(
      ok("cashaddr", {
        op: "to_legacy",
        address: "bitcoincash:qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy",
      }).legacy,
    ).toBe("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
    expect(
      ok("address-script", {
        op: "to_script",
        chain: "btc",
        address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
      }).script,
    ).toBe("76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac");
    // Zcash t1 (2-byte version) and uppercase bech32 give the same script as the BTC form of the same hash
    const P2PKH = "76a91477bff20c60e522dfaa3350c39b030a5d004e839a88ac";
    expect(
      ok("address-script", {
        op: "to_script",
        chain: "btc",
        address: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
      }).script,
    ).toBe(P2PKH);
    expect(
      ok("address-script", {
        op: "to_script",
        chain: "zec",
        address: "t1UnnMmegrDJFVUW9iVz2CaABWLK2ztsf3X",
      }).script,
    ).toBe(P2PKH);
    expect(ok("address-script", { op: "from_script", chain: "zec", script: P2PKH })).toMatchObject({
      address: "t1UnnMmegrDJFVUW9iVz2CaABWLK2ztsf3X",
    });
    const W = "0014751e76e8199196d454941c45d1b3a323f1433bd6";
    expect(
      ok("address-script", {
        op: "to_script",
        chain: "btc",
        address: "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4",
      }).script,
    ).toBe(W);
    expect(
      ok("address-script", {
        op: "to_script",
        chain: "btc",
        address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
      }).script,
    ).toBe(W);
    expect(
      runDevTool("address-script", { op: "to_script", chain: "zec", address: "t1abc" }),
    ).toMatchObject({ ok: false });
  });

  it("xpub addresses (BIP32 vector 1, m/0/0)", () => {
    const r = ok("xpub-addresses", { chain: "btc", xpub: XPUB, count: 2 });
    expect((r.addresses as { address: string }[]).map((a) => a.address)).toEqual([
      "12CL4K2eVqj7hQTix7dM7CVHCkpP17Pry3",
      "13Q3u97PKtyERBpXg31MLoJbQsECgJiMMw",
    ]);
    expect(runDevTool("xpub-addresses", { chain: "btc", xpub: XPUB, count: 21 })).toMatchObject({
      ok: false,
      error_code: "bad_count",
    });
  });

  it("xprv rejected (and other secret-looking input), before blocktools is called", () => {
    for (const [fn, body] of [
      ["xpub-addresses", { chain: "btc", xpub: XPRV }],
      ["detect-address", { address: XPRV }],
      ["xpub-addresses", { chain: "btc", xpub: XPRV.replace(/^x/, "z") }],
      ["detect-address", { address: "5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ" }],
      ["detect-address", { address: "abandon ".repeat(11) + "about" }],
      ["detect-address", { address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", privateKey: "x" }],
      ["detect-address", { address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", mnemonic: "x" }],
      ["detect-address", { address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", seed: "x" }],
    ] as const)
      expect(runDevTool(fn, body)).toMatchObject({ ok: false, error_code: "secret_input_refused" });
    expect(() => refuseSecrets({ a: [{ b: XPRV }] })).toThrow("secret_input_refused");
  });

  it("ss58, storage key, solana, hashes, chain params", () => {
    expect(ok("ss58", { op: "decode", address: ALICE })).toEqual({
      prefix: 42,
      account: ALICE_HEX,
    });
    expect(ok("ss58", { op: "encode", account: ALICE_HEX, prefix: 0 }).address).toBe(
      "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
    );
    expect(ok("polkadot-storage-key", { account: ALICE }).key).toMatch(
      /^0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9/,
    );
    expect(
      ok("solana-ata", {
        owner: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      }).address,
    ).toBe("FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B");
    expect(
      ok("solana-pda", {
        seeds: ["6d65746164617461"],
        program: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
      }),
    ).toMatchObject({ bump: 253 });
    expect(ok("anchor-discriminator", { name: "initialize" }).discriminator).toBe(
      "afaf6d1f0d989bed",
    );
    expect(ok("blake2b", { data: "616263" }).hash).toBe(
      "bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319",
    );
    expect(ok("twox128", { text: "System" }).hash).toBe("26aa394eea5630e07c48ae0c9558cef7");
    // displayed counts come from @swapchan/shared CHAIN_TABLE (asserted in blocktools.chaintable.test.ts)
    expect(ok("chain-params", {}).count).toBe(CHAIN_COUNT);
    const rows = ok("chain-params", {}).chains as { p2pkh: number[] | null }[];
    expect(rows.filter((r) => (r.p2pkh?.length ?? 0) > 0).length).toBe(UTXO_CHAIN_COUNT);
    expect(ok("chain-params", { chain: "btc" })).toMatchObject({ ticker: "BTC" });
  });

  it("tron-tx decodes unsigned raw_data, computes txid, refuses signed tx", () => {
    const RAW =
      "0a02ab122208001122334455667740e0a499ffbc315a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a154174472e7d35395a6b5add427eecb7f4b62ad2b071121541a614f803b6fd780986a42c78ec9c7f77e6ded13c18c0843d7080d095ffbc31";
    const TXID = "dded85a3588511384762f9e52c4168e087a19c2eea755ede8c12e612cb5b19e1";
    expect(ok("tron-tx", { op: "txid", hex: RAW })).toEqual({ txid: TXID });
    const d = ok("tron-tx", { op: "decode", hex: `0x${RAW}` });
    expect(d).toMatchObject({ txid: TXID, signatures: 0, expiration: 1700000060000 });
    expect((d.contracts as Record<string, unknown>[])[0]).toMatchObject({
      type: "TransferContract",
      amount_sun: "1000000",
      owner: "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7",
      to: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    });
    // Transaction{raw_data=RAW, signature=[65 bytes]} -> refused
    const varint = (n: number): string =>
      n < 128 ? n.toString(16).padStart(2, "0") : ((n & 127) | 128).toString(16) + varint(n >> 7);
    const signed = `0a${varint(RAW.length / 2)}${RAW}1241${"11".repeat(65)}`;
    expect(runDevTool("tron-tx", { op: "decode", hex: signed })).toMatchObject({
      ok: false,
      error_code: "signed_tx_refused",
    });
    expect(runDevTool("tron-tx", { op: "txid", hex: "zz" })).toMatchObject({ ok: false });
  });

  it("supported-chains lists verified and unverified chains; cashaddr encode", () => {
    const all = ok("supported-chains", {});
    expect(all.verified).toBeGreaterThan(0);
    expect((all.chains as unknown[]).length).toBe(
      (all.verified as number) + (all.unverified as number),
    );
    expect(typeof all.version).toBe("string");
    expect(ok("supported-chains", { chain: "btc" })).toMatchObject({
      ticker: "BTC",
      verified: true,
    });
    expect(runDevTool("supported-chains", { chain: "nope" })).toMatchObject({
      ok: false,
      error_code: "unknown_chain",
    });
    expect(
      ok("cashaddr", {
        op: "encode",
        kind: "p2pkh",
        hash: "76a04053bda0a88bda5177b86a15c3b29f559873",
      }),
    ).toEqual({ cashaddr: "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a" });
    expect(
      runDevTool("cashaddr", { op: "encode", kind: "p2wsh", hash: "00".repeat(20) }),
    ).toMatchObject({
      ok: false,
      error_code: "bad_kind",
    });
  });

  it("no signing, recovery, raw-tx or secret functionality is exposed", () => {
    // One named exception: typed-data-verify checks a PUBLIC signature over PUBLIC EIP-712 data
    // (digest + signer recovery run in blocktools). It never signs, takes no key, and no tx.
    const PUBLIC_SIG_CHECK = new Set(["typed-data-verify", "msg-verify"]);
    for (const k of Object.keys(DEV_TOOLS).filter((k) => !PUBLIC_SIG_CHECK.has(k)))
      expect(k).not.toMatch(
        /sign|sweep|recover|seed|key(?!$)|keystore|decode-tx|verify|psbt|wif|derive-priv/,
      );
    expect(
      runDevTool("typed-data-verify", { typed_data: "{}", private_key: "00".repeat(32) }),
    ).toMatchObject({ ok: false, error_code: "secret_input_refused" });
    expect(runDevTool("buildUnsignedSweep", {})).toMatchObject({
      ok: false,
      error_code: "unknown_tool",
    });
  });

  it("never logs request bodies (success, error and refused paths)", async () => {
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const app = devToolRoutes({ perMinute: 1000 });
    const MARK = "5Fmarker000000000000000000000000000000000000";
    await post(app, "detect-address", { address: MARK });
    await post(app, "ss58", { op: "decode", address: MARK });
    await post(app, "xpub-addresses", { chain: "btc", xpub: XPRV, note: MARK });
    await post(app, "nope", { address: MARK });
    await post(app, "detect-address", `{"address":"${MARK}"`);
    const res = await post(app, "ss58", { op: "decode", address: MARK });
    expect(await res.text()).not.toContain(MARK); // errors never echo input
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(MARK);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("size cap, bad json, unknown tool", async () => {
    const app = devToolRoutes({ perMinute: 1000 });
    expect((await post(app, "twox128", { text: "a".repeat(MAX_BODY) })).status).toBe(413);
    expect((await post(app, "twox128", "{")).status).toBe(400);
    expect((await post(app, "nope", {})).status).toBe(404);
    const r = await post(app, "twox128", { text: "System" });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("rate limits per client, per 60s window", async () => {
    let t = 0;
    const app = devToolRoutes({ perMinute: 3, now: () => t });
    for (let n = 0; n < 3; n++)
      expect((await post(app, "twox128", { text: "a" })).status).toBe(200);
    const r = await post(app, "twox128", { text: "a" });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect((await post(app, "twox128", { text: "a" }, "5.6.7.8")).status).toBe(200);
    t = 60_000;
    expect((await post(app, "twox128", { text: "a" })).status).toBe(200);
  });
});

// blocktools 07a5023 keyless exports, real wasm calls on the upstream 3-of-5 vector
// (crates/tx/tests/data/multisig-3of5.json, recorded from the blocktools CLIs; public keys only).
describe("multisig / combine / plan resolve / msg verify (blocktools wasm, keyless)", () => {
  const V = JSON.parse(
    readFileSync(new URL("./fixtures/bt-multisig-3of5.json", import.meta.url), "utf8"),
  );
  const strip = (o: Record<string, unknown>) => {
    const { status: _s, tool: _t, ...r } = o;
    return r;
  };

  it("multisig-address and taproot-multisig-address match the CLI vectors", () => {
    expect(
      ok("multisig-address", { threshold: 3, pubkeys: V.pubkeys, network: "bitcoin" }),
    ).toEqual(strip(V.multisig));
    expect(ok("multisig-address", { threshold: 3, pubkeys: V.pubkeys }).address).toBe(
      "bc1q07xqgp3f0dmyr2gxs0zp5k9h5wjx5yp9mvygn2ywguwgnn73qtxsmggkmc",
    );
    expect(ok("taproot-multisig-address", { threshold: 3, pubkeys: V.pubkeys })).toEqual(
      strip(V.taproot_multisig),
    );
    expect(
      ok("multisig-address", { threshold: 3, pubkeys: [...V.pubkeys].reverse() }).address,
    ).not.toBe(V.multisig.address);
    expect(runDevTool("multisig-address", { threshold: 6, pubkeys: V.pubkeys })).toMatchObject({
      ok: false,
    });
  });

  it("tx-combine finalizes 3 of 5 partials and passes the blocktools errors through", () => {
    expect(ok("tx-combine", { psbts: V.partials })).toEqual(strip(V.combine));
    for (const [psbts, code] of [
      [V.partials.slice(0, 2), "not_enough_signatures"],
      [[], "no_psbts"],
      [["00"], "not_a_psbt"],
    ] as const)
      expect(runDevTool("tx-combine", { psbts })).toMatchObject({ ok: false, error_code: code });
  });

  it("tx-plan-resolve: utxo -> psbt, evm -> unsigned_tx, account -> family_not_built", () => {
    expect(ok("tx-plan-resolve", { plan: V.plan, context: V.context })).toEqual(strip(V.resolve));
    const evm = ok("tx-plan-resolve", {
      plan: {
        chain: "bsc",
        chain_id: 56,
        steps: [
          {
            op: "approve",
            token: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c",
            spender: "0xb30ec53f98ff5947ede720d32ac2da7e52a5f56b",
            amount: "500112480000000",
          },
        ],
      },
      context: { nonce: 13, gas: 60000, max_fee_per_gas: 1000000000, priority_fee: 1000000000 },
    });
    expect(evm).toMatchObject({ chain: "bsc", family: "evm", type: "evm-1559" });
    const tx = parseTransaction(`0x${String(evm.unsigned_tx).replace(/^0x/, "")}`);
    expect(tx).toMatchObject({ chainId: 56, nonce: 13, gas: 60000n, type: "eip1559" });
    expect(tx.to?.toLowerCase()).toBe("0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c");
    expect(tx.data?.slice(0, 10)).toBe("0x095ea7b3");
    const acct = runDevTool("tx-plan-resolve", { plan: { chain: "atom", steps: [] } });
    expect(acct).toMatchObject({ ok: false });
    expect((acct as { error_code: string }).error_code).toMatch(/^family_not_built/);
    expect(runDevTool("tx-plan-resolve", { plan: "{" })).toMatchObject({
      ok: false,
      error_code: "bad_plan",
    });
  });

  it("msg-verify: Bitcoin signmessage and EIP-191 vectors (Trust Wallet Core)", async () => {
    const sig =
      "ILH5K7JQLaRGaKGXXH5mYM6FIIy9IWyY4JUPI+PHYY4WaupxUbg+zy0bhBCrDuehy9x4WidwjkRR1GSLnWvOXBo=";
    expect(
      ok("msg-verify", {
        address: "19cAJn4Ms8jodBBGtroBNNpCZiHAWGAq7X",
        message: "test signature",
        sig,
      }),
    ).toEqual({
      address: "19cAJn4Ms8jodBBGtroBNNpCZiHAWGAq7X",
      chain: "btc",
      recovered: "19cAJn4Ms8jodBBGtroBNNpCZiHAWGAq7X",
      status: "ok",
    });
    const h = `H${sig.slice(1)}`;
    expect(
      ok("msg-verify", {
        address: "1E4T9JZ3mq6cdgiRJEWzHqDXb9t322fE6d",
        message: "test signaturE",
        sig: h,
      }).status,
    ).toBe("signer_mismatch");
    const esig =
      "0x21a779d499957e7fd39392d49a079679009e60e492d9654a148829be43d2490736ec72bc4a5644047d979c3cf4ebe2c1c514044cf436b063cb89fc6676be71101b";
    const e = ok("msg-verify", {
      address: "0x0000000000000000000000000000000000000001",
      message: "Foo",
      sig: esig,
    });
    expect(e).toMatchObject({ chain: "eth", status: "signer_mismatch" });
    const back = ok("msg-verify", {
      address: e.recovered,
      message: "466f6f",
      sig: esig,
      message_is_hex: true,
    });
    expect(back.status).toBe("ok");
    const viemSigner = await recoverMessageAddress({
      message: "Foo",
      signature: esig as `0x${string}`,
    });
    expect(String(e.recovered).toLowerCase()).toBe(viemSigner.toLowerCase());
    expect(
      runDevTool("msg-verify", {
        address: "0x0000000000000000000000000000000000000001",
        message: "x",
        sig: "0x00",
      }),
    ).toMatchObject({ ok: false, error_code: "signature_not_65_bytes" });
  });

  it("msg-verify: Cosmos/Solana-ambiguous addresses are refused (blocktools msg_chains.rs vectors)", () => {
    for (const address of [
      "osmo148yundzwcr97np3s8c8yrx2p6p33ck6sd4stfm",
      "juno1av6j5wgy64cwknm75pwyvegpwduf753uytqkwk",
    ])
      expect(runDevTool("msg-verify", { address, message: "x", sig: "AA==" })).toMatchObject({
        ok: false,
        error_code: "ambiguous_address",
      });
  });

  it("msg-verify chain option (msgVerifyOpts): named chain routes, mismatch is typed", () => {
    for (const address of [
      "osmo148yundzwcr97np3s8c8yrx2p6p33ck6sd4stfm",
      "juno1av6j5wgy64cwknm75pwyvegpwduf753uytqkwk",
    ]) {
      expect(
        runDevTool("msg-verify", { address, message: "x", sig: "AA==", pubkey: "AA==" }),
      ).toMatchObject({ ok: false, error_code: "ambiguous_address" });
      expect(
        runDevTool("msg-verify", { address, message: "x", sig: "AA==", chain: "eth" }),
      ).toMatchObject({ ok: false, error_code: "chain_does_not_match_address" });
      // chain named: routed to Cosmos (no ambiguous_address); a bogus key is still never accepted
      const r = runDevTool("msg-verify", {
        address,
        message: "x",
        sig: "AA==",
        pubkey: "AA==",
        chain: "cosmos",
      }) as Record<string, unknown>;
      expect(r.error_code).not.toBe("ambiguous_address");
      expect(r.error_code).not.toBe("pubkey_only_for_cosmos");
      expect(r.ok === false || (r.result as Record<string, unknown>)?.status !== "ok").toBe(true);
    }
    // chain-named success: Trust Wallet Core Solana raw vector (msg_chains.rs solana_raw_twc_vector)
    const sol = "H3imdwa5VQMB5V6yBNyrWwPdSKs4k9Pcpsu4diogoAcg";
    const SOL_SIG =
      "2iBZ6zrQRKHcbD8NWmm552gU5vGvh1dk3XV4jxnyEdRKm8up8AeQk1GFr9pJokSmchw7i9gMtNyFBdDt8tBxM1cG";
    expect(
      ok("msg-verify", {
        address: sol,
        message: "Hello world",
        sig: SOL_SIG,
        format: "raw",
        chain: "sol",
      }),
    ).toMatchObject({ status: "ok", chain: "sol" });
    expect(
      ok("msg-verify", {
        address: sol,
        message: "Hello World",
        sig: SOL_SIG,
        format: "raw",
        chain: "sol",
      }).status,
    ).toBe("signer_mismatch");
    expect(
      runDevTool("msg-verify", {
        address: sol,
        message: "Hello world",
        sig: SOL_SIG,
        chain: "cosmos",
      }),
    ).toMatchObject({ ok: false, error_code: "chain_does_not_match_address" });
    // Tron (TWC TronMessageSignerTests) with chain named
    expect(
      ok("msg-verify", {
        address: "TWWb9EjUWai17YEVB7FR8hreupYJKG9sMR",
        message: "Hello World",
        sig: "bc0753c070cc55693097df11bc11e1a7c4bd5e1a40b9dc94c75568e59bcc9d6b50a7873ef25b469e494490a54de37327b4bc7fc825c81a377b555e34fb7261ba1c",
        chain: "tron",
      }).status,
    ).toBe("ok");
    expect(
      runDevTool("msg-verify", { address: sol, message: "x", sig: SOL_SIG, chain: "doge" }),
    ).toMatchObject({ ok: false, error_code: "bad_chain" });
  });

  it("bolt11-decode: BOLT11 spec vectors (recovers the payee, decodes fields, rejects junk)", () => {
    const INV =
      "lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql";
    const d = ok("bolt11-decode", { invoice: INV });
    expect(d.network).toBe("mainnet");
    expect(d.recovered_payee).toBe(
      "03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad",
    );
    expect(d.description).toBe("Please consider supporting this project");
    expect(
      ok("bolt11-decode", {
        invoice:
          "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh",
      }).amount_msat,
    ).toBe("250000000");
    expect(runDevTool("bolt11-decode", { invoice: "bc1qxyz" })).toMatchObject({
      ok: false,
      error_code: "not_a_lightning_invoice",
    });
  });
});

describe("typed-data-verify domain options (blocktools 10a1356a options_json)", () => {
  const A = "0x1111111111111111111111111111111111111111";
  const td = JSON.stringify({
    types: {
      EIP712Domain: [
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      M: [{ name: "x", type: "uint256" }],
    },
    primaryType: "M",
    domain: { chainId: 1, verifyingContract: A },
    message: { x: 1 },
  });
  const run = (o: Record<string, unknown>) => ok("typed-data-verify", { typed_data: td, ...o });
  it("unchanged without options; matching options ok", () => {
    expect(run({}).status).toBe("ok");
    expect(run({ expect_chain_id: "1", expect_verifying_contract: A }).status).toBe("ok");
    expect(run({ expect_chain_id: "", expect_verifying_contract: "" }).status).toBe("ok");
  });
  it("chain id and verifying contract mismatches", () => {
    const c = run({ expect_chain_id: "8453" });
    expect(c.status).toBe("chain_id_mismatch");
    expect(String(c.expected_chain_id)).toBe("8453");
    const v = run({ expect_verifying_contract: "0x2222222222222222222222222222222222222222" });
    expect(v.status).toBe("verifying_contract_mismatch");
    expect(v.verifying_contract).toBe(A);
    // chain id mismatch takes priority
    expect(
      run({
        expect_chain_id: "10",
        expect_verifying_contract: "0x2222222222222222222222222222222222222222",
      }).status,
    ).toBe("chain_id_mismatch");
  });
  it("bad option types are rejected", () => {
    expect(() => run({ expect_chain_id: 1 })).toThrow("expect_chain_id_must_be_string");
    expect(() => run({ expect_chain_id: "x" })).toThrow("bad_expect_chain_id");
    expect(() => run({ expect_verifying_contract: true })).toThrow(
      "expect_verifying_contract_must_be_string",
    );
    expect(() => run({ expect_verifying_contract: "0x12" })).toThrow(
      "bad_expect_verifying_contract",
    );
  });
});
