import {
  type Address,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  pad,
  parseAbi,
} from "viem";

const sourceToken = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const destinationToken = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const pool = "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64";
export const acrossBaseRoute = {
  sourceToken,
  destinationToken,
  pool,
  destinationPool: "0x6f26bf09b1c792e3228e5467807a900a503c0281",
} as const;
const deposit = parseAbi([
  "function deposit(bytes32 depositor,bytes32 recipient,bytes32 inputToken,bytes32 outputToken,uint256 inputAmount,uint256 outputAmount,uint256 destinationChainId,bytes32 exclusiveRelayer,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,bytes message)",
]);

export function checkAcrossDeposit(
  tx: { to: string; data: Hex; value?: string | undefined },
  intent: {
    sender: Address;
    recipient: Address;
    amountMicroUsdc: string;
    maxInputMicroUsdc: string;
    expiresAt: number;
  },
) {
  const { args } = decodeFunctionData({ abi: deposit, data: tx.data as Hex });
  const [sender, recipient, tokenIn, tokenOut, amountIn, amountOut, destination, , , , , message] =
    args;
  const canonical = encodeFunctionData({
    abi: deposit,
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
    destination !== 10n ||
    message !== "0x" ||
    amountOut !== BigInt(intent.amountMicroUsdc) ||
    amountIn <= 0n ||
    amountIn > BigInt(intent.maxInputMicroUsdc) ||
    args[9] <= now ||
    intent.expiresAt <= now
  )
    throw Error("Cross-chain deposit differs from payment intent or has expired");
  return { amountIn, fillDeadline: args[9] };
}
export function checkAcrossApproval(
  tx: { to: string; data: Hex; value?: string | undefined },
  cap: string,
) {
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
