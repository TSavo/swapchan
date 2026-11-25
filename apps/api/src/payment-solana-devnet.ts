import { base58 } from "@scure/base";
import { VersionedTransaction } from "@solana/web3.js";
import {
  type DevnetIntent,
  type DevnetSources,
  devnetTransfer,
  devnetUsdc,
} from "@swapchan/shared/solana-payment";
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
  sources?: DevnetSources;
  blockhash: string;
  lastValidBlockHeight: number;
  slot: number;
  feeLamports: number;
  rentLamports: number;
  expiresAt: number;
};
const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export function selectDevnetFunding(accountsRaw: unknown, sender: string, payout: bigint) {
  const accounts = z
    .object({
      value: z.array(
        z.object({
          pubkey: z.string(),
          account: z.object({
            owner: z.literal(tokenProgram),
            data: z.object({
              parsed: z.object({
                type: z.literal("account"),
                info: z.object({
                  owner: z.literal(sender),
                  mint: z.literal(devnetUsdc.toBase58()),
                  state: z.enum(["initialized", "frozen"]),
                  tokenAmount: z.object({
                    amount: z.string().regex(/^\d+$/),
                    decimals: z.literal(6),
                  }),
                }),
              }),
            }),
          }),
        }),
      ),
    })
    .parse(accountsRaw).value;
  const candidates = accounts
    .filter((a) => a.account.data.parsed.info.state === "initialized")
    .map((a) => ({
      account: a.pubkey,
      units: BigInt(a.account.data.parsed.info.tokenAmount.amount),
    }))
    .sort((a, b) =>
      a.units === b.units ? a.account.localeCompare(b.account) : a.units > b.units ? -1 : 1,
    );
  let needed = payout;
  const sources: DevnetSources = [];
  for (const candidate of candidates) {
    if (!needed || !candidate.units) break;
    const use = candidate.units < needed ? candidate.units : needed;
    sources.push({ account: candidate.account, amountMicroUsdc: String(use) });
    needed -= use;
  }
  return { sources, needed, spendable: candidates.reduce((sum, c) => sum + c.units, 0n) };
}
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
    sources?: DevnetSources,
  ) {
    const m = outcomes.parse(raw);
    const { transaction, destination } = devnetTransfer(
      intent,
      blockhash,
      createDestination,
      sources,
    );
    const i = transaction.message.staticAccountKeys.findIndex((k) => k.equals(destination));
    const senderIndex = transaction.message.staticAccountKeys.findIndex(
      (k) => k.toBase58() === intent.sender,
    );
    if (intent.feePayer && m.preBalances[senderIndex] !== m.postBalances[senderIndex])
      throw Error("Unexpected sender SOL change");
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
          beforeLamports: integer.parse(m.preBalances[senderIndex]),
          afterLamports: integer.parse(m.postBalances[senderIndex]),
        },
        ...(intent.feePayer
          ? {
              feePayer: {
                address: intent.feePayer,
                beforeLamports: m.preBalances[0],
                afterLamports: m.postBalances[0],
              },
            }
          : {}),
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
    sources?: DevnetSources,
  ) {
    const { transaction } = devnetTransfer(intent, blockhash, createDestination, sources);
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
    return { serialized, ...verify(intent, blockhash, createDestination, response.value, sources) };
  }
  return {
    async quote(intent: DevnetIntent) {
      await network();
      const { value, context } = z
        .object({
          context: z.object({ slot: integer }),
          value: z.object({ blockhash: z.string(), lastValidBlockHeight: integer }),
        })
        .parse(await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]));
      const config = { commitment: "confirmed", minContextSlot: context.slot };
      const { destination } = devnetTransfer(intent, value.blockhash, true);
      const mint = devnetUsdc.toBase58();

      const [accountsRaw, nativeRaw, destinationRaw, payerRaw] = await Promise.all([
        rpc("getTokenAccountsByOwner", [
          intent.sender,
          { mint },
          { ...config, encoding: "jsonParsed" },
        ]),
        rpc("getBalance", [intent.sender, config]),
        rpc("getAccountInfo", [
          destination.toBase58(),
          { ...config, encoding: "base64", dataSlice: { offset: 0, length: 0 } },
        ]),
        intent.feePayer ? rpc("getBalance", [intent.feePayer, config]) : null,
      ]);
      const { sources, needed, spendable } = selectDevnetFunding(
        accountsRaw,
        intent.sender,
        BigInt(intent.amountMicroUsdc),
      );
      const native = z.object({ value: integer }).parse(nativeRaw).value;
      const payerLamports = intent.feePayer
        ? z.object({ value: integer }).parse(payerRaw).value
        : native;
      const createDestination =
        z
          .object({ value: z.object({ owner: z.literal(tokenProgram) }).nullable() })
          .parse(destinationRaw).value === null;
      const sourceWallet = {
        spendableMicroUsdc: String(spendable),
        lamports: native,
        ...(intent.feePayer ? { feePayer: intent.feePayer, feePayerLamports: payerLamports } : {}),
      };
      if (sources.length > 32)
        return { intent, sourceWallet, status: "too_many_source_accounts" as const };
      const { transaction } = devnetTransfer(
        intent,
        value.blockhash,
        createDestination,
        needed ? undefined : sources,
      );
      let bytes: Uint8Array;
      try {
        bytes = transaction.serialize();
      } catch {
        return { intent, sourceWallet, status: "too_many_source_accounts" as const };
      }
      if (bytes.length > 1232)
        return { intent, sourceWallet, status: "too_many_source_accounts" as const };
      const [feeResult, rentLamports] = await Promise.all([
        rpc("getFeeForMessage", [
          Buffer.from(transaction.message.serialize()).toString("base64"),
          config,
        ]),
        createDestination
          ? rpc("getMinimumBalanceForRentExemption", [165, { commitment: "confirmed" }]).then((v) =>
              integer.parse(v),
            )
          : 0,
      ]);
      const feeLamports = z.object({ value: integer.positive() }).parse(feeResult).value;
      const lamports = Math.max(0, feeLamports + rentLamports - payerLamports);
      if (needed || lamports)
        return {
          intent,
          sourceWallet,
          status: "insufficient_funds" as const,
          fundingShortfall: { microUsdc: String(needed), lamports },
          feeLamports,
          rentLamports,
        };
      const costs = await simulate(
        intent,
        value.blockhash,
        context.slot,
        createDestination,
        sources,
      );
      if (createDestination !== costs.rentLamports > 0)
        throw Error("Recipient account changed during simulation");
      return {
        status: "simulated" as const,
        intent,
        sources,
        sourceWallet,
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
      const check = await simulate(r.intent, r.blockhash, r.slot, r.rentLamports > 0, r.sources);
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
      const expected = devnetTransfer(
        r.intent,
        r.blockhash,
        r.rentLamports > 0,
        r.sources,
      ).transaction;
      if (
        tx.signatures.length !== expected.signatures.length ||
        base58.encode(tx.signatures[0]!) !== signature ||
        !Buffer.from(tx.message.serialize()).equals(expected.message.serialize())
      )
        throw Error("Transaction differs from review");
      if (meta.err !== null)
        return { status: "origin_failed", signature, slot, feeLamports: integer.parse(meta.fee) };
      const costs = verify(r.intent, r.blockhash, r.rentLamports > 0, meta, r.sources);
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
        signatures: tx.signatures.length,
      };
    },
  };
}
