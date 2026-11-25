import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  keccak256,
  pad,
  parseAbi,
  zeroHash,
} from "viem";
import { acrossTestRoute } from "./across-payment.js";
import { batchAbi } from "./payment-batch.js";
export const circleMessenger = "0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A";
export const circleBurnAbi = parseAbi([
  "function depositForBurnWithFees(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,(bytes signedQuote,address refundAddress) claim) payable",
]);

export function checkCircleBurn(
  calldata: Hex,
  i: { sender: Hex; recipient: Hex; amountMicroUsdc: string; burnDataHash: string | undefined },
) {
  const {
    args: [paid, domain, to, token, caller, claim],
  } = decodeFunctionData({ abi: circleBurnAbi, data: calldata });
  if (
    keccak256(calldata) !== i.burnDataHash ||
    claim.signedQuote === "0x" ||
    paid !== BigInt(i.amountMicroUsdc) ||
    domain !== 2 ||
    to !== pad(i.recipient).toLowerCase() ||
    token.toLowerCase() !== acrossTestRoute.sourceToken.toLowerCase() ||
    caller !== zeroHash ||
    claim.refundAddress.toLowerCase() !== i.sender.toLowerCase()
  )
    throw Error("Burn differs from intent");
  return paid;
}

export function checkCircleBatch(
  data: Hex,
  intent: Parameters<typeof checkCircleBurn>[1] & { maxInputMicroUsdc: string },
) {
  const { args } = decodeFunctionData({ abi: batchAbi, data });
  const [approval, burn] = args[0];
  if (
    args[0].length !== 2 ||
    !approval ||
    !burn ||
    approval.target.toLowerCase() !== acrossTestRoute.sourceToken.toLowerCase() ||
    burn.target.toLowerCase() !== circleMessenger.toLowerCase() ||
    approval.value !== 0n ||
    burn.value !== 0n ||
    approval.data.toLowerCase() !==
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [circleMessenger, BigInt(intent.maxInputMicroUsdc)],
      }).toLowerCase() ||
    data.toLowerCase() !==
      encodeFunctionData({ abi: batchAbi, functionName: "executeBatch", args }).toLowerCase()
  )
    throw Error("Circle batch differs from the saved payment.");
  return checkCircleBurn(burn.data, intent);
}
