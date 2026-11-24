import { type Address, toHex } from "viem";
import { describe, expect, it } from "vitest";
import {
  atomicWalletRequest,
  supportsAtomicOrigin,
  walletBatchReceipt,
  walletRejectedRequest,
} from "./atomicWallet";

const chainId = toHex(84532),
  id = toHex(1, { size: 32 }),
  hash = toHex(2, { size: 32 });
const account = "0x0000000000000000000000000000000000000001" as Address;
const confirmed = {
  version: "2.0.0",
  id,
  chainId,
  status: 200,
  atomic: true,
  receipts: [{ status: "0x1", transactionHash: hash }],
};
describe("atomic wallet execution", () => {
  it("clears a submission only for an explicit wallet rejection, including wrapped errors", () => {
    expect(walletRejectedRequest({ cause: { cause: { code: 4001 } } })).toBe(true);
    expect(walletRejectedRequest(new Error("connection lost: user rejected or timed out"))).toBe(
      false,
    );
    const cycle = { code: -32603, cause: {} };
    cycle.cause = cycle;
    expect(walletRejectedRequest(cycle)).toBe(false);
  });
  it("requires live support on Base Sepolia without a delegation upgrade", () => {
    expect(supportsAtomicOrigin({ [chainId]: { atomic: { status: "supported" } } })).toBe(true);
    for (const unsupported of [
      null,
      {},
      { "0xa": { atomic: { status: "supported" } } },
      { [chainId]: { atomic: { status: "ready" } } },
      { [chainId]: { atomic: { supported: true } } },
    ])
      expect(supportsAtomicOrigin(unsupported)).toBe(false);
  });
  it("binds the batch identifier, chain, account, ordered calls and atomic requirement", () => {
    const calls = [
      { target: account, data: "0x1234", value: 0n },
      { target: account, data: "0xabcd", value: 0n },
    ] as const;
    expect(atomicWalletRequest(account, id, calls)).toEqual({
      from: account,
      chainId,
      id,
      version: "2.0.0",
      atomicRequired: true,
      calls: [
        { to: account, data: "0x1234", value: "0x0" },
        { to: account, data: "0xabcd", value: "0x0" },
      ],
    });
  });
  it("accepts the hash only for the same successful atomic batch", () => {
    expect(walletBatchReceipt({ ...confirmed, status: 100, receipts: [] }, id)).toBe(null);
    expect(walletBatchReceipt(confirmed, id)).toBe(hash);
    for (const changed of [
      { id: hash },
      { chainId: "0xa" },
      { atomic: false },
      { status: 600 },
      { receipts: [] },
      { receipts: [...confirmed.receipts, { transactionHash: id, status: "0x1" }] },
      { receipts: [{ transactionHash: hash, status: "0x0" }] },
    ])
      expect(() => walletBatchReceipt({ ...confirmed, ...changed }, id)).toThrow();
  });
});
