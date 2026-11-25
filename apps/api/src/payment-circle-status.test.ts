import {
  acrossTestRoute,
  batchAbi,
  circleBurnAbi,
  circleMessenger,
  paymentContracts,
} from "@swapchan/shared";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  keccak256,
  pad,
  toEventSelector,
  zeroAddress,
  zeroHash,
} from "viem";
import { entryPoint08Abi } from "viem/account-abstraction";
import { expect, it } from "vitest";
import { circleWalletOperation } from "./payment-circle-status.js";

it("attributes the exact Circle batch and gas only to its sender inside handleOps", () => {
  const sender = paymentContracts.delegate,
    recipient = paymentContracts.router;
  const burn = encodeFunctionData({
    abi: circleBurnAbi,
    functionName: "depositForBurnWithFees",
    args: [
      1n,
      2,
      pad(recipient),
      paymentContracts.usdc,
      zeroHash,
      { signedQuote: "0x1234", refundAddress: sender },
    ],
  });
  const approval = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [circleMessenger, 99n],
  });
  const callData = encodeFunctionData({
    abi: batchAbi,
    functionName: "executeBatch",
    args: [
      [
        { target: acrossTestRoute.sourceToken, value: 0n, data: approval },
        { target: circleMessenger, value: 0n, data: burn },
      ],
    ],
  });
  const operation = {
    sender,
    nonce: 10n,
    initCode: "0x",
    callData,
    accountGasLimits: zeroHash,
    preVerificationGas: 0n,
    gasFees: zeroHash,
    paymasterAndData: "0x",
    signature: "0x",
  } as const;
  const input = encodeFunctionData({
    abi: entryPoint08Abi,
    functionName: "handleOps",
    args: [[{ ...operation, sender: recipient }, operation], zeroAddress],
  });
  const log = (sender: Hex, nonce: bigint) => ({
    address: paymentContracts.entry,
    topics: encodeEventTopics({
      abi: entryPoint08Abi,
      eventName: "UserOperationEvent",
      args: { userOpHash: zeroHash, sender, paymaster: zeroAddress },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
      [nonce, true, 67n, 10n],
    ),
  });
  const marker = { address: circleMessenger, topics: [zeroHash], data: "0x" as Hex };
  const before = {
    address: paymentContracts.entry,
    topics: [toEventSelector("BeforeExecution()")],
    data: "0x" as Hex,
  };
  const logs = [before, log(recipient, 10n), marker, log(sender, 10n)];
  const intent = {
    originHash: zeroHash,
    sender,
    recipient,
    burnDataHash: keccak256(burn),
    amountMicroUsdc: "1",
    maxInputMicroUsdc: "99",
  };
  expect(circleWalletOperation(input, logs, intent)).toMatchObject({
    paid: 1n,
    logs: [marker],
    fees: { entryPointGasCostWei: "67" },
  });
  expect(() =>
    circleWalletOperation(input, [before, log(recipient, 10n), marker, log(sender, 9n)], intent),
  ).toThrow();
  expect(() =>
    circleWalletOperation(input, logs, { ...intent, maxInputMicroUsdc: "100" }),
  ).toThrow();
});
