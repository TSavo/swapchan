import { createHmac } from "node:crypto";

/**
 * HMAC for /recover?to=&data= links. Signs chain, to, data, title and owner (the wallet the scan was for), so a
 * /recover URL can only show "I found your money" for a call SwapChan itself built. The web page verifies the same
 * HMAC (apps/web/src/lib/recoverSig.ts) and fails closed. Key: env SWAPCHAN_RECOVER_LINK_SECRET (unset = no sig).
 */
export const RECOVER_SIG_PARAM = "sig";

export function recoverSigPayload(p: {
  chain: string | number;
  to: string;
  data: string;
  title: string;
  owner: string;
}): string {
  return [
    "swapchan-recover-v1",
    String(p.chain),
    p.to.toLowerCase(),
    p.data.toLowerCase(),
    p.title,
    p.owner.toLowerCase(),
  ].join("\n");
}

export function signRecover(
  p: Parameters<typeof recoverSigPayload>[0],
  secret: string | undefined = process.env.SWAPCHAN_RECOVER_LINK_SECRET,
): string | undefined {
  if (!secret) return undefined;
  return createHmac("sha256", secret).update(recoverSigPayload(p)).digest("hex");
}

/** True only for a /recover?to=&data= URL whose sig matches; missing secret, params or sig = false. */
export function recoverUrlSigned(
  u: URL,
  secret: string | undefined = process.env.SWAPCHAN_RECOVER_LINK_SECRET,
): boolean {
  const q = u.searchParams;
  const to = q.get("to");
  const data = q.get("data");
  const owner = q.get("owner");
  const sig = q.get(RECOVER_SIG_PARAM);
  if (!secret || !to || !data || !owner || !sig) return false;
  const want = signRecover(
    { chain: q.get("chain") ?? "1", to, data, title: q.get("title") ?? "", owner },
    secret,
  );
  return !!want && want.length === sig.length && sameHex(want, sig);
}

function sameHex(a: string, b: string) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
