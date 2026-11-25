import { z } from "zod";

/**
 * The output contract: every agent turn ends by producing a `wallet_respond` envelope with two
 * parts — a `message` for the human, and an `action` for the wallet. The schema is the contract,
 * so the client never has to scrape prose: it renders `message` and dispatches on `action.type`.
 *
 * `actionId` is NOT part of what the model returns — the server assigns it when it emits the
 * action (it is the sign-gate key: sign once per actionId, a different answer is a conflict). The
 * model only decides WHAT to propose; the server owns the identity used to gate signing.
 */

// An EIP-1193 unsigned tx — exactly what the browser passes to eth_sendTransaction.
export const EvmTx = z.object({
  to: z.string(),
  data: z.string().optional(),
  value: z.string().optional(), // hex wei
  chainId: z.number().int().optional(),
  gas: z.string().optional(),
});
export type EvmTx = z.infer<typeof EvmTx>;

// What the agent claims the result should be — checked before signing and again after settlement.
export const VerifySummary = z.object({
  recipient: z.string(), // must equal the connected address
  minOut: z.string().optional(),
  verdict: z.enum(["ok", "warn", "danger"]),
  note: z.string().optional(),
});
export type VerifySummary = z.infer<typeof VerifySummary>;

// The action the model proposes (no actionId — the server assigns that).
export const ModelAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("sign_and_send"),
    chainId: z.number().int(),
    tx: EvmTx,
    verify: VerifySummary,
  }),
  z.object({ type: z.literal("sign_message"), message: z.string() }),
  z.object({ type: z.literal("switch_chain"), chainId: z.number().int() }),
  // Offer the user a card on-ramp (Crossmint): the UI opens the embedded checkout, which delivers USDC
  // to the connected wallet. No signing, no custody — SwapChan never touches the card data or funds.
  z.object({
    type: z.literal("onramp"),
    chainId: z.number().int().optional(),
    suggestedUsd: z.string().optional(),
  }),
  z.object({ type: z.literal("need_info") }),
  z.object({ type: z.literal("none") }),
]);
export type ModelAction = z.infer<typeof ModelAction>;

export const WalletRespond = z.object({
  message: z.string(),
  action: ModelAction,
});
export type WalletRespond = z.infer<typeof WalletRespond>;

// What actually gets stored in an `action_proposed` event: the model action + the server's actionId.
export type ProposedAction = ModelAction & { actionId: string };

/** Actions that require the user to do something in their wallet (and thus a sign-gate id). */
export function isActionable(
  a: ModelAction,
): a is Extract<ModelAction, { type: "sign_and_send" | "sign_message" | "switch_chain" }> {
  // onramp (card on-ramp) is intentionally NOT actionable yet — MoonPay signature validation is
  // unresolved on their side, so we don't surface a card checkout. Re-add "onramp" here (and in the
  // web page's isActionable) to turn it back on once MoonPay validates. The schema keeps the literal.
  return a.type === "sign_and_send" || a.type === "sign_message" || a.type === "switch_chain";
}
