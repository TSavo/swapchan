import { createHash } from "node:crypto";
import { createBase58check } from "@scure/base";
import { acrossRoute, EvmAddress, NON_EVM, TRON } from "@swapchan/shared";
import { type Address, encodeAbiParameters, encodeFunctionData, type Hex, parseAbi } from "viem";
import { z } from "zod";
import { RELAY_DEPOSITORY_PINS } from "./guard/relayPins.js";
import { checkRelayPaymentTerms } from "./payment-relay-terms.js";
import { getJson } from "./providers/types.js";

const base58 = createBase58check((v) => createHash("sha256").update(v).digest());
const safe = z.number().int().safe().nonnegative();
const tronAddress = z
  .string()
  .regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/)
  .refine((s) => {
    try {
      const raw = base58.decode(s);
      return raw.length === 21 && raw[0] === 65;
    } catch {
      return false;
    }
  });
const native = NON_EVM[TRON]!.native;
export const tronPaymentInput = z
  .object({
    sourceChainId: z.literal(TRON),
    chainId: z.literal(10),
    sender: tronAddress,
    recipient: EvmAddress,
    amountMicroUsdc: z.string().regex(/^[1-9]\d{0,37}$/),
  })
  .strict();
const trigger = z
  .object({
    owner_address: z.string(),
    contract_address: z.string(),
    call_value: safe,
    data: z.string().regex(/^[0-9a-f]+$/i),
  })
  .strict();
export async function quoteTronPayment(f: typeof fetch, i: z.infer<typeof tronPaymentInput>) {
  const post = (url: string, body: unknown) =>
    getJson(f, url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify(body),
    });
  const rpc = (method: string, body: unknown) =>
    post("https://api.trongrid.io/wallet/" + method, body);
  const sender = Buffer.from(base58.decode(i.sender)).toString("hex");
  const acct = z
    .object({ address: z.literal(sender).optional(), balance: safe.optional() })
    .parse(await rpc("getaccount", { address: sender }));
  const balance = BigInt(acct.balance ?? 0),
    base = { ...i, provider: "relay", execution: "quote_only", balanceSun: String(balance) };
  if (!balance) return { ...base, status: "empty" };
  if (!acct.address) throw Error("Tron account mismatch");
  const output = acrossRoute(10).destinationToken;
  const quote = await post("https://api.relay.link/quote/v2", {
    user: i.sender,
    originChainId: TRON,
    destinationChainId: 10,
    originCurrency: native,
    destinationCurrency: output,
    recipient: i.recipient,
    tradeType: "EXACT_OUTPUT",
    amount: i.amountMicroUsdc,
    includeProtocolData: true,
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
            chainId: z.literal("tron"),
            currency: z.literal(native),
            amount: z.string().regex(/^[1-9]\d*$/),
            depository: z.literal(RELAY_DEPOSITORY_PINS[TRON]!),
          }),
        }),
      }),
      steps: z.tuple([
        z.object({
          id: z.literal("deposit"),
          items: z.tuple([
            z.object({
              data: z
                .object({ type: z.literal("TriggerSmartContract"), parameter: trigger })
                .strict(),
            }),
          ]),
        }),
      ]),
    })
    .parse(quote);
  const { amount, depository } = v2.paymentDetails;
  const order = checkRelayPaymentTerms(
    "tron",
    v2.orderData,
    v2.orderId,
    i.sender,
    i.recipient,
    native,
    amount,
    i.amountMicroUsdc,
  );
  const p = steps[0].items[0].data.parameter;
  const expected = encodeFunctionData({
    abi: parseAbi(["function depositNative(address depositor,bytes32 id)"]),
    functionName: "depositNative",
    args: [("0x" + sender.slice(2)) as Address, v2.orderId as Hex],
  });
  if (
    p.owner_address !== sender ||
    p.contract_address !== Buffer.from(base58.decode(depository)).toString("hex") ||
    BigInt(p.call_value) !== BigInt(amount) ||
    expected !== "0x" + p.data
  )
    throw Error("Tron deposit differs from reviewed order");
  const reviewed = { ...base, order, depositSun: amount };
  if (balance < BigInt(amount)) return { ...reviewed, status: "insufficient_deposit_balance" };
  const sim = z
    .object({
      result: z.object({ result: z.literal(true) }),
      energy_used: safe.positive(),
      constant_result: z.tuple([z.literal("")]),
      logs: z.tuple([
        z.object({
          address: z.literal(p.contract_address.slice(2)),
          topics: z.tuple([
            z.literal("8032066556caf3967d8fec4ad22a2d9e1e9576556b2903a0fcd5b1fd201e3477"),
          ]),
          data: z.literal(
            encodeAbiParameters(
              [{ type: "address" }, { type: "uint256" }, { type: "bytes32" }],
              [("0x" + sender.slice(2)) as Address, BigInt(amount), v2.orderId as Hex],
            ).slice(2),
          ),
        }),
      ]),
    })
    .parse(await rpc("triggerconstantcontract", p));
  const params = z
    .object({
      chainParameter: z.array(z.object({ key: z.string(), value: z.number().optional() })),
    })
    .parse(await rpc("getchainparameters", {})).chainParameter;
  const price = (key: string) =>
    BigInt(safe.positive().parse(params.find((p) => p.key === key)?.value));
  const energySun = BigInt(sim.energy_used) * price("getEnergyFee");
  const unsigned = z
    .object({
      result: z.object({ result: z.literal(true) }),
      transaction: z.object({
        raw_data_hex: z.string().regex(/^(?:[a-f0-9]{2})+$/i),
        raw_data: z.object({
          contract: z.tuple([
            z.object({
              type: z.literal("TriggerSmartContract"),
              parameter: z.object({ value: trigger }),
            }),
          ]),
        }),
      }),
    })
    .parse(await rpc("triggersmartcontract", { ...p, fee_limit: Number(energySun) })).transaction;
  const built = unsigned.raw_data.contract[0].parameter.value;
  if (
    built.owner_address !== sender ||
    built.call_value !== p.call_value ||
    built.data !== p.data ||
    built.contract_address !== p.contract_address
  )
    throw Error("Tron node changed the deposit");
  const rawBytes = unsigned.raw_data_hex.length / 2;
  // One length-delimited raw_data field, one 65-byte signature and TRON's 64-byte result reservation.
  const bandwidth = 1 + Math.max(1, Math.ceil(Math.log2(rawBytes + 1) / 7)) + rawBytes + 67 + 64;
  const bandwidthSun = BigInt(bandwidth) * price("getTransactionFee");
  const total = BigInt(amount) + energySun + bandwidthSun;
  return {
    ...reviewed,
    status: balance >= total ? "quoted" : "insufficient_unstaked_balance",
    sourceSimulation: {
      status: "succeeded",
      requiredSignatures: 1,
      energyUnits: sim.energy_used,
      bandwidthBytes: bandwidth,
    },
    estimatedEnergyBurnSun: String(energySun),
    estimatedBandwidthBurnSun: String(bandwidthSun),
    estimatedTotalWithoutStakedResourcesSun: String(total),
  };
}
