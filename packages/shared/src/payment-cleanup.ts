import {
  type Address,
  encodeFunctionData,
  type Hex,
  hashDomain,
  parseAbi,
  parseSignature,
} from "viem";
import { paymentContracts } from "./payment-batch.js";

const domainTypes = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;
const permit = [
  { name: "owner", type: "address" },
  { name: "spender", type: "address" },
  { name: "value", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
] as const;

const domain = {
  name: "USDC",
  version: "2",
  chainId: 84532,
  verifyingContract: paymentContracts.usdc,
} as const;
export const cleanupDomainHash = hashDomain({
  domain: { ...domain, chainId: 84532n },
  types: { EIP712Domain: domainTypes },
});
export function cleanupTypedData(owner: Address, nonce: string, deadline: number) {
  return {
    domain,
    primaryType: "Permit",
    types: { Permit: permit },
    message: {
      owner,
      spender: paymentContracts.paymaster,
      value: 0n,
      nonce: BigInt(nonce),
      deadline: BigInt(deadline),
    },
  } as const;
}
export function cleanupOwnerRequest(owner: Address, nonce: string, deadline: number) {
  const typed = cleanupTypedData(owner, nonce, deadline);
  return {
    method: "eth_signTypedData_v4",
    params: [
      owner,
      JSON.stringify(
        { ...typed, types: { ...typed.types, EIP712Domain: domainTypes } },
        (_key, value) => (typeof value === "bigint" ? String(value) : value),
      ),
    ],
  };
}
export function cleanupRelayRequest(
  owner: Address,
  relayer: Address,
  deadline: number,
  signature: Hex,
) {
  const { yParity, r, s } = parseSignature(signature);
  const data = encodeFunctionData({
    abi: parseAbi(["function permit(address,address,uint256,uint256,uint8,bytes32,bytes32)"]),
    functionName: "permit",
    args: [owner, paymentContracts.paymaster, 0n, BigInt(deadline), 27 + yParity!, r, s],
  });
  return {
    method: "eth_sendTransaction",
    params: [{ from: relayer, to: paymentContracts.usdc, value: "0x0", chainId: "0x14a34", data }],
  } as const;
}
