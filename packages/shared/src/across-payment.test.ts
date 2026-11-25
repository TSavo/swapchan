import { encodeFunctionData, erc20Abi, maxUint256, zeroAddress } from "viem";
import { expect, it } from "vitest";
import { acrossBaseRoute, checkAcrossApproval } from "./across-payment.js";

it("accepts only the exact reviewed USDC approval to the Base pool", () => {
  const { pool, sourceToken } = acrossBaseRoute;
  const approve = (spender: typeof pool | typeof zeroAddress, amount: bigint) =>
    encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
  const tx = { to: sourceToken, value: "0x0", data: approve(pool, 1005n) };
  expect(() => checkAcrossApproval(tx, "1005")).not.toThrow();
  for (const changed of [
    { ...tx, data: approve(pool, maxUint256) },
    { ...tx, data: approve(zeroAddress, 1005n) },
    { ...tx, data: approve(pool, 1004n) },
    { ...tx, to: zeroAddress },
    { ...tx, value: "0x1" },
    { ...tx, data: (tx.data + "00") as typeof tx.data },
  ])
    expect(() => checkAcrossApproval(changed, "1005")).toThrow();
});
