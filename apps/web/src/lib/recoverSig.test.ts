import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { recoverSigPayload, verifyRecoverFormSig, verifyRecoverSig } from "./recoverSig";

const ME = "0x1111111111111111111111111111111111111111";
const TO = "0x3333333333333333333333333333333333333333";
const base = { chain: "1", to: TO, data: "0x3ccfd60b", title: "P3D", owner: ME };
// same vector as apps/api/src/bloqarl-fixes.test.ts (API signer)
const SIG = "8c9f05fddc89435b1e9de6ee5de6d44e87910d6c0a68edcb4deba80f85bc1901";

describe("/recover link HMAC (fail closed)", () => {
  it("verifies the API's signature", () => {
    expect(createHmac("sha256", "test-secret").update(recoverSigPayload(base)).digest("hex")).toBe(
      SIG,
    );
    expect(verifyRecoverSig({ ...base, sig: SIG }, "test-secret")).toBe(true);
  });
  it("rejects a tampered chain/to/data/title/owner", () => {
    for (const k of ["chain", "to", "data", "title", "owner"] as const)
      expect(verifyRecoverSig({ ...base, [k]: `${base[k]}0`, sig: SIG }, "test-secret")).toBe(
        false,
      );
  });
  it("rejects missing sig, missing owner, malformed sig, wrong or unset secret", () => {
    expect(verifyRecoverSig({ ...base }, "test-secret")).toBe(false);
    expect(verifyRecoverSig({ ...base, owner: undefined, sig: SIG }, "test-secret")).toBe(false);
    expect(verifyRecoverSig({ ...base, sig: "zz" }, "test-secret")).toBe(false);
    expect(verifyRecoverSig({ ...base, sig: SIG }, "other")).toBe(false);
    expect(verifyRecoverSig({ ...base, sig: SIG }, undefined)).toBe(false);
  });
});

describe("/recover?tron=, ?sol=, ?sweep= link HMAC (fail closed)", () => {
  const sw = {
    sweep: "utxo",
    coin: "doge",
    from: "DAddr1111111111111111111111111",
    sym: "DOGE",
    title: "Sweep DOGE",
  };
  // same vector as apps/api/src/bloqarl-fixes.test.ts (API signer)
  const SW_SIG = "dcaeaec08c9a710155fab3e36f27bd08987a6d521d7a7fe0c89fc52edcf747c4";
  it("verifies the API's sweep signature", () => {
    expect(verifyRecoverFormSig("sweep", { ...sw, sig: SW_SIG }, "test-secret")).toBe(true);
  });
  it("rejects a tampered sweep/coin/from/sym/token/title", () => {
    for (const k of ["sweep", "coin", "from", "sym", "title"] as const)
      expect(
        verifyRecoverFormSig("sweep", { ...sw, [k]: `${sw[k]}0`, sig: SW_SIG }, "test-secret"),
      ).toBe(false);
    expect(verifyRecoverFormSig("sweep", { ...sw, token: TO, sig: SW_SIG }, "test-secret")).toBe(
      false,
    );
  });
  it("tron and sol: missing sig, malformed sig, wrong or unset secret all fail", () => {
    for (const f of ["tron", "sol"] as const) {
      const q = { [f]: "eyJhIjoxfQ", title: "x" };
      expect(verifyRecoverFormSig(f, q, "test-secret")).toBe(false);
      expect(verifyRecoverFormSig(f, { ...q, sig: "zz" }, "test-secret")).toBe(false);
      expect(verifyRecoverFormSig(f, { ...q, sig: SW_SIG }, "test-secret")).toBe(false);
      expect(verifyRecoverFormSig(f, { ...q, sig: SW_SIG }, undefined)).toBe(false);
    }
  });
});
