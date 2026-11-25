import { describe, expect, it } from "vitest";
import {
  b58decode,
  b58encode,
  chainOf,
  explainTx,
  findPda,
  gas,
  onCurve,
  openWatchDb,
  resolveName,
  revokeTx,
  snsKey,
  tronAddr,
  walletBalances,
  yields,
} from "./onchain.js";

describe("onchain helpers (offline)", () => {
  it("base58 round-trips", () => {
    const k = "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY";
    expect(b58encode(b58decode(k))).toBe(k);
    expect(b58encode(Uint8Array.of(0, 0, 1))).toBe("112");
  });
  it("ed25519 on-curve check", () =>
    expect(onCurve(b58decode("86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY"))).toBe(true));
  it("derives the USDC ATA like the SPL program", () =>
    expect(
      findPda(
        [
          "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY",
          "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        ].map(b58decode),
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      ),
    ).toBe("9SHQTA66Ekh7ZgMnKWsjxXk6DwXku8przs45E8bcEe38"));
  it("derives SNS name accounts", () =>
    expect(snsKey("bonfida")).toBe("Crf8hzfthWGbGbLTVCiqRqV5MVnbpHB1L9KQMd6gsinb"));
  it("tron hex -> base58check", () =>
    expect(tronAddr("41a614f803b6fd780986a42c78ec9c7f77e6ded13c")).toBe(
      "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    ));
  it("builds approve(spender, 0)", () => {
    const t = revokeTx(
      1,
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    );
    expect(t.data).toBe(
      "0x095ea7b3000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba30000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(() => revokeTx(792703809, "x", "y")).toThrow();
    expect(revokeTx("84532", t.to, "0x000000000022D473030F116dDEE9F6B43aC78BA3")).toMatchObject({
      chainId: 84532,
      data: t.data,
      verified: true,
    });
  });
  it("parses chain names", () => {
    expect(chainOf("base")).toBe(8453);
    expect(chainOf("792703809")).toBe(792703809);
    expect(() => chainOf("doge")).toThrow();
  });
  it("opens the watch store", () =>
    expect(openWatchDb(":memory:").prepare("SELECT COUNT(*) n FROM watches").get()).toEqual({
      n: 0,
    }));
});

// Live smoke tests against free public sources: SWAPCHAN_LIVE=1 pnpm -C apps/api test onchain
describe.skipIf(!process.env.SWAPCHAN_LIVE)("onchain live", () => {
  const env = process.env;
  it("resolves vitalik.eth and toly.sol", async () => {
    expect((await resolveName(fetch, env, "vitalik.eth")).address).toBe(
      "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    );
    expect((await resolveName(fetch, env, "toly.sol")).address).toBe(
      "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY",
    );
  }, 30_000);
  it(
    "reads vitalik's balances",
    async () =>
      expect(
        (await walletBalances(fetch, env, "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", [1]))
          .totalUsd,
      ).toBeGreaterThan(0),
    30_000,
  );
  it(
    "explains the pizza-era BTC tx",
    async () =>
      expect(
        (
          await explainTx(
            fetch,
            env,
            8253038,
            "f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16",
          )
        ).summary,
      ).toContain("block 170"),
    30_000,
  );
  it("gets gas + yields", async () => {
    expect((await gas(fetch, env, [1, 8453])).cheapest).toBeTruthy();
    expect((await yields(fetch, { asset: "USDC" })).count).toBeGreaterThan(0);
  }, 60_000);
});
