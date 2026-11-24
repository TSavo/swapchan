import {
  batchAbi,
  paymentContracts as contracts,
  type PaymentQuote,
  paymentBatch,
} from "@swapchan/shared";
import { decodeFunctionData, erc20Abi, parseAbi } from "viem";
import { describe, expect, it } from "vitest";

const q: PaymentQuote = {
  chainId: 84532,
  sender: "0x18eE1D19Ab2030e5dd6f52c6be152ffeA0d08c0D",
  recipient: "0xa11F5DA00D9a0E9b809E94c4cAe1efa36E8ff50b",
  amountMicroUsdc: "1",
  maxGasMicroUsdc: "8000",
  maxWethWei: "20000",
  swapOutputMicroUsdc: "8001",
  expiresAt: 1000,
  requiresDelegation: true,
  maxFeePerGas: "0x10",
  maxPriorityFeePerGas: "0x1",
};
function calls(quote: PaymentQuote) {
  return decodeFunctionData({ abi: batchAbi, data: paymentBatch(quote) }).args[0];
}
describe("exact Base Sepolia payments", () => {
  it("caps the router input, clears remaining allowance, pays the exact recipient, and bounds gas collection", () => {
    const batch = calls(q);
    expect(batch.map((c) => c.value)).toEqual([0n, 0n, 0n, 0n, 0n]);
    expect(batch.map((c) => c.target.toLowerCase())).toEqual(
      [contracts.weth, contracts.router, contracts.weth, contracts.usdc, contracts.usdc].map((a) =>
        a.toLowerCase(),
      ),
    );
    const decoded = batch
      .filter((_, i) => i !== 1)
      .map((c) => decodeFunctionData({ abi: erc20Abi, data: c.data }));
    expect(decoded.map((c) => c.functionName)).toEqual([
      "approve",
      "approve",
      "transfer",
      "approve",
    ]);
    expect(decoded.map((c) => c.args)).toEqual([
      [contracts.router, 20000n],
      [contracts.router, 0n],
      [q.recipient, 1n],
      [contracts.paymaster, 8000n],
    ]);
    const swap = decodeFunctionData({
      abi: parseAbi([
        "function exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160))",
      ]),
      data: batch[1]!.data,
    });
    expect(swap.args[0]).toEqual([
      contracts.weth,
      contracts.usdc,
      3000,
      q.sender,
      8001n,
      20000n,
      0n,
    ]);
  });
  it("pays directly from USDC when no swap was quoted", () => {
    const batch = calls({ ...q, maxWethWei: "0", swapOutputMicroUsdc: "0" });
    expect(
      batch.map((c) => decodeFunctionData({ abi: erc20Abi, data: c.data }).functionName),
    ).toEqual(["transfer", "approve"]);
  });
  it("rejects inconsistent swap limits", () =>
    expect(() => calls({ ...q, maxWethWei: "0" })).toThrow("inconsistent"));
});
