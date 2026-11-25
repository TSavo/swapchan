import { getTypesForEIP712Domain, type Hex, hashTypedData, type SignedAuthorization } from "viem";
import { getUserOperationTypedData } from "viem/account-abstraction";
import { z } from "zod";
import {
  paymentContracts as c,
  type PaymentQuote,
  paymentBatch,
  paymentGasLimits,
} from "./payment-batch.js";

const bytes = z
  .string()
  .regex(/^0x(?:[0-9a-f]{2})*$/i)
  .transform((x) => x as Hex);
const quantity = z
  .string()
  .regex(/^0x[0-9a-f]{1,64}$/i)
  .transform(BigInt);
const operation = z
  .object({
    sender: z.string(),
    nonce: quantity,
    callData: bytes,
    callGasLimit: quantity,
    verificationGasLimit: quantity,
    preVerificationGas: quantity,
    maxFeePerGas: quantity,
    maxPriorityFeePerGas: quantity,
    paymaster: z.string(),
    paymasterData: bytes,
    paymasterVerificationGasLimit: quantity,
    paymasterPostOpGasLimit: quantity,
    factory: z.literal("0x7702").optional(),
    factoryData: z.literal("0x").optional(),
    eip7702Auth: z
      .object({
        chainId: quantity,
        address: z.string(),
        nonce: quantity,
        yParity: quantity,
        r: bytes,
        s: bytes,
      })
      .strict()
      .optional(),
  })
  .strict();

/** Construct the signature request locally from the human-reviewed quote and simulated operation. */
export function paymentSignatureRequest(
  q: PaymentQuote,
  raw: unknown,
  expectedHash: string,
  authorization?: SignedAuthorization,
) {
  const op = operation.parse(raw);
  const auth = op.eip7702Auth;
  if (
    Boolean(auth) !== Boolean(authorization) ||
    (authorization &&
      auth &&
      (auth.address.toLowerCase() !== authorization.address.toLowerCase() ||
        auth.chainId !== BigInt(authorization.chainId) ||
        auth.nonce !== BigInt(authorization.nonce) ||
        auth.yParity !== BigInt(authorization.yParity ?? -1) ||
        auth.r.toLowerCase() !== authorization.r.toLowerCase() ||
        auth.s.toLowerCase() !== authorization.s.toLowerCase()))
  )
    throw new Error("Operation delegation differs from the reviewed authorization.");
  const limits = paymentGasLimits(
    !q.circle && !q.requiresDelegation && q.maxWethWei === "0",
    Boolean(q.circle),
  );
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    if (op[key] > limits[key]) throw new Error("Operation exceeds the reviewed gas limits.");
  }
  if (q.expiresAt <= Date.now() / 1000) throw new Error("Quote expired. Request a fresh quote.");
  if (
    q.chainId !== 84532 ||
    op.sender.toLowerCase() !== q.sender.toLowerCase() ||
    op.paymaster.toLowerCase() !== c.paymaster.toLowerCase() ||
    op.callData !== paymentBatch(q) ||
    op.maxFeePerGas !== BigInt(q.maxFeePerGas) ||
    op.maxPriorityFeePerGas !== BigInt(q.maxPriorityFeePerGas) ||
    q.requiresDelegation !== Boolean(op.factory) ||
    q.requiresDelegation !== Boolean(authorization) ||
    (authorization &&
      (authorization.address.toLowerCase() !== c.delegate.toLowerCase() ||
        authorization.chainId !== 84532))
  )
    throw new Error("Operation differs from the reviewed payment.");
  const typed = getUserOperationTypedData({
    chainId: 84532,
    entryPointAddress: c.entry,
    userOperation: {
      ...op,
      sender: q.sender,
      paymaster: c.paymaster,
      signature: "0x",
      ...(authorization ? { factory: "0x7702", factoryData: "0x", authorization } : {}),
    },
  });
  if (hashTypedData(typed) !== expectedHash)
    throw new Error("Payment hash differs from the simulated operation.");
  return typed;
}

/** eth_signTypedData_v4 needs the domain declaration in the actual JSON sent to the wallet. */
export function paymentWalletPayload(
  typed: ReturnType<typeof paymentSignatureRequest>,
  expectedHash: string,
) {
  const payload = JSON.stringify(
    {
      ...typed,
      types: { ...typed.types, EIP712Domain: getTypesForEIP712Domain({ domain: typed.domain }) },
    },
    (_key, value) => (typeof value === "bigint" ? String(value) : value),
  );
  if (hashTypedData(JSON.parse(payload)) !== expectedHash)
    throw Error("Serialized wallet request differs from the verified operation.");
  return payload;
}
