import { API_URL } from "@/lib/api";
export class PaymentRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function paymentRequest<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(
    API_URL + "/payments/" + path,
    body === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const result = await r.json();
  if (!r.ok)
    throw new PaymentRequestError(
      r.status,
      String(result.error ?? "Payment request failed").replaceAll("_", " "),
    );
  return result;
}
