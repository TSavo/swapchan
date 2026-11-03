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

/**
 * The Tron, Solana and sweep /recover forms (?tron=, ?sol=, ?sweep=) are signed the same way: the HMAC covers
 * the form kind and every param the page renders (the owner is inside the tron/sol spec and is `from` for a
 * sweep). Same key; the web verifier (apps/web/src/lib/recoverSig.ts) uses the same payload and fails closed.
 */
export const RECOVER_FORMS = {
  tron: ["tron", "title"],
  sol: ["sol", "title"],
  sweep: ["sweep", "coin", "from", "sym", "token", "title"],
} as const;
export type RecoverForm = keyof typeof RECOVER_FORMS;

export function recoverFormPayload(
  form: RecoverForm,
  q: Partial<Record<string, string | null | undefined>>,
): string {
  return ["swapchan-recover-form-v1", form, ...RECOVER_FORMS[form].map((k) => `${k}=${q[k] ?? ""}`)].join(
    "\n",
  );
}

export function signRecoverForm(
  form: RecoverForm,
  q: Partial<Record<string, string | null | undefined>>,
  secret: string | undefined = process.env.SWAPCHAN_RECOVER_LINK_SECRET,
): string | undefined {
  if (!secret) return undefined;
  return createHmac("sha256", secret).update(recoverFormPayload(form, q)).digest("hex");
}

/** Which signed form a /recover URL is, in the order the page checks them; null for a plain /recover. */
export function recoverForm(q: URLSearchParams): RecoverForm | "to" | null {
  for (const f of ["tron", "sol", "sweep"] as const) if (q.has(f)) return f;
  return q.has("to") ? "to" : null;
}

/** True only for a /recover?to=&data= (or ?tron=, ?sol=, ?sweep=) URL whose sig matches; missing secret, params or sig = false. */
export function recoverUrlSigned(
  u: URL,
  secret: string | undefined = process.env.SWAPCHAN_RECOVER_LINK_SECRET,
): boolean {
  const q = u.searchParams;
  const form = recoverForm(q);
  if (form && form !== "to") {
    const sig = q.get(RECOVER_SIG_PARAM);
    const want = signRecoverForm(form, Object.fromEntries(q), secret);
    return !!want && !!sig && want.length === sig.length && sameHex(want, sig);
  }
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
