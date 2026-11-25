import {
  type Address,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  pad,
  parseAbi,
} from "viem";
import { batchAbi } from "./payment-batch.js";

const sourceToken = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const destinationToken = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const pool = "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64";
export const acrossBaseRoute = {
  origin: 8453,
  destination: 10,
  api: "https://app.across.to/api",
  sourceToken,
  destinationToken,
  pool,
  destinationPool: "0x6f26bf09b1c792e3228e5467807a900a503c0281",
} as const;
export const acrossTestRoute = {
  origin: 84532,
  destination: 11155420,
  api: "https://testnet.across.to/api",
  sourceToken: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  destinationToken: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7",
  pool: "0x82B564983aE7274c86695917BBf8C99ECb6F0F8F",
  destinationPool: "0x4e8E101924eDE233C13e2D8622DC8aED2872d505",
} as const;
export function acrossRoute(destination: number) {
  if (destination === 10) return acrossBaseRoute;
  if (destination === 11155420) return acrossTestRoute;
  throw Error("Unsupported Across destination");
}
export const acrossDepositAbi = parseAbi([
  "function deposit(bytes32 depositor,bytes32 recipient,bytes32 inputToken,bytes32 outputToken,uint256 inputAmount,uint256 outputAmount,uint256 destinationChainId,bytes32 exclusiveRelayer,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,bytes message)",
]);

export function checkAcrossDeposit(
  tx: { to: string; data: Hex; value?: string | undefined },
  intent: {
    chainId?: number;
    sender: Address;
    recipient: Address;
    amountMicroUsdc: string;
    maxInputMicroUsdc: string;
    expiresAt: number;
    fillDeadline?: number | undefined;
  },
) {
  const route = acrossRoute(intent.chainId ?? 10);
  const { sourceToken, destinationToken, pool } = route;
  const { args } = decodeFunctionData({ abi: acrossDepositAbi, data: tx.data as Hex });
  const [sender, recipient, tokenIn, tokenOut, amountIn, amountOut, destination, , , , , message] =
    args;
  const canonical = encodeFunctionData({
    abi: acrossDepositAbi,
    functionName: "deposit",
    args,
  }).toLowerCase();
  const data = tx.data.toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  if (
    (data !== canonical && data !== canonical + "1dc0de000073c0de") ||
    tx.to.toLowerCase() !== pool.toLowerCase() ||
    BigInt(tx.value ?? 0) !== 0n ||
    sender.toLowerCase() !== pad(intent.sender).toLowerCase() ||
    recipient.toLowerCase() !== pad(intent.recipient).toLowerCase() ||
    tokenIn.toLowerCase() !== pad(sourceToken).toLowerCase() ||
    tokenOut.toLowerCase() !== pad(destinationToken).toLowerCase() ||
    destination !== BigInt(route.destination) ||
    message !== "0x" ||
    amountOut !== BigInt(intent.amountMicroUsdc) ||
    amountIn <= 0n ||
    amountIn > BigInt(intent.maxInputMicroUsdc) ||
    args[9] <= now ||
    (intent.fillDeadline !== undefined && args[9] !== intent.fillDeadline) ||
    intent.expiresAt <= now
  )
    throw Error("Cross-chain deposit differs from payment intent or has expired");
  return { amountIn, fillDeadline: args[9] };
}
export function checkAcrossApproval(
  tx: { to: string; data: Hex; value?: string | undefined },
  cap: string,
  destination = 10,
) {
  const { sourceToken, pool } = acrossRoute(destination);
  const expected = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [pool, BigInt(cap)],
  });
  if (
    BigInt(cap) <= 0n ||
    tx.to.toLowerCase() !== sourceToken.toLowerCase() ||
    BigInt(tx.value ?? 0) !== 0n ||
    expected.toLowerCase() !== tx.data.toLowerCase()
  )
    throw Error("Approval differs from the review");
}

/** Independently check the exact two calls an already delegated account will execute. */
export function checkAcrossAtomicOrigin(
  tx: { from: string; to: string; data: Hex; value: string; chainId: number },
  intent: Parameters<typeof checkAcrossDeposit>[1],
  approvalCap: string,
) {
  if (
    intent.chainId !== 11155420 ||
    tx.chainId !== 84532 ||
    tx.from.toLowerCase() !== intent.sender.toLowerCase() ||
    tx.to.toLowerCase() !== intent.sender.toLowerCase() ||
    BigInt(tx.value) !== 0n
  )
    throw Error("Unexpected origin batch account or chain");
  const { args } = decodeFunctionData({ abi: batchAbi, data: tx.data });
  const [approval, deposit] = args[0];
  if (
    args[0].length !== 2 ||
    !approval ||
    !deposit ||
    encodeFunctionData({ abi: batchAbi, functionName: "executeBatch", args }).toLowerCase() !==
      tx.data.toLowerCase()
  )
    throw Error("Unexpected origin batch calldata");
  const { amountIn } = checkAcrossDeposit(
    { to: deposit.target, data: deposit.data, value: String(deposit.value) },
    intent,
  );
  if (amountIn > BigInt(approvalCap)) throw Error("Origin batch approval exceeds review");
  checkAcrossApproval(
    { to: approval.target, data: approval.data, value: String(approval.value) },
    String(amountIn),
    intent.chainId,
  );
}
