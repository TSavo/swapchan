import { type Address, encodeFunctionData, erc20Abi, type Hex, parseAbi } from "viem";
import { checkCircleBurn, circleMessenger } from "./circle-payment.js";

export const paymentContracts = {
  weth: "0x4200000000000000000000000000000000000006",
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  router: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
  paymaster: "0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402",
  delegate: "0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9",
  entry: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
} as const;
const { weth, usdc, router, paymaster } = paymentContracts;
export const paymentDelegationNotice = {
  permission:
    "Simple7702Account can execute authorized calls from this account. The delegation stays active after this payment.",
  revoke:
    "To clear it, sign a Base Sepolia authorization for the zero address and include it in a set-code transaction. After inclusion, check that the account code is empty.",
} as const;
const routerAbi = parseAbi([
  "function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountIn)",
]);
export const batchAbi = parseAbi([
  "function executeBatch((address target,uint256 value,bytes data)[] calls)",
]);
export type PaymentQuote = {
  chainId: 84532;
  sender: Address;
  recipient: Address;
  amountMicroUsdc: string;
  expiresAt: number;
  maxGasMicroUsdc: string;
  maxWethWei: string;
  wrapNativeWei?: string;
  swapOutputMicroUsdc: string;
  requiresDelegation: boolean;
  authorizationNonce?: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  circle?: {
    destinationChainId: 11155420;
    burnData: Hex;
    burnDataHash: Hex;
    maxInputMicroUsdc: string;
  };
};
/** Gas ceilings used for both quoting and signing on Base Sepolia. */
export function paymentGasLimits(direct: boolean, circle = false) {
  return {
    callGasLimit: circle ? 700000n : direct ? 80000n : 450000n,
    verificationGasLimit: direct ? 70000n : 140000n,
    preVerificationGas: circle ? 2400000n : direct ? 90000n : 145000n,
    paymasterVerificationGasLimit: direct ? 85000n : 120000n,
    paymasterPostOpGasLimit: direct ? 90000n : 100000n,
  };
}
/** Reconstruct the same batch from the reviewed quote on client and server. */
export function paymentBatch(q: PaymentQuote) {
  const calls: { target: Address; value: bigint; data: Hex }[] = [];
  const add = (target: Address, data: Hex) => calls.push({ target, value: 0n, data });
  const approve = (token: Address, spender: Address, cap: bigint) =>
    add(
      token,
      encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, cap] }),
    );
  const spend = BigInt(q.maxWethWei),
    output = BigInt(q.swapOutputMicroUsdc);
  const wrap = BigInt(q.wrapNativeWei ?? "0");
  if (wrap < 0n || wrap > spend) throw Error("Native wrap exceeds the reviewed WETH spend");
  if ((spend === 0n) !== (output === 0n)) throw new Error("inconsistent swap limits");
  if (output) {
    if (wrap > 0n)
      calls.push({
        target: weth,
        value: wrap,
        data: encodeFunctionData({
          abi: parseAbi(["function deposit() payable"]),
          functionName: "deposit",
        }),
      });
    approve(weth, router, spend);
    add(
      router,
      encodeFunctionData({
        abi: routerAbi,
        functionName: "exactOutputSingle",
        args: [
          {
            tokenIn: weth,
            tokenOut: usdc,
            fee: 3000,
            recipient: q.sender,
            amountOut: output,
            amountInMaximum: spend,
            sqrtPriceLimitX96: 0n,
          },
        ],
      }),
    );
    approve(weth, router, 0n);
  }
  if (q.circle) {
    if (
      q.circle.destinationChainId !== 11155420 ||
      BigInt(q.circle.maxInputMicroUsdc) < BigInt(q.amountMicroUsdc)
    )
      throw Error("Invalid Circle destination or spend");
    checkCircleBurn(q.circle.burnData, { ...q, burnDataHash: q.circle.burnDataHash });
    approve(usdc, circleMessenger, BigInt(q.circle.maxInputMicroUsdc));
    add(circleMessenger, q.circle.burnData);
  } else {
    add(
      usdc,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [q.recipient, BigInt(q.amountMicroUsdc)],
      }),
    );
  }
  // Overwrite residual allowance so the fee pull for this operation is bounded.
  approve(usdc, paymaster, BigInt(q.maxGasMicroUsdc));
  return encodeFunctionData({ abi: batchAbi, functionName: "executeBatch", args: [calls] });
}
