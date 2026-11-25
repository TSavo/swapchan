import { base58 } from "@scure/base";
import { Keypair } from "@solana/web3.js";
import { devnetTransfer, devnetUsdc } from "@swapchan/shared/solana-payment";
import { describe, expect, it } from "vitest";
import { devnetPayment, selectDevnetFunding } from "./payment-solana-devnet.js";

describe("devnet exact payment receipts", () => {
  it("splits the exact payment across the fewest spendable USDC accounts", () => {
    const sender = Keypair.generate().publicKey.toBase58();
    const row = (pubkey: string, amount: string, state = "initialized") => ({
      pubkey,
      account: {
        owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        data: {
          parsed: {
            type: "account",
            info: {
              owner: sender,
              mint: devnetUsdc.toBase58(),
              tokenAmount: { amount, decimals: 6 },
              state,
            },
          },
        },
      },
    });
    const rows = [
      row("one", "1"),
      row("two", "2"),
      row("five", "5"),
      row("frozen", "100", "frozen"),
    ];
    expect(selectDevnetFunding({ value: rows }, sender, 6n)).toEqual({
      sources: [
        { account: "five", amountMicroUsdc: "5" },
        { account: "two", amountMicroUsdc: "1" },
      ],
      needed: 0n,
      spendable: 8n,
    });
  });
  it("binds the wallet signature, message and finalized recipient gain to the review", async () => {
    const signer = Keypair.generate(),
      recipient = Keypair.generate().publicKey.toBase58();
    const intent = {
      chainId: "solana:devnet" as const,
      sender: signer.publicKey.toBase58(),
      recipient,
      amountMicroUsdc: "1",
    };
    const blockhash = Keypair.generate().publicKey.toBase58();
    const review = {
      intent,
      blockhash,
      lastValidBlockHeight: 101,
      slot: 20,
      feeLamports: 5000,
      rentLamports: 0,
      expiresAt: 1,
    };
    const { transaction } = devnetTransfer(intent, blockhash, false);
    transaction.sign([signer]);
    const signature = base58.encode(transaction.signatures[0]!);
    const balance = (owner: string, units: number) => ({
      owner,
      mint: devnetUsdc.toBase58(),
      uiTokenAmount: { amount: String(units) },
    });
    const before = transaction.message.staticAccountKeys.map((_, i) => (i === 0 ? 10000 : 100));
    const after = before.slice();
    after[0] = 5000;
    const meta = {
      fee: 5000,
      err: null,
      preBalances: before,
      postBalances: after,
      preTokenBalances: [balance(intent.sender, 4), balance(recipient, 7)],
      postTokenBalances: [balance(intent.sender, 3), balance(recipient, 8)],
    };
    const rpc = async (method: string) => {
      if (method === "getGenesisHash") return "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
      if (method === "getTransaction")
        return {
          slot: 21,
          transaction: [Buffer.from(transaction.serialize()).toString("base64"), "base64"],
          meta,
        };
      if (method === "getSignatureStatuses")
        return { value: [{ err: null, slot: 21, confirmationStatus: "finalized" }] };
      throw Error(method);
    };
    const api = devnetPayment(rpc);
    expect(await api.status(review, signature)).toMatchObject({
      status: "settled",
      balances: { recipient: { beforeMicroUsdc: "7", afterMicroUsdc: "8" } },
    });
    await expect(
      api.status({ ...review, intent: { ...intent, amountMicroUsdc: "2" } }, signature),
    ).rejects.toThrow("differs from review");
    meta.postTokenBalances[1] = balance(recipient, 7);
    await expect(api.status(review, signature)).rejects.toThrow("token changes");
  });
});
