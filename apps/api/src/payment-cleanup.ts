import {
  cleanupDomainHash,
  cleanupOwnerRequest,
  cleanupRelayRequest,
  cleanupTypedData,
  EvmAddress,
  paymentContracts,
} from "@swapchan/shared";
import {
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  parseAbi,
  recoverTypedDataAddress,
} from "viem";
import { z } from "zod";

import { estimateOriginFees } from "./payment-origin-fees.js";

const { usdc, paymaster } = paymentContracts;
const abi = parseAbi([
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function nonces(address) view returns (uint256)",
]);
export const cleanupInput = z
  .object({
    owner: EvmAddress,
    relayer: EvmAddress,
    signed: z
      .object({
        deadline: z.number().int().positive(),
        nonce: z.string().regex(/^\d+$/),
        signature: z.string().regex(/^0x[0-9a-f]{130}$/i),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => v.owner.toLowerCase() !== v.relayer.toLowerCase());
export async function paymasterCleanup(
  rpc: (m: string, p: unknown[]) => Promise<unknown>,
  i: z.infer<typeof cleanupInput>,
) {
  const block = z
    .string()
    .regex(/^0x[0-9a-f]+$/i)
    .parse(await rpc("eth_blockNumber", []));
  const call = async (data: Hex) =>
    z
      .string()
      .regex(/^0x([0-9a-f]{2})*$/i)
      .parse(await rpc("eth_call", [{ to: usdc, data }, block])) as Hex;
  const allowanceData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "allowance",
    args: [i.owner, paymaster],
  });
  const allowance = decodeFunctionResult({
    abi: erc20Abi,
    functionName: "allowance",
    data: await call(allowanceData),
  });
  if (!allowance) return { status: "already_revoked", block, remainingMicroUsdc: "0" };
  if (
    (await call(encodeFunctionData({ abi, functionName: "DOMAIN_SEPARATOR" }))) !==
    cleanupDomainHash
  )
    throw Error("Unsupported USDC permit domain");
  const nonce = decodeFunctionResult({
    abi,
    functionName: "nonces",
    data: await call(encodeFunctionData({ abi, functionName: "nonces", args: [i.owner] })),
  });
  const now = Math.floor(Date.now() / 1000),
    deadline = i.signed?.deadline ?? now + 300;
  if (deadline <= now || deadline > now + 300 || (i.signed && i.signed.nonce !== String(nonce)))
    throw Error("Expired or consumed permit");
  const review = {
    block,
    remainingMicroUsdc: String(allowance),
    nonce: String(nonce),
    deadline,
    owner: i.owner,
    relayer: i.relayer,
    spender: paymaster,
    token: usdc,
    chainId: 84532,
  };
  if (!i.signed)
    return {
      ...review,
      status: "owner_signature_required",
      walletRequest: cleanupOwnerRequest(i.owner, String(nonce), deadline),
    };
  const signature = i.signed.signature as Hex;
  if (
    (
      await recoverTypedDataAddress({
        ...cleanupTypedData(i.owner, String(nonce), deadline),
        signature,
      })
    ).toLowerCase() !== i.owner.toLowerCase()
  )
    throw Error("Wrong permit signer");
  const walletRequest = cleanupRelayRequest(i.owner, i.relayer, deadline, signature);
  const { chainId: _, ...tx } = walletRequest.params[0];
  const [result] = z
    .tuple([
      z.object({
        calls: z.tuple([
          z.object({ status: z.literal("0x1"), gasUsed: z.string().regex(/^0x[0-9a-f]+$/i) }),
          z.object({ status: z.literal("0x1"), returnData: z.string().regex(/^0x0{64}$/) }),
        ]),
      }),
    ])
    .parse(
      await rpc("eth_simulateV1", [
        {
          blockStateCalls: [{ calls: [tx, { from: i.relayer, to: usdc, data: allowanceData }] }],
          validation: false,
        },
        block,
      ]),
    );
  const [fee, balance] = await Promise.all([
    estimateOriginFees(rpc, 84532, block, i.relayer, [
      { to: usdc, data: tx.data, gas: BigInt(result.calls[0].gasUsed) },
    ]),
    rpc("eth_getBalance", [i.relayer, block]).then((v) =>
      BigInt(
        z
          .string()
          .regex(/^0x[0-9a-f]+$/i)
          .parse(v),
      ),
    ),
  ]);
  if (balance < BigInt(fee.totalWei)) throw Error("Relayer has insufficient native gas");
  return {
    ...review,
    status: "relayer_transaction_ready",
    estimatedRelayerFeeWei: fee.totalWei,
    simulatedRemainingMicroUsdc: String(BigInt(result.calls[1].returnData)),
    walletRequest,
  };
}
