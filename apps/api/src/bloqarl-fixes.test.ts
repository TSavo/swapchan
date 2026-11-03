import { DatabaseSync } from "node:sqlite";
import { encodePacked, keccak256 } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isVaultCandidate, linkRoutes } from "./intel.js";
import { merkleLeaf, verifyMerkleRow } from "./merkleClaims.js";
import { batchIpLimiter } from "./moneybatch.js";
import { recoverUrl, sweepUrl } from "./recover.js";
import { recoverSigPayload, recoverUrlSigned, signRecover, signRecoverForm } from "./recoverSig.js";

const ME = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const VAULT = "0x3333333333333333333333333333333333333333";

describe("1. archaeology vault classification", () => {
  it("a token the wallet only received is not a vault", () => {
    expect(isVaultCandidate(VAULT, new Set(), new Set())).toBe(false);
  });
  it("a contract the wallet called, or a registry vault, is", () => {
    expect(isVaultCandidate(VAULT, new Set([VAULT]), new Set())).toBe(true);
    expect(
      isVaultCandidate(VAULT.toUpperCase().replace("0X", "0x"), new Set(), new Set([VAULT])),
    ).toBe(true);
  });
});

describe("2/3. signed /recover links with owner", () => {
  afterEach(() => vi.unstubAllEnvs());
  const tx = { chainId: 1, to: VAULT, data: "0x3ccfd60b", value: "0", description: "withdraw()" };
  it("payload covers chain/to/data/title/owner; matches the web verifier's vector", () => {
    expect(
      signRecover(
        { chain: 1, to: VAULT, data: "0x3ccfd60b", title: "P3D", owner: ME },
        "test-secret",
      ),
    ).toBe("8c9f05fddc89435b1e9de6ee5de6d44e87910d6c0a68edcb4deba80f85bc1901");
    expect(recoverSigPayload({ chain: 1, to: VAULT, data: "0x", title: "t", owner: ME })).toContain(
      ME,
    );
  });
  it("recoverUrl carries owner and a sig that verifies; tampering any field fails", () => {
    vi.stubEnv("SWAPCHAN_RECOVER_LINK_SECRET", "test-secret");
    const u = new URL(recoverUrl(tx, "P3D", ME));
    expect(u.searchParams.get("owner")).toBe(ME);
    expect(recoverUrlSigned(u)).toBe(true);
    for (const [k, v] of [
      ["to", OTHER],
      ["data", "0xdeadbeef"],
      ["title", "I found your money"],
      ["owner", OTHER],
      ["chain", "56"],
    ]) {
      const t = new URL(u);
      t.searchParams.set(k!, v!);
      expect(recoverUrlSigned(t)).toBe(false);
    }
    const n = new URL(u);
    n.searchParams.delete("sig");
    expect(recoverUrlSigned(n)).toBe(false);
  });
  it("no secret: no sig is emitted and nothing verifies (fail closed)", () => {
    vi.stubEnv("SWAPCHAN_RECOVER_LINK_SECRET", "");
    const u = new URL(recoverUrl(tx, "P3D", ME));
    expect(u.searchParams.has("sig")).toBe(false);
    expect(recoverUrlSigned(u)).toBe(false);
  });
  it("POST /links refuses an unsigned /recover?to= URL and shortens a signed one", async () => {
    vi.stubEnv("SWAPCHAN_RECOVER_LINK_SECRET", "test-secret");
    const app = linkRoutes(
      fetch,
      { VITEST: "1" } as NodeJS.ProcessEnv,
      new DatabaseSync(":memory:"),
    );
    const post = (url: string) =>
      app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
    const forged = `https://swapchan.com/recover?chain=1&to=${OTHER}&data=0x3ccfd60b&title=x&owner=${ME}`;
    expect((await post(forged)).status).toBe(400);
    const r = await post(recoverUrl(tx, "P3D", ME));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { shortUrl: string }).shortUrl).toMatch(/\/s\//);
  });
});

describe("2/3b. signed /recover?tron=, ?sol= and ?sweep= links", () => {
  afterEach(() => vi.unstubAllEnvs());
  const DOGE = "DAddr1111111111111111111111111";
  const sw = { kind: "utxo", coin: "doge", from: DOGE, sym: "DOGE" } as const;
  it("sweep payload matches the web verifier's vector", () => {
    expect(
      signRecoverForm(
        "sweep",
        { sweep: "utxo", coin: "doge", from: DOGE, sym: "DOGE", title: "Sweep DOGE" },
        "test-secret",
      ),
    ).toBe("dcaeaec08c9a710155fab3e36f27bd08987a6d521d7a7fe0c89fc52edcf747c4");
  });
  it("sweepUrl carries a sig that verifies; tampering any signed field fails", () => {
    vi.stubEnv("SWAPCHAN_RECOVER_LINK_SECRET", "test-secret");
    const u = new URL(sweepUrl(sw as never, "Sweep DOGE"));
    expect(recoverUrlSigned(u)).toBe(true);
    for (const [k, v] of [
      ["sweep", "fork"],
      ["coin", "ltc"],
      ["from", "DOther111111111111111111111111"],
      ["sym", "LTC"],
      ["token", OTHER],
      ["title", "I found your money"],
    ]) {
      const t = new URL(u);
      t.searchParams.set(k!, v!);
      expect(recoverUrlSigned(t)).toBe(false);
    }
  });
  it("tron and sol forms: signed verifies, tampered spec or missing sig fails", () => {
    vi.stubEnv("SWAPCHAN_RECOVER_LINK_SECRET", "test-secret");
    for (const f of ["tron", "sol"] as const) {
      const q = { [f]: "eyJhIjoxfQ", title: "x" };
      const u = new URL(
        `https://swapchan.com/recover?${new URLSearchParams({ ...q, sig: signRecoverForm(f, q)! })}`,
      );
      expect(recoverUrlSigned(u)).toBe(true);
      const t = new URL(u);
      t.searchParams.set(f, "eyJhIjoyfQ");
      expect(recoverUrlSigned(t)).toBe(false);
      t.searchParams.delete("sig");
      expect(recoverUrlSigned(t)).toBe(false);
    }
  });
  it("no secret: no sig is emitted and nothing verifies (fail closed)", () => {
    vi.stubEnv("SWAPCHAN_RECOVER_LINK_SECRET", "");
    const u = new URL(sweepUrl(sw as never, "Sweep DOGE"));
    expect(u.searchParams.has("sig")).toBe(false);
    expect(recoverUrlSigned(u)).toBe(false);
  });
  it("POST /links refuses unsigned ?sweep=/?tron=/?sol= URLs and shortens a signed one", async () => {
    vi.stubEnv("SWAPCHAN_RECOVER_LINK_SECRET", "test-secret");
    const app = linkRoutes(
      fetch,
      { VITEST: "1" } as NodeJS.ProcessEnv,
      new DatabaseSync(":memory:"),
    );
    const post = (url: string) =>
      app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
    for (const forged of [
      `https://swapchan.com/recover?sweep=utxo&coin=doge&from=${DOGE}&sym=DOGE&title=x`,
      "https://swapchan.com/recover?tron=eyJhIjoxfQ&title=x",
      "https://swapchan.com/recover?sol=eyJhIjoxfQ&title=x",
    ])
      expect((await post(forged)).status).toBe(400);
    const r = await post(sweepUrl(sw as never, "Sweep DOGE"));
    expect(r.status).toBe(200);
  });
});

describe("4. per-client batch cap", () => {
  it("charges addresses per client per window and refuses over the cap", () => {
    let t = 0;
    const lim = batchIpLimiter(500, 3600_000, () => t);
    expect(lim("1.2.3.4", 500).ok).toBe(true);
    const no = lim("1.2.3.4", 1);
    expect(no.ok).toBe(false);
    expect(!no.ok && no.retryAfter).toBe(3600);
    expect(lim("5.6.7.8", 500).ok).toBe(true);
    t = 3600_000;
    expect(lim("1.2.3.4", 500).ok).toBe(true);
  });
  it("a refused batch charges nothing", () => {
    const lim = batchIpLimiter(10, 3600_000, () => 0);
    expect(lim("a", 8).ok).toBe(true);
    expect(lim("a", 5).ok).toBe(false);
    expect(lim("a", 2).ok).toBe(true);
  });
});

describe("5. merkle row verified against the root", () => {
  const h = (a: `0x${string}`, b: `0x${string}`) =>
    keccak256(encodePacked(["bytes32", "bytes32"], BigInt(a) <= BigInt(b) ? [a, b] : [b, a]));
  const rows = [
    {
      owner: ME as `0x${string}`,
      row: { index: 0, amount: "400000000000000000000", proof: [] as string[] },
    },
    { owner: OTHER as `0x${string}`, row: { index: 1, amount: "1000", proof: [] as string[] } },
    { owner: VAULT as `0x${string}`, row: { index: 2, amount: "7", proof: [] as string[] } },
  ];
  const [l0, l1, l2] = rows.map((r) => merkleLeaf(r.owner, r.row)) as [
    `0x${string}`,
    `0x${string}`,
    `0x${string}`,
  ];
  const n01 = h(l0, l1);
  const root = h(n01, l2);
  rows[0]!.row.proof = [l1, l2];
  rows[1]!.row.proof = [l0, l2];
  rows[2]!.row.proof = [n01];
  it("accepts rows that prove to the root", () => {
    for (const r of rows) expect(verifyMerkleRow(r.owner, r.row, root)).toBe(true);
  });
  it("rejects an inflated amount, another account, a wrong root or a junk proof", () => {
    const r = rows[0]!;
    expect(verifyMerkleRow(r.owner, { ...r.row, amount: "400000000000000000001" }, root)).toBe(
      false,
    );
    expect(verifyMerkleRow(OTHER, r.row, root)).toBe(false);
    expect(verifyMerkleRow(r.owner, r.row, l0)).toBe(false);
    expect(verifyMerkleRow(r.owner, { ...r.row, proof: ["0x12"] }, root)).toBe(false);
  });
});
