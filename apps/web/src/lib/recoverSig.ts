import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Server-side check of the HMAC the API puts on /recover?to=&data= links (apps/api/src/recoverSig.ts: same payload).
 * Fails closed: no secret (env SWAPCHAN_RECOVER_LINK_SECRET), no owner or no/invalid sig = not verified.
 */
export function recoverSigPayload(p: {
  chain: string;
  to: string;
  data: string;
  title: string;
  owner: string;
}): string {
  return [
    "swapchan-recover-v1",
    p.chain,
    p.to.toLowerCase(),
    p.data.toLowerCase(),
    p.title,
    p.owner.toLowerCase(),
  ].join("\n");
}

export function verifyRecoverSig(
  q: Record<string, string | undefined>,
  secret: string | undefined = process.env.SWAPCHAN_RECOVER_LINK_SECRET,
): boolean {
  if (!secret || !q.to || !q.data || !q.owner || !q.sig) return false;
  if (!/^[0-9a-f]{64}$/.test(q.sig)) return false;
  const want = createHmac("sha256", secret)
    .update(
      recoverSigPayload({
        chain: q.chain ?? "1",
        to: q.to,
        data: q.data,
        title: q.title ?? "",
        owner: q.owner,
      }),
    )
    .digest();
  return timingSafeEqual(want, Buffer.from(q.sig, "hex"));
}

/** Same as apps/api/src/recoverSig.ts RECOVER_FORMS: the params signed for the ?tron=, ?sol= and ?sweep= forms. */
export const RECOVER_FORMS = {
  tron: ["tron", "title"],
  sol: ["sol", "title"],
  sweep: ["sweep", "coin", "from", "sym", "token", "title"],
} as const;
export type RecoverForm = keyof typeof RECOVER_FORMS;

export function recoverFormPayload(
  form: RecoverForm,
  q: Record<string, string | undefined>,
): string {
  return [
    "swapchan-recover-form-v1",
    form,
    ...RECOVER_FORMS[form].map((k) => `${k}=${q[k] ?? ""}`),
  ].join("\n");
}

/** Fails closed like verifyRecoverSig: no secret, no form param or no/invalid sig = not verified. */
export function verifyRecoverFormSig(
  form: RecoverForm,
  q: Record<string, string | undefined>,
  secret: string | undefined = process.env.SWAPCHAN_RECOVER_LINK_SECRET,
): boolean {
  if (!secret || !q[form] || !q.sig) return false;
  if (!/^[0-9a-f]{64}$/.test(q.sig)) return false;
  const want = createHmac("sha256", secret).update(recoverFormPayload(form, q)).digest();
  return timingSafeEqual(want, Buffer.from(q.sig, "hex"));
}
