import { createHash } from "node:crypto";
import { base58 } from "@scure/base";
import { PublicKey } from "@solana/web3.js";
import {
  type CircleDevnetIntent,
  devnetUsdc,
  solanaForwardTarget,
} from "@swapchan/shared/solana-payment";
import { z } from "zod";
import { tokenBalance } from "./payment-solana-simulation.js";

const transmitter = "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC";
const receive = createHash("sha256").update("global:receive_message").digest().subarray(0, 8);
const instruction = z.object({ programId: z.string(), data: z.string().optional() });
type MintResult = {
  status: "awaiting_forward" | "awaiting_mint_receipt" | "awaiting_finality" | "settled";
  destinationFinalized?: boolean;
  mintHash?: string;
  destinationSlot?: number;
  paidMicroUsdc?: string;
  recipientTokenAccount?: string;
  destinationBalances?: { beforeMicroUsdc: string; afterMicroUsdc: string };
  forwarderFeeLamports?: number;
};
export async function solanaCircleMint(
  rpc: (method: string, params: unknown[]) => Promise<unknown>,
  hash: string | undefined,
  message: string,
  intent: CircleDevnetIntent,
): Promise<MintResult> {
  if ((await rpc("getGenesisHash", [])) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG")
    throw Error("Wrong mint network");
  // A successful receive initializes the unique nonce PDA. Its history also works
  // when the Circle index has the attestation but no forwarder signature yet.
  if (!hash) {
    const nonce = Buffer.from(message.slice(26, 90), "hex");
    const [account] = PublicKey.findProgramAddressSync(
      [Buffer.from("used_nonce"), nonce],
      new PublicKey(transmitter),
    );
    const history = z
      .array(z.object({ signature: z.string(), err: z.unknown() }))
      .parse(
        await rpc("getSignaturesForAddress", [
          account.toBase58(),
          { limit: 10, commitment: "confirmed" },
        ]),
      );
    // An account can be mentioned by unrelated transactions. Only trust the
    // receipt after checking its complete receive instruction and token delta.
    for (const row of history.filter((v) => v.err === null)) {
      try {
        const found = await solanaCircleMint(rpc, row.signature, message, intent);
        if (found.destinationSlot !== undefined) return found;
      } catch {
        // Another transaction mentioning this nonce cannot establish settlement.
      }
    }
    return { status: "awaiting_forward" };
  }
  const signature = /^(?:0x)?[0-9a-f]{128}$/i.test(hash)
    ? base58.encode(Buffer.from(hash.replace(/^0x/, ""), "hex"))
    : hash;
  if (base58.decode(signature).length !== 64) throw Error("Invalid Solana mint signature");
  const raw = await rpc("getTransaction", [
    signature,
    { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
  ]);
  if (!raw) return { status: "awaiting_mint_receipt", mintHash: signature };
  const token = tokenBalance.extend({ accountIndex: z.number().int().nonnegative() });
  const tx = z
    .object({
      slot: z.number().int().safe(),
      transaction: z.object({
        signatures: z.array(z.string()),
        message: z.object({
          accountKeys: z.array(z.object({ pubkey: z.string() })),
          instructions: z.array(instruction),
        }),
      }),
      meta: z.object({
        err: z.null(),
        fee: z.number().int().safe().nonnegative(),
        preTokenBalances: z.array(token),
        postTokenBalances: z.array(token),
        innerInstructions: z.array(z.object({ instructions: z.array(instruction) })).nullish(),
      }),
    })
    .parse(raw);
  if (tx.transaction.signatures[0] !== signature) throw Error("Wrong Solana mint transaction");
  const attested = Buffer.from(message.slice(2), "hex");
  const calls = [
    ...tx.transaction.message.instructions,
    ...(tx.meta.innerInstructions ?? []).flatMap((g) => g.instructions),
  ];
  const match = calls.filter((c) => {
    if (c.programId !== transmitter || !c.data) return false;
    const data = Buffer.from(base58.decode(c.data));
    return (
      data.length > 12 + attested.length &&
      data.subarray(0, 8).equals(receive) &&
      data.readUInt32LE(8) === attested.length &&
      data.subarray(12, 12 + attested.length).equals(attested)
    );
  });
  if (match.length !== 1) throw Error("Missing attested CCTP receive instruction");
  const { ata } = solanaForwardTarget(intent.recipient);
  const idx = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey === ata);
  if (idx < 0) throw Error("Missing recipient token account");
  function units(rows: typeof tx.meta.postTokenBalances) {
    const b = rows.find((r) => r.accountIndex === idx);
    if (!b) return 0n;
    if (b.owner !== intent.recipient || b.mint !== devnetUsdc.toBase58())
      throw Error("Unexpected destination token");
    return BigInt(b.uiTokenAmount.amount);
  }
  const before = units(tx.meta.preTokenBalances),
    after = units(tx.meta.postTokenBalances);
  if (after - before !== BigInt(intent.amountMicroUsdc)) throw Error("Wrong Solana mint amount");
  const state = z
    .object({
      value: z.tuple([
        z.object({ slot: z.literal(tx.slot), err: z.null(), confirmationStatus: z.string() }),
      ]),
    })
    .parse(await rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]))
    .value[0];
  return {
    status: state.confirmationStatus === "finalized" ? "settled" : "awaiting_finality",
    destinationFinalized: state.confirmationStatus === "finalized",
    mintHash: signature,
    destinationSlot: tx.slot,
    paidMicroUsdc: intent.amountMicroUsdc,
    recipientTokenAccount: ata,
    destinationBalances: { beforeMicroUsdc: String(before), afterMicroUsdc: String(after) },
    forwarderFeeLamports: tx.meta.fee,
  };
}
