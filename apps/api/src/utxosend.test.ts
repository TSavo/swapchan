import { DOGECOIN, LITECOIN, NON_EVM, type QuoteRequest } from "@swapchan/shared";
import { describe, expect, it } from "vitest";
import { btBuildPsbt, btVerifyThorSend } from "./blocktools.js";
import type { GuardCtx } from "./guard/ctx.js";
import { expectedThorMemo, type Payload, THOR_SEND_REASON, verifyPayload } from "./guard/index.js";
import { createApp } from "./index.js";
import type { Pricer } from "./pricing.js";
import { thorchain } from "./providers/thorchain.js";
import { buildUtxoSend, MEMO_LIMIT } from "./utxosend.js";

// LTC -> DOGE / ETH through THORChain, real vendored blocktools WASM, mocked network (no live calls, no funds).
const TAKER = "ltc1qe2tczyk2rw7u47kzxxee5g7ufkncdmlc9854ex";
const VAULT = "ltc1q8c37s9sq89v55vuffajkfcd3xj9m67sq3r2zcjktw0h2a4vuqzws4u8fax";
const OTHER = "ltc1qzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3nmndwj"; // valid P2WPKH, not the taker's
const DOGE_TO = "D8XhvXbJYovhJN7X51qkrYACDX29vBamQF";
const ETH_TO = "0xeb0ec7a28e4b6b175806e21d9d3afe45792c5c7b";
const AMOUNT = 10_000_000n;
const MEMO = `=:d:${DOGE_TO}:123/1/0`;
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");
const utxo = (address = TAKER, amount = "50000000", txid = "aa".repeat(32)) => ({
  txid,
  vout: 0,
  amount,
  address,
});
const build = (
  o: { memo?: string; to?: string; change?: string; from?: string; rate?: number } = {},
) =>
  btBuildPsbt(
    "ltc",
    [utxo(o.from)],
    o.to ?? VAULT,
    AMOUNT,
    o.change ?? TAKER,
    o.rate ?? 2,
    hex(o.memo ?? MEMO),
  ).psbt;
const ctx = (halted = false): GuardCtx => ({
  thorInbound: async () => [{ chain: "LTC", address: VAULT, router: "", halted }] as never,
  relay: async () => ({ contracts: [], solvers: [] }),
  zeroxSettlers: async () => [],
});
const payload = (psbt: string, memo = MEMO, toChainId = DOGECOIN, recipient = DOGE_TO) =>
  ({
    provider: "thorchain",
    req: {
      fromChainId: LITECOIN,
      fromToken: NON_EVM[LITECOIN]!.native,
      toChainId,
      toToken:
        toChainId === 1 ? "0x0000000000000000000000000000000000000000" : NON_EVM[toChainId]!.native,
      amount: AMOUNT.toString(),
      slippageBps: 100,
      taker: TAKER,
      recipient,
    },
    toAmount: "1",
    nonEvmTx: { vm: "uvm", kind: "uvm-psbt", data: { psbt, summary: { memo } } },
  }) as unknown as Payload;
const failed = async (p: Payload, c = ctx()) =>
  (await verifyPayload(p, c)).checks.filter((x) => !x.ok).map((x) => x.name);

describe("guard: LTC/DOGE/BCH send (PSBT) through THORChain", () => {
  it("passes a correct send", async () => {
    expect(await failed(payload(build()))).toEqual([]);
  });
  it("expected memo is SwapChan's own: validated recipient and an accepted asset", () => {
    expect(expectedThorMemo(MEMO, DOGECOIN, DOGE_TO, TAKER)).toBe(MEMO);
    expect(expectedThorMemo(`=:d:${DOGE_TO}/${TAKER}:1`, DOGECOIN, DOGE_TO, TAKER)).toBe(
      `=:d:${DOGE_TO}/${TAKER}:1`,
    );
    expect(expectedThorMemo(`=:BCH.BCH:${DOGE_TO}:1`, DOGECOIN, DOGE_TO, TAKER)).toBe(
      `=:DOGE.DOGE:${DOGE_TO}:1`,
    );
    expect(expectedThorMemo(`=:d:${OTHER}:1`, DOGECOIN, DOGE_TO, TAKER)).toBe(`=:d:${DOGE_TO}:1`);
    expect(expectedThorMemo(MEMO, DOGECOIN, "nonsense", TAKER)).toBeNull();
  });
  it("refuses a wrong vault", async () => {
    expect(await failed(payload(build({ to: OTHER })))).toContain("router");
  });
  it("refuses a halted chain", async () => {
    expect(await failed(payload(build()), ctx(true))).toContain("router");
  });
  it("refuses a memo mismatch, including a case change only", async () => {
    const lower = MEMO.replace(DOGE_TO, DOGE_TO.toLowerCase());
    const f = await failed(payload(build({ memo: lower })));
    expect(f).toContain("memo");
    expect(f).toContain("recipient");
    expect(await failed(payload(build({ memo: `${MEMO}0` })))).toContain("memo");
  });
  it("#17: a memo paying another address fails as recipient (both layers)", async () => {
    const m = `=:d:${OTHER}:123/1/0`;
    // even when the payload's own memo agrees with the PSBT, SwapChan's expected memo does not
    const f = await failed(payload(build({ memo: m }), m));
    expect(f).toContain("recipient");
    expect(f).toContain("memo");
  });
  it("#18: a memo naming another asset fails as outToken (both layers)", async () => {
    const m = `=:BCH.BCH:${DOGE_TO}:123/1/0`;
    const f = await failed(payload(build({ memo: m }), m));
    expect(f).toContain("outToken");
    expect(f).toContain("memo");
  });
  it("refuses a foreign input", async () => {
    expect(await failed(payload(build({ from: OTHER })))).toContain("input");
  });
  it("refuses an input without UTXO info", async () => {
    const raw = Buffer.from(build(), "base64").toString("hex");
    const i = raw.indexOf("01011f");
    expect(i).toBeGreaterThan(0);
    const stripped = raw.slice(0, i) + raw.slice(i + 6 + 0x1f * 2);
    expect(await failed(payload(Buffer.from(stripped, "hex").toString("base64")))).toContain(
      "input",
    );
  });
  it("refuses a wrong output count", async () => {
    const raw = Buffer.from(build(), "base64");
    const h = raw.toString("hex");
    // unsigned tx: 4 extra outputs-count byte and a duplicated change output, plus one more empty output map
    const change = h.slice(h.indexOf("2200203e") + 70, h.indexOf("2200203e") + 70 + 62);
    expect(change.endsWith("ca978112ca1bbdcafac231b39a23dc4da786eff8")).toBe(true);
    const at = h.indexOf("ffffffff03") + 8;
    let tx = `${h.slice(10 + 6, at)}04${h.slice(at + 2, at + 2 + 86)}${change}${h.slice(at + 2 + 86)}`;
    const end = tx.indexOf("00000000" + "0001011f"); // locktime then global separator + input map
    tx = tx.slice(0, end + 8);
    const rest = h.slice(16 + (tx.length - 62));
    const len = (tx.length / 2).toString(16);
    const psbt = `70736274ff0100${len}${tx}${rest}00`;
    expect(await failed(payload(Buffer.from(psbt, "hex").toString("base64")))).toContain("outputs");
  });
  it("refuses RBF signalling", async () => {
    const raw = Buffer.from(build(), "base64");
    raw.writeUInt32LE(0xfffffffd, raw.indexOf(Buffer.from("ffffffff", "hex"), 20));
    expect(await failed(payload(raw.toString("base64")))).toContain("rbf");
  });
  it("refuses wrong change", async () => {
    expect(await failed(payload(build({ change: OTHER })))).toContain("change");
  });
  it("refuses a fee over the cap (blocktools cap)", () => {
    const p = build({ rate: 50 });
    const r = btVerifyThorSend("ltc", p, VAULT, MEMO, AMOUNT, TAKER, [TAKER], 1000n);
    expect(r.failures).toContain("fee");
    expect(THOR_SEND_REASON.fee).toBe("fee");
  });
  it("maps every blocktools failure onto a SwapChan reason", () => {
    expect(THOR_SEND_REASON).toMatchObject({
      vault: "router",
      vault_invalid: "router",
      amount: "value",
      memo: "memo",
      change: "change",
      change_invalid: "change",
      output_count: "outputs",
      rbf: "rbf",
      fee: "fee",
      input_unknown: "input",
      input_foreign: "input",
      taker_invalid: "taker",
      tx: "decode",
      chain: "chain",
    });
  });
  it("refuses a non-THORChain provider and a missing PSBT", async () => {
    const p = payload(build());
    expect((await failed({ ...p, provider: "relay" } as Payload)).length).toBeGreaterThan(0);
    expect(
      await failed({ ...p, nonEvmTx: { vm: "uvm", kind: "uvm-psbt", data: {} } } as Payload),
    ).toContain("decode");
  });
  it("pays an EVM recipient too", async () => {
    const m = `=:ETH.ETH:${ETH_TO}:123/1/0`;
    expect(await failed(payload(build({ memo: m }), m, 1, ETH_TO))).toEqual([]);
  });
});

// Mocked network: blockbook (UTXOs) and thornode (quote, inbound_addresses, tx/status).
const env = { SWAPCHAN_FEE_BPS: "10" } as NodeJS.ProcessEnv;
const pricer: Pricer = {
  token: async (c) => ({ priceUsd: 100, decimals: c === 1 ? 18 : 8 }),
  usd: async () => 1,
};
const net = (
  o: {
    utxos?: unknown[];
    status?: unknown;
    statusCode?: number;
    dust?: string;
    halted?: boolean;
  } = {},
) => {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    if (url.includes("/api/v2/utxo/"))
      return Response.json(
        o.utxos ?? [{ txid: "bb".repeat(32), vout: 1, value: "50000000", confirmations: 3 }],
      );
    if (url.endsWith("/pools")) return Response.json([]);
    if (url.includes("/thorname/")) return Response.json({ error: "none" }, { status: 400 });
    if (url.endsWith("/inbound_addresses"))
      return Response.json([
        { chain: "LTC", address: VAULT, halted: !!o.halted, dust_threshold: o.dust ?? "10000" },
      ]);
    if (url.includes("/tx/status/"))
      return o.statusCode
        ? new Response("not found", { status: o.statusCode })
        : Response.json(o.status);
    if (url.includes("/quote/swap")) {
      const u = new URL(url);
      const dest = u.searchParams.get("destination");
      const refund = u.searchParams.get("refund_address");
      return Response.json({
        inbound_address: VAULT,
        // short form THORChain emits when a refund is named (an 80-byte OP_RETURN leaves no room for streaming)
        memo: refund ? `=:d:${dest}/${refund}:1` : `=:d:${dest}:123/1/0`,
        expected_amount_out: "1000000000",
        expiry: 2_000_000_000,
        recommended_gas_rate: "2",
        dust_threshold: "10000",
        fees: { asset: "DOGE.DOGE", affiliate: "0", outbound: "0", liquidity: "0", total: "0" },
      });
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
  return { f, urls };
};
const LTC_P2PKH = "LMUQpY3qDP8JE2Wwa4BukGXK5cULwo7mqx";
const req = {
  fromChainId: LITECOIN,
  fromToken: NON_EVM[LITECOIN]!.native,
  toChainId: DOGECOIN,
  toToken: NON_EVM[DOGECOIN]!.native,
  amount: AMOUNT.toString(),
  slippageBps: 100,
  recipient: DOGE_TO,
} as QuoteRequest;

describe("buildUtxoSend (mocked blockbook)", () => {
  it("builds, self-verifies and summarises a segwit send", async () => {
    const m = net();
    const r = await buildUtxoSend(m.f, env, {
      chainId: LITECOIN,
      taker: TAKER,
      vault: VAULT,
      amount: AMOUNT,
      memo: MEMO,
      feeRate: 2,
    });
    expect(r.summary).toMatchObject({ chain: "LTC", amountDisplay: "0.1", memo: MEMO, inputs: 1 });
    expect(r.summary.text).toMatch(/Not replaceable/);
    expect(btVerifyThorSend("ltc", r.psbt, VAULT, MEMO, AMOUNT, TAKER, [TAKER], null).ok).toBe(
      true,
    );
    expect(await failed(payload(r.psbt))).toEqual([]);
    expect(m.urls.some((u) => u.includes(`/api/v2/utxo/${TAKER}`))).toBe(true);
  });
  it("refuses an over-long memo, too little coin, no coins, and P2SH senders", async () => {
    const o = {
      chainId: LITECOIN,
      taker: TAKER,
      vault: VAULT,
      amount: AMOUNT,
      memo: MEMO,
      feeRate: 2,
    };
    await expect(
      buildUtxoSend(net().f, env, { ...o, memo: "x".repeat(MEMO_LIMIT.ltc! + 1) }),
    ).rejects.toThrow(/80-byte/);
    await expect(buildUtxoSend(net().f, env, { ...o, amount: 60_000_000n })).rejects.toThrow(
      /not enough LTC/,
    );
    await expect(buildUtxoSend(net({ utxos: [] }).f, env, o)).rejects.toThrow(/no LTC found/);
    await expect(
      buildUtxoSend(net().f, env, { ...o, taker: "MDgnddLwm4A3Uh6M1zpAx7e1W6ktE4bnE4" }),
    ).rejects.toThrow(/deposit-address option/);
  });
  it("legacy inputs need their previous transaction: none fetched, nothing built", async () => {
    await expect(
      buildUtxoSend(net().f, env, {
        chainId: LITECOIN,
        taker: "LMUQpY3qDP8JE2Wwa4BukGXK5cULwo7mqx",
        vault: VAULT,
        amount: AMOUNT,
        memo: MEMO,
        feeRate: 2,
      }),
    ).rejects.toThrow(/previous transactions|raw-transaction source/);
  });
});

describe("THORChain deposit address and tracking (mocked thornode)", () => {
  it("returns vault, exact amount, memo with the refund, minimum, expiry and warnings", async () => {
    const d = await thorchain(pricer, env, net().f).deposit(
      req,
      LTC_P2PKH,
      AbortSignal.timeout(2000),
    );
    expect(d).toMatchObject({
      chain: "LTC",
      vault: VAULT,
      amount: "10000000",
      amountDisplay: "0.1",
      memo: `=:d:${DOGE_TO}/${LTC_P2PKH}:1`,
      memoBytes: 75,
      memoLimit: 80,
      minimum: "10000",
      expiresAt: 2_000_000_000,
      refund: LTC_P2PKH,
    });
    expect(d.warnings.join(" ")).toMatch(/exchange/);
  });
  it("refuses a bad refund address, a halted chain and an amount at the minimum", async () => {
    const t = (o = {}) => thorchain(pricer, env, net(o).f);
    const s = () => AbortSignal.timeout(2000);
    await expect(t().deposit(req, DOGE_TO, s())).rejects.toThrow(/refund address/);
    // no refund address: allowed, and the response says refunds go to the sender
    await expect(t().deposit(req, "", s())).resolves.toMatchObject({
      refundInMemo: false,
      refundTo: "sender",
    });
    await expect(t({ halted: true }).deposit(req, LTC_P2PKH, s())).rejects.toThrow(/paused/);
    await expect(t({ dust: "10000000" }).deposit(req, LTC_P2PKH, s())).rejects.toThrow(/minimum/);
    // a bech32 refund makes THORChain's memo 84 bytes: over LTC's 80, refused (never truncated)
    await expect(t().deposit(req, TAKER, s())).rejects.toThrow(/80-byte OP_RETURN limit/);
  });
  it("tracks waiting, seen, swapping, paid out, refunded and failed", async () => {
    const tr = (o: Parameters<typeof net>[0]) =>
      thorchain(pricer, env, net(o).f).track("ab".repeat(32), AbortSignal.timeout(2000));
    expect((await tr({ statusCode: 404 })).state).toBe("waiting");
    expect(
      (
        await tr({
          status: { tx: {}, stages: { inbound_observed: { started: true, completed: false } } },
        })
      ).state,
    ).toBe("seen");
    expect(
      (await tr({ status: { tx: {}, stages: { inbound_observed: { completed: true } } } })).state,
    ).toBe("swapping");
    const paid = await tr({
      status: { tx: {}, out_txs: [{ chain: "DOGE", id: "CD".repeat(32), memo: "OUT:X" }] },
    });
    expect(paid.state).toBe("paid_out");
    expect(paid.payout?.txid).toBe("CD".repeat(32));
    expect(paid.thorchainUrl).toBe(`https://thorchain.net/tx/${"AB".repeat(32)}`);
    expect(
      (
        await tr({
          status: { tx: {}, out_txs: [{ chain: "LTC", id: "EF".repeat(32), memo: "REFUND:X" }] },
        })
      ).state,
    ).toBe("refunded");
    expect((await tr({ status: { tx: {}, error: "boom" } })).state).toBe("failed");
  });
  it("reports the refund hash without claiming a destination payment on /status", async () => {
    const refundTxHash = "EF".repeat(32);
    const status = { tx: {}, out_txs: [{ chain: "LTC", id: refundTxHash, memo: "REFUND:X" }] };
    const app = createApp([thorchain(pricer, env, net({ status }).f)], {
      pricer: null,
      guard: ctx(),
      simulator: null,
    });
    const response = await app.request(
      `/status?provider=thorchain&txHash=${"ab".repeat(32)}&fromChainId=${req.fromChainId}&toChainId=${req.toChainId}`,
    );
    expect(await response.json()).toMatchObject({
      status: "failed",
      receivingTxHash: null,
      refundTxHash,
    });
  });
  it("API: /utxo/deposit and /utxo/status", async () => {
    const app = createApp([thorchain(pricer, env, net({ statusCode: 404 }).f)], {
      pricer: null,
      guard: ctx(),
      simulator: null,
    });
    const r = await app.request("/utxo/deposit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...req, refund: LTC_P2PKH }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).vault).toBe(VAULT);
    const s = await app.request(`/utxo/status?txid=${"ab".repeat(32)}`);
    expect((await s.json()).state).toBe("waiting");
    expect((await app.request("/utxo/status?txid=nothex")).status).toBe(400);
  });
});
