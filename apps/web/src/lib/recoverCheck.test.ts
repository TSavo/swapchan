import { decodeFunctionData, encodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { localCallPaysOwner, ownerMatches } from "./recoverCheck";

const ME = "0x1111111111111111111111111111111111111111";
const EVIL = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";
const abi = parseAbi([
  "function withdraw()",
  "function redeem(uint256 shares, address receiver, address owner)",
  "function claimComp(address holder)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params)",
]);
const dec = (fn: string, args: unknown[]) =>
  decodeFunctionData({
    abi,
    data: encodeFunctionData({ abi, functionName: fn as any, args: args as any }),
  });

describe("localCallPaysOwner (audit: /recover signable for foreign receivers)", () => {
  it("allows calls that pay the connected wallet", () => {
    expect(localCallPaysOwner(dec("withdraw", []), ME)).toBe(true);
    expect(localCallPaysOwner(dec("redeem", [1n, ME, ME]), ME)).toBe(true);
    expect(localCallPaysOwner(dec("claimComp", [ME]), ME)).toBe(true);
    expect(
      localCallPaysOwner(
        dec("collect", [{ tokenId: 1n, recipient: ME, amount0Max: 1n, amount1Max: 1n }]),
        ME,
      ),
    ).toBe(true);
  });
  it("rejects foreign or zero receivers and no wallet", () => {
    expect(localCallPaysOwner(dec("redeem", [1n, EVIL, ME]), ME)).toBe(false);
    expect(localCallPaysOwner(dec("redeem", [1n, ME, EVIL]), ME)).toBe(false);
    expect(localCallPaysOwner(dec("claimComp", [EVIL]), ME)).toBe(false);
    expect(
      localCallPaysOwner(
        dec("collect", [{ tokenId: 1n, recipient: EVIL, amount0Max: 1n, amount1Max: 1n }]),
        ME,
      ),
    ).toBe(false);
    expect(
      localCallPaysOwner(
        dec("collect", [{ tokenId: 1n, recipient: ZERO, amount0Max: 1n, amount1Max: 1n }]),
        ME,
      ),
    ).toBe(false);
    expect(localCallPaysOwner(dec("withdraw", []), undefined)).toBe(false);
    expect(localCallPaysOwner(undefined, ME)).toBe(false);
  });
});

describe("Bloqarl #3: scan owner + merkle claim", () => {
  const m = parseAbi([
    "function claim(uint256 index, address account, uint256 amount, bytes32[] merkleProof)",
  ]);
  const P = `0x${"ab".repeat(32)}` as const;
  const mdec = (acct: string) =>
    decodeFunctionData({
      abi: m,
      data: encodeFunctionData({ abi: m, functionName: "claim", args: [1n, acct as `0x${string}`, 5n, [P]] }),
    });
  it("recognizes a merkle claim paying the connected wallet", () => {
    expect(localCallPaysOwner(mdec(ME), ME)).toBe(true);
  });
  it("rejects a merkle claim for another account", () => {
    expect(localCallPaysOwner(mdec(EVIL), ME)).toBe(false);
  });
  it("signing only from the wallet the scan was for", () => {
    expect(ownerMatches(ME, ME.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(ownerMatches(ME, EVIL)).toBe(false);
    expect(ownerMatches(undefined, ME)).toBe(false);
    expect(ownerMatches(ME, undefined)).toBe(false);
  });
});
