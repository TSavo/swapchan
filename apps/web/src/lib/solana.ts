import {
  type Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { NonEvmTx } from "@swapchan/shared";
import { Buffer } from "buffer";

interface RelayIx {
  keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  programId: string;
  data: string;
}

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const fromHex = (h: string) => {
  if (!/^(?:0x)?(?:[0-9a-f]{2})*$/i.test(h)) throw new Error("Invalid Solana instruction bytes");
  return Buffer.from(h.replace(/^0x/i, ""), "hex");
};

/** Turn a provider's Solana payload into an unsigned VersionedTransaction for the wallet. */
export async function toSolanaTx(
  p: NonEvmTx,
  payer: string,
  connection: Connection,
): Promise<VersionedTransaction> {
  if (p.kind === "svm-base64") return VersionedTransaction.deserialize(fromBase64(String(p.data)));
  if (p.kind !== "svm-instructions") throw new Error(`not a Solana payload: ${p.kind}`);
  const d = p.data as { instructions: RelayIx[]; addressLookupTableAddresses?: string[] };
  const instructions = d.instructions.map(
    (ix) =>
      new TransactionInstruction({
        programId: new PublicKey(ix.programId),
        keys: ix.keys.map((k) => ({ ...k, pubkey: new PublicKey(k.pubkey) })),
        data: fromHex(ix.data),
      }),
  );
  const luts = await Promise.all(
    (d.addressLookupTableAddresses ?? []).map(async (a) => {
      const r = await connection.getAddressLookupTable(new PublicKey(a));
      if (!r.value) throw new Error(`lookup table ${a} not found`);
      return r.value;
    }),
  );
  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: new PublicKey(payer),
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(luts);
  return new VersionedTransaction(msg);
}
