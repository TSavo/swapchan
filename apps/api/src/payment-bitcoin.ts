import { acrossRoute, BITCOIN, EvmAddress, NON_EVM } from "@swapchan/shared";
import { address, opcodes, Psbt, script } from "bitcoinjs-lib";
import { z } from "zod";
import { RELAY_DEPOSITORY_PINS } from "./guard/relayPins.js";
import { checkRelayPaymentTerms } from "./payment-relay-terms.js";
import { getJson } from "./providers/types.js";

const native = NON_EVM[BITCOIN]!.native;
const sats = z.number().int().safe().nonnegative();
export const bitcoinPaymentInput = z
  .object({
    sourceChainId: z.literal(BITCOIN),
    chainId: z.literal(10),
    sender: z
      .string()
      .max(90)
      .refine((s) => {
        try {
          address.toOutputScript(s);
          return true;
        } catch {
          return false;
        }
      }),
    recipient: EvmAddress,
    amountMicroUsdc: z.string().regex(/^[1-9]\d{0,37}$/),
  })
  .strict();
export async function quoteBitcoinPayment(f: typeof fetch, i: z.infer<typeof bitcoinPaymentInput>) {
  const output = acrossRoute(10).destinationToken;
  const read = (path: string) =>
    getJson(f, "https://mempool.space/api/" + path, { signal: AbortSignal.timeout(10000) });
  const stats = z.object({ funded_txo_sum: sats, spent_txo_sum: sats });
  const wallet = z
    .object({ address: z.literal(i.sender), chain_stats: stats, mempool_stats: stats })
    .parse(await read("address/" + i.sender));
  const balance =
    BigInt(wallet.chain_stats.funded_txo_sum) - BigInt(wallet.chain_stats.spent_txo_sum);
  const base = {
    ...i,
    provider: "relay",
    execution: "quote_only",
    confirmedBalanceSats: String(balance),
  };
  if (!balance) return { ...base, status: "empty" };
  const quote = await getJson(f, "https://api.relay.link/quote/v2", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      user: i.sender,
      originChainId: BITCOIN,
      destinationChainId: 10,
      originCurrency: native,
      destinationCurrency: output,
      recipient: i.recipient,
      tradeType: "EXACT_OUTPUT",
      amount: i.amountMicroUsdc,
      includeProtocolData: true,
    }),
  });
  const {
    protocol: { v2 },
    steps,
  } = z
    .object({
      protocol: z.object({
        v2: z.object({
          orderId: z.string().regex(/^0x[0-9a-f]{64}$/),
          orderData: z.unknown(),
          paymentDetails: z.object({
            chainId: z.literal("bitcoin"),
            currency: z.literal(native),
            amount: z.string().regex(/^[1-9]\d*$/),
            depository: z.string(),
          }),
        }),
      }),
      steps: z.tuple([
        z.object({
          id: z.literal("deposit"),
          items: z.tuple([
            z.object({
              data: z.object({
                psbt: z
                  .string()
                  .max(200000)
                  .regex(/^(?:[0-9a-f]{2})+$/i),
              }),
            }),
          ]),
        }),
      ]),
    })
    .parse(quote);
  const p = v2.paymentDetails;
  const order = checkRelayPaymentTerms(
    "bitcoin",
    v2.orderData,
    v2.orderId,
    i.sender,
    i.recipient,
    native,
    p.amount,
    i.amountMicroUsdc,
  );
  const psbt = Psbt.fromHex(steps[0].items[0].data.psbt);
  const owner = Buffer.from(address.toOutputScript(i.sender)),
    deposit = Buffer.from(address.toOutputScript(p.depository));
  const memo = script.compile([opcodes.OP_RETURN, Buffer.from(v2.orderId)]);
  const outs = psbt.txOutputs;
  if (
    deposit.equals(owner) ||
    outs.length < 2 ||
    outs.length > 3 ||
    outs.filter((o) => o.value === BigInt(p.amount) && deposit.equals(o.script)).length !== 1 ||
    outs.filter((o) => o.value === 0n && Buffer.from(memo).equals(o.script)).length !== 1 ||
    outs.filter((o) => owner.equals(o.script)).length !== outs.length - 2
  )
    throw Error("Bitcoin outputs differ from order");
  const inputs = psbt.txInputs;
  if (!inputs.length || inputs.length > 32) throw Error("Unsupported number of Bitcoin inputs");
  const seen = new Set<string>();
  const amounts = await Promise.all(
    inputs.map(async (input, n) => {
      const txid = Buffer.from(input.hash).reverse().toString("hex"),
        id = txid + ":" + input.index;
      if (seen.has(id)) throw Error("Duplicate Bitcoin input");
      seen.add(id);
      const [raw, spend] = await Promise.all([
        read("tx/" + txid),
        read("tx/" + txid + "/outspend/" + input.index),
      ]);
      const tx = z
        .object({
          txid: z.literal(txid),
          status: z.object({ confirmed: z.literal(true) }),
          vout: z.array(z.object({ value: sats, scriptpubkey: z.string() })),
        })
        .parse(raw);
      z.object({ spent: z.literal(false) }).parse(spend);
      const prev = tx.vout[input.index],
        witness = psbt.data.inputs[n]?.witnessUtxo;
      if (
        !prev ||
        prev.scriptpubkey !== owner.toString("hex") ||
        !witness ||
        witness.value !== BigInt(prev.value) ||
        !owner.equals(witness.script)
      )
        throw Error("Bitcoin input differs from unspent output");
      return BigInt(prev.value);
    }),
  );
  const inputTotal = amounts.reduce((a, b) => a + b, 0n),
    fee = inputTotal - outs.reduce((a, o) => a + o.value, 0n);
  if (fee <= 0n) throw Error("Invalid Bitcoin fee");
  return {
    ...base,
    status: "quoted",
    order,
    inputCount: inputs.length,
    depositSats: p.amount,
    minerFeeSats: String(fee),
    totalSpendSats: String(BigInt(p.amount) + fee),
    executionGate:
      RELAY_DEPOSITORY_PINS[BITCOIN] === p.depository
        ? "mainnet_build_disabled"
        : "unverified_bitcoin_depository",
  };
}
