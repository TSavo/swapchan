import { base58 } from "@scure/base";
import { VersionedTransaction } from "@solana/web3.js";
import { type DevnetIntent, devnetTransfer, devnetUsdc } from "@swapchan/shared/solana-payment";
import { z } from "zod";
import { checkTokenChanges, tokenBalance } from "./payment-solana-simulation.js";

const integer = z.number().int().safe().nonnegative();
const outcomes = z.object({
  err: z.null(),
  fee: integer.positive(),
  preBalances: z.array(integer),
  postBalances: z.array(integer),
  preTokenBalances: z.array(tokenBalance),
  postTokenBalances: z.array(tokenBalance),
});
type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
export type DevnetReview = {
  intent: DevnetIntent;
  blockhash: string;
  lastValidBlockHeight: number;
  slot: number;
  feeLamports: number;
  rentLamports: number;
  expiresAt: number;
};
export function devnetPayment(rpc: Rpc) {
  async function network() {
    if ((await rpc("getGenesisHash", [])) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG")
      throw Error("Unexpected Solana network");
  }
  function verify(
    intent: DevnetIntent,
    blockhash: string,
    createDestination: boolean,
    raw: unknown,
  ) {
    const m = outcomes.parse(raw);
    const { transaction, destination } = devnetTransfer(intent, blockhash, createDestination);
    const i = transaction.message.staticAccountKeys.findIndex((k) => k.equals(destination));
    const rent = integer.parse(m.postBalances[i]) - integer.parse(m.preBalances[i]);
    if (
      rent < 0 ||
      BigInt(integer.parse(m.preBalances[0])) - BigInt(integer.parse(m.postBalances[0])) !==
        BigInt(m.fee) + BigInt(rent)
    )
      throw Error("Unexpected payer SOL change");
    const amount = BigInt(intent.amountMicroUsdc);
    checkTokenChanges(m, intent.sender, devnetUsdc.toBase58(), amount);
    checkTokenChanges(m, intent.recipient, devnetUsdc.toBase58(), -amount);
    function tokenUnits(rows: typeof m.preTokenBalances, owner: string) {
      return rows
        .filter((row) => row.owner === owner && row.mint === devnetUsdc.toBase58())
        .reduce((sum, row) => sum + BigInt(row.uiTokenAmount.amount), 0n)
        .toString();
    }
    return {
      feeLamports: m.fee,
      rentLamports: rent,
      balances: {
        sender: {
          beforeMicroUsdc: tokenUnits(m.preTokenBalances, intent.sender),
          afterMicroUsdc: tokenUnits(m.postTokenBalances, intent.sender),
          beforeLamports: m.preBalances[0],
          afterLamports: m.postBalances[0],
        },
        recipient: {
          beforeMicroUsdc: tokenUnits(m.preTokenBalances, intent.recipient),
          afterMicroUsdc: tokenUnits(m.postTokenBalances, intent.recipient),
        },
      },
    };
  }
  async function simulate(
    intent: DevnetIntent,
    blockhash: string,
    slot: number,
    createDestination: boolean,
  ) {
    const { transaction } = devnetTransfer(intent, blockhash, createDestination);
    const serialized = Buffer.from(transaction.serialize()).toString("base64");
    const response = z.object({ value: z.unknown() }).parse(
      await rpc("simulateTransaction", [
        serialized,
        {
          encoding: "base64",
          commitment: "confirmed",
          sigVerify: false,
          replaceRecentBlockhash: false,
          minContextSlot: slot,
        },
      ]),
    );
    return { serialized, ...verify(intent, blockhash, createDestination, response.value) };
  }
  return {
    async quote(intent: DevnetIntent): Promise<DevnetReview> {
      await network();
      const { value, context } = z
        .object({
          context: z.object({ slot: integer }),
          value: z.object({ blockhash: z.string(), lastValidBlockHeight: integer }),
        })
        .parse(await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]));
      const withCreation = await simulate(intent, value.blockhash, context.slot, true);
      const costs = withCreation.rentLamports
        ? withCreation
        : await simulate(intent, value.blockhash, context.slot, false);
      return {
        intent,
        ...value,
        slot: context.slot,
        feeLamports: costs.feeLamports,
        rentLamports: costs.rentLamports,
        expiresAt: Math.floor(Date.now() / 1000) + 45,
      };
    },
    async build(r: DevnetReview) {
      await network();
      if (
        r.expiresAt <= Date.now() / 1000 ||
        integer.parse(await rpc("getBlockHeight", [{ commitment: "confirmed" }])) >
          r.lastValidBlockHeight
      )
        throw Error("Expired review");
      const check = await simulate(r.intent, r.blockhash, r.slot, r.rentLamports > 0);
      if (
        check.feeLamports > r.feeLamports ||
        check.rentLamports > r.rentLamports ||
        r.expiresAt <= Date.now() / 1000
      )
        throw Error("Fresh review required");
      return { ...r, serialized: check.serialized };
    },
    async status(r: DevnetReview, signature: string) {
      await network();
      if (base58.decode(signature).length !== 64) throw Error("Invalid signature");
      const record = await rpc("getTransaction", [
        signature,
        { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
      ]);
      if (!record) return { status: "awaiting_origin_receipt", signature };
      const { transaction, slot, meta } = z
        .object({
          transaction: z.tuple([z.string(), z.literal("base64")]),
          slot: integer,
          meta: z.object({ err: z.unknown() }).passthrough(),
        })
        .parse(record);
      const tx = VersionedTransaction.deserialize(Buffer.from(transaction[0], "base64"));
      const expected = devnetTransfer(r.intent, r.blockhash, r.rentLamports > 0).transaction;
      if (
        tx.signatures.length !== 1 ||
        base58.encode(tx.signatures[0]!) !== signature ||
        !Buffer.from(tx.message.serialize()).equals(expected.message.serialize())
      )
        throw Error("Transaction differs from review");
      if (meta.err !== null)
        return { status: "origin_failed", signature, slot, feeLamports: integer.parse(meta.fee) };
      const costs = verify(r.intent, r.blockhash, r.rentLamports > 0, meta);
      if (costs.feeLamports > r.feeLamports || costs.rentLamports > r.rentLamports)
        throw Error("Actual fee exceeds review");
      const canonical = z
        .object({
          value: z.tuple([
            z.object({ slot: integer, err: z.null(), confirmationStatus: z.string() }).nullable(),
          ]),
        })
        .parse(await rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]))
        .value[0];
      if (!canonical || canonical.slot !== slot) throw Error("Receipt changed");
      return {
        status: canonical.confirmationStatus === "finalized" ? "settled" : "awaiting_finality",
        signature,
        slot,
        ...costs,
        ...r.intent,
        signatures: 1,
      };
    },
  };
}
