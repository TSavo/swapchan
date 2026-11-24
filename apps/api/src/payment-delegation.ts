import { paymentContracts } from "@swapchan/shared";
import { type Hex, keccak256, zeroAddress } from "viem";
import { z } from "zod";

const bytes = z
  .string()
  .regex(/^0x(?:[0-9a-f]{2})*$/i)
  .transform((value) => value as Hex);
// Simple7702Account runtime used by the Base Sepolia acceptance payments.
export const simpleAccountRuntimeHash =
  "0x82c1e6c0f83d22eef579344e8eff26baf24db4dabe5408d681b00d0512bc3ec4";
type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

export async function inspectDelegation(rpc: Rpc, sender: string, proposedDelegate?: string) {
  const block = z
    .string()
    .regex(/^0x[0-9a-f]+$/i)
    .parse(await rpc("eth_blockNumber", []));
  const [rawCode, rawNonce] = await Promise.all([
    rpc("eth_getCode", [sender, block]),
    rpc("eth_getTransactionCount", [sender, block]),
  ]);
  const code = bytes.parse(rawCode).toLowerCase();
  const nonce = BigInt(
    z
      .string()
      .regex(/^0x[0-9a-f]+$/i)
      .parse(rawNonce),
  ).toString();
  const current = /^0xef0100[0-9a-f]{40}$/.test(code) ? "0x" + code.slice(8) : null;
  const accountType = current ? "delegated" : code === "0x" ? "undelegated" : "contract";
  async function inspect(address: string) {
    const runtime = bytes.parse(await rpc("eth_getCode", [address, block]));
    const codeHash = keccak256(runtime);
    const known =
      address.toLowerCase() === paymentContracts.delegate.toLowerCase() &&
      codeHash === simpleAccountRuntimeHash;
    return {
      address,
      codeHash,
      known,
      sessionKeyScope: known ? "No session key is issued by the Swapchan payment flow." : "Unknown",
    };
  }
  const existing = current ? await inspect(current) : null;
  const proposed = !proposedDelegate
    ? null
    : proposedDelegate.toLowerCase() === zeroAddress
      ? { address: zeroAddress, action: "revoke" }
      : current === proposedDelegate.toLowerCase()
        ? existing
        : await inspect(proposedDelegate);
  return {
    chainId: 84532,
    sender,
    blockNumber: block,
    accountType,
    existing,
    proposed,
    revocation: current
      ? {
          chainId: 84532,
          address: zeroAddress,
          nonce,
          instruction:
            "Refresh the nonce before signing. Include the signed authorization in a set-code transaction to clear delegation.",
        }
      : null,
  };
}
