import { encodeFunctionData, keccak256, pad, zeroAddress, zeroHash } from "viem";
import { expect, it } from "vitest";
import { acrossTestRoute } from "./across-payment.js";
import { checkCircleBurn, circleBurnAbi } from "./circle-payment.js";

it("rejects a Circle burn to the wrong recipient even when its calldata hash matches", () => {
  const sender = "0x0000000000000000000000000000000000000001";
  const recipient = "0x0000000000000000000000000000000000000002";
  const data = encodeFunctionData({
    abi: circleBurnAbi,
    functionName: "depositForBurnWithFees",
    args: [
      1n,
      2,
      pad(recipient),
      acrossTestRoute.sourceToken,
      zeroHash,
      { signedQuote: "0xab", refundAddress: sender },
    ],
  });
  const intent = {
    sender,
    recipient,
    amountMicroUsdc: "1",
    burnDataHash: keccak256(data),
  } as const;
  expect(checkCircleBurn(data, intent)).toBe(1n);
  expect(() => checkCircleBurn(data, { ...intent, recipient: zeroAddress })).toThrow();
  expect(() => checkCircleBurn(data, { ...intent, amountMicroUsdc: "2" })).toThrow();
});
