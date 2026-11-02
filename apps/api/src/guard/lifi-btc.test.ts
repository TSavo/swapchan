import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { GuardCtx } from "./ctx.js";
import { btcReceiverWord, type Payload, verifyPayload } from "./index.js";

// Real LI.FI ETH->BTC transactionRequests captured from li.quest 2026-10-23.
const FX = JSON.parse(
  readFileSync(new URL("./fixtures/lifi-eth-btc.json", import.meta.url), "utf8"),
) as Record<
  string,
  {
    to: string;
    data: string;
    value: string;
    fromAmount: string;
    toAmount: string;
    taker: string;
    recipient: string;
  }
>;
const OTHER_BTC = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const OTHER_EVM = "000000000000000000000000000000000000000000000000000000000000dead".slice(24);
const ctx: GuardCtx = {
  thorInbound: async () => [],
  relay: async () => ({ contracts: [], solvers: [] }),
  zeroxSettlers: async () => [],
};
const payload = (tool: string, data?: string, recipient?: string): Payload => {
  const f = FX[tool]!;
  return {
    provider: "lifi",
    req: {
      fromChainId: 1,
      toChainId: 8253038,
      fromToken: "0x0000000000000000000000000000000000000000",
      toToken: "bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8",
      amount: f.fromAmount,
      taker: f.taker,
      recipient: recipient ?? f.recipient,
      slippageBps: 50,
    } as Payload["req"],
    toAmount: f.toAmount,
    tx: {
      chainId: 1,
      to: f.to as `0x${string}`,
      data: (data ?? f.data) as `0x${string}`,
      value: f.value,
    },
  };
};
const check = async (p: Payload, name: string) =>
  (await verifyPayload(p, ctx)).checks.find((c) => c.name === name);

describe("LI.FI ETH->BTC receiver decode", () => {
  for (const tool of ["layerswap", "near"]) {
    it(`${tool}: honest payload, recipient decoded == user`, async () => {
      const v = await verifyPayload(payload(tool), ctx);
      expect(v.verified).toBe(true);
      const r = v.checks.find((c) => c.name === "recipient")!;
      expect(r.ok).toBe(true);
      expect(r.detail ?? "").not.toMatch(/not verifiable/);
    });
    it(`${tool}: tampered receiver word fails`, async () => {
      const f = FX[tool]!;
      const good = btcReceiverWord(f.recipient)!;
      const bad = btcReceiverWord(OTHER_BTC)!;
      expect(f.data.toLowerCase()).toContain(good);
      const v = await verifyPayload(payload(tool, f.data.toLowerCase().replace(good, bad)), ctx);
      expect(v.verified).toBe(false);
      expect(
        (await check(payload(tool, f.data.toLowerCase().replace(good, bad)), "recipient"))?.ok,
      ).toBe(false);
    });
    it(`${tool}: honest calldata but different requested recipient fails`, async () => {
      expect((await verifyPayload(payload(tool, undefined, OTHER_BTC), ctx)).verified).toBe(false);
    });
    it(`${tool}: tampered refund address fails`, async () => {
      const f = FX[tool]!;
      const t = f.taker.toLowerCase().slice(2);
      // Replace only the refund slot (last occurrence of the taker word).
      const d = f.data.toLowerCase();
      const i = d.lastIndexOf(`000000000000000000000000${t}`);
      const tampered = d.slice(0, i) + `000000000000000000000000${OTHER_EVM}` + d.slice(i + 64);
      expect((await check(payload(tool, tampered), "refund"))?.ok).toBe(false);
    });
  }
  for (const tool of ["layerswap", "near", "relaydepository"]) {
    it(`${tool}: unrecognized bridge name fails closed`, async () => {
      const f = FX[tool]!;
      const name = Buffer.from(tool).toString("hex");
      const d = f.data.toLowerCase();
      expect(d).toContain(name);
      // Flip the last char of BridgeData.bridge so the facet is no longer recognized.
      const last = (Number.parseInt(name.slice(-2), 16) ^ 1).toString(16);
      const p = payload(tool, d.replace(name, `${name.slice(0, -2)}${last}`));
      const v = await verifyPayload(p, ctx);
      expect(v.verified).toBe(false);
      expect((await check(p, "refund"))?.ok).toBe(false);
      expect((await check(p, "recipient"))?.ok).toBe(false);
    });
  }
  it("relaydepository: depositor must be taker, recipient partial (off-chain order)", async () => {
    const v = await verifyPayload(payload("relaydepository"), ctx);
    expect(v.verified).toBe(true);
    expect(v.level).toBe("partial");
    const f = FX.relaydepository!;
    const t = f.taker.toLowerCase().slice(2);
    const tampered = f.data
      .toLowerCase()
      .replace(`000000000000000000000000${t}`, `000000000000000000000000${OTHER_EVM}`);
    expect((await verifyPayload(payload("relaydepository", tampered), ctx)).verified).toBe(false);
  });
});
