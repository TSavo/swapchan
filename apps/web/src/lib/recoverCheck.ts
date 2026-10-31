const ZERO = "0x0000000000000000000000000000000000000000";
const eq = (a: unknown, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase() && a.toLowerCase() !== ZERO;

/** For a locally decoded recovery call: does every address argument that controls where funds go
 * (or whose funds move) equal the connected wallet? Fail closed: no wallet or unknown shape = false. */
export function localCallPaysOwner(
  call: { functionName: string; args?: readonly unknown[] } | undefined,
  owner: string | undefined,
): boolean {
  if (!call || !owner) return false;
  const a = call.args ?? [];
  switch (call.functionName) {
    case "redeem": // redeem(shares, receiver, owner)
      return eq(a[1], owner) && eq(a[2], owner);
    case "claimComp":
    case "claimVenus": // claim(holder)
      return eq(a[0], owner);
    case "collect": {
      const p = a[0] as { recipient?: unknown } | undefined;
      return eq(p?.recipient, owner);
    }
    // No receiver argument: pays msg.sender (withdrawToken's address is the token, not a payee).
    case "withdraw":
    case "exit":
    case "getReward":
    case "claim": // claim() pays msg.sender; merkle claim(index, account, amount, proof) pays account
      return a.length === 0 || (a.length === 4 && eq(a[1], owner));
    case "claimRewards":
    case "withdrawToken":
    case "claimWithdrawal":
    case "claimCollateral":
      return true;
    default:
      return false;
  }
}

/** The /recover link was built for `scanOwner`; signing is only allowed from that wallet. */
export function ownerMatches(scanOwner: string | undefined, connected: string | undefined): boolean {
  return eq(scanOwner, connected ?? ZERO) && eq(connected, scanOwner ?? ZERO);
}
