import { type PaymentQuote, paymentBatch, paymentContracts } from "@swapchan/shared";
import { hashTypedData } from "viem";
import { describe, expect, it } from "vitest";
import { paymentSignatureRequest } from "./paymentSigning";

// Public fields from the settled Base Sepolia repeat payment.
const hash = "0xd95146b6e3d1539be4e4e385d77db365aced558b8d065a74c8eb02414b1f7b54";
const quote: PaymentQuote = {
  chainId: 84532,
  sender: "0x18eE1D19Ab2030e5dd6f52c6be152ffeA0d08c0D",
  recipient: "0xa11F5DA00D9a0E9b809E94c4cAe1efa36E8ff50b",
  amountMicroUsdc: "1",
  expiresAt: 4102444800,
  maxGasMicroUsdc: "6996",
  maxWethWei: "0",
  swapOutputMicroUsdc: "0",
  requiresDelegation: false,
  maxFeePerGas: "0x7026f0",
  maxPriorityFeePerGas: "0x100590",
};
const op = {
  sender: quote.sender,
  nonce: "0x2",
  callData: paymentBatch(quote),
  paymaster: paymentContracts.paymaster,
  paymasterData:
    "0x020000006b05f6c6000000000000036cbd53842c5426634e7929541ec2318f3dcf7e00000000000000000000000000004a2e000000000000000000000000000000000000000000000000000000006da68ade000000000000000000000000000109a0d8baa107006c93a030d1455a2ef43261b384f21c76df333d369088f62630521cde454e9f93992458ceb3b98fcf953f705de7060724473594684a04c92f97dcf694826dfa971fa2f68931a2d09f388144764d73db1b",
  maxFeePerGas: quote.maxFeePerGas,
  maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
  callGasLimit: "0x13880",
  verificationGasLimit: "0x11170",
  preVerificationGas: "0x15f90",
  paymasterVerificationGasLimit: "0x14c08",
  paymasterPostOpGasLimit: "0x15f90",
};
describe("SmartWallet payment signature request", () => {
  it("reproduces the digest that settled on Base Sepolia", () => {
    expect(hashTypedData(paymentSignatureRequest(quote, op, hash))).toBe(hash);
  });
  it.each([
    ["recipient", { callData: paymentBatch({ ...quote, recipient: quote.sender }) }],
    ["approval", { callData: paymentBatch({ ...quote, maxGasMicroUsdc: "6997" }) }],
    ["paymaster", { paymaster: quote.recipient }],
    ["priority fee", { maxPriorityFeePerGas: "0x100591" }],
    ["gas limit", { preVerificationGas: "0x15f91" }],
    ["unexpected delegation", { factory: "0x7702" }],
  ])("rejects a changed %s before signing", (_, changes) => {
    expect(() => paymentSignatureRequest(quote, { ...op, ...changes }, hash)).toThrow();
  });
  it("rejects an expired quote", () => {
    expect(() => paymentSignatureRequest({ ...quote, expiresAt: 0 }, op, hash)).toThrow(/expired/);
  });
});

describe("first payment delegation", () => {
  const fresh = {
    ...quote,
    requiresDelegation: true,
    maxWethWei: "61912579315016",
    maxGasMicroUsdc: "15577",
    swapOutputMicroUsdc: "15578",
  };
  const authorization = {
    address: paymentContracts.delegate,
    chainId: 84532,
    nonce: 0,
    yParity: 1,
    r: "0xe8064703a36cfb1fe5e70ddcd66e051dfaaea10e1673e63a2e12f523a7f55972",
    s: "0x5891822a135f294de01e40168136ef5a0834a7029c06078bed98628d0e0b2ece",
  } as const;
  const rpcAuth = { ...authorization, chainId: "0x14a34", nonce: "0x0", yParity: "0x1" };
  const firstOp = {
    ...op,
    nonce: "0x0",
    callData: paymentBatch(fresh),
    factory: "0x7702",
    factoryData: "0x",
    eip7702Auth: rpcAuth,
    paymasterData:
      "0x020000006b05f0e4000000000000036cbd53842c5426634e7929541ec2318f3dcf7e00000000000000000000000000004a2e000000000000000000000000000000000000000000000000000000006d853b4b00000000000000000000000000017700d8baa107006c93a030d1455a2ef43261b384f21c1a43c5c9203fddf7c3824f04bb37643b5b4fda25a33e974cd77efdb65054ffe23d99518989245350de4141ca842cf57b75ce68190a76c31d4811df0a86634bd11c",
    callGasLimit: "0x6ddd0",
    verificationGasLimit: "0x222e0",
    preVerificationGas: "0x23668",
    paymasterVerificationGasLimit: "0x1d4c0",
    paymasterPostOpGasLimit: "0x186a0",
  };
  const firstHash = "0x11b235e75365fed903f353294de6811ba4fcae25e3906a953fef76a517881515";
  it("matches the settled first-payment signature request", () => {
    expect(hashTypedData(paymentSignatureRequest(fresh, firstOp, firstHash, authorization))).toBe(
      firstHash,
    );
  });
  it.each([
    { nonce: "0x1" },
    { address: quote.sender },
    { chainId: "0x1" },
    { r: authorization.s },
  ])("rejects changed authorization fields", (change) => {
    expect(() =>
      paymentSignatureRequest(
        fresh,
        { ...firstOp, eip7702Auth: { ...rpcAuth, ...change } },
        firstHash,
        authorization,
      ),
    ).toThrow(/authorization/);
  });
});
