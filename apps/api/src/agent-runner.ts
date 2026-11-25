import { randomUUID } from "node:crypto";
import { decodeFunctionData, type Hex, parseAbi } from "viem";
import { appendEvent, type SessionBus } from "./session-bus.js";
import { normalizeAddress, type SessionEvent, type SessionStore } from "./sessions.js";
import {
  type EvmTx,
  isActionable,
  type ModelAction,
  type ProposedAction,
  WalletRespond,
} from "./wallet-action.js";

/**
 * The server-side transaction guard. The model's own `verify` field is NOT trusted — a prompt-
 * injected agent could label a malicious approval "ok" and show the user's own address as the
 * recipient. The guard decodes the real calldata and simulates against chain state (SwapChan's
 * verify_tx), keyed to the connected wallet as the expected beneficiary, and returns an
 * independent verdict. `danger` means the tx is not safe to present for signing (unlimited /
 * unknown-spender approvals, funds not reaching the owner, etc.).
 */
export type GuardVerdict = {
  /** verify_tx's verdict ("ok" | "caution" | "danger"); "caution" is shown as warn, anything unknown as danger. */
  verdict: string;
  note: string;
  /** Ignored: the shown recipient is always decoded from the calldata here, never supplied. */
  recipient?: string;
};
export type Guard = (chainId: number, tx: EvmTx, owner: string) => Promise<GuardVerdict>;

/**
 * The agent runner: context from the log → a `wallet_respond` envelope → events back on the log.
 *
 * The model call is injected (`Respond`) so the orchestration is testable without a live Anthropic
 * call; the real adapter (Agent SDK, scoped to the SwapChan MCP tools, enforcing the `wallet_respond`
 * tool) plugs in behind this interface. The agent's context is simply the full event log replayed —
 * a user message and a chain settlement are the same kind of thing to it.
 */

export interface AgentContext {
  address: string;
  events: SessionEvent[];
}
export type Respond = (
  ctx: AgentContext,
  onDelta?: (text: string) => void,
  /** The agent speaking mid-turn (status_update) — persisted as dialogue. */
  onSay?: (text: string) => void,
  /** A per-tool action line ("Getting a quote…") — persisted, shown muted. */
  onActivity?: (text: string) => void,
) => Promise<unknown>;

/** Fixed, user-facing refusals. Raw error text is never put in events (it can carry RPC URLs/keys). */
export const REFUSE_UNVERIFIED =
  "I couldn't verify this transaction on-chain, so I'm not proposing it. Please try again in a moment.";
export const REFUSE_SIGN_MESSAGE =
  "I can't ask you to sign a message from this chat. Signing arbitrary messages can authorize transfers, so it isn't offered here.";
const RESPOND_FAILED = "Something went wrong on my side. Please try again.";

const RECIPIENT_ABI = parseAbi([
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function approve(address spender, uint256 amount)",
]);
/**
 * Who the tx actually pays or empowers, from the calldata: transfer `to`, transferFrom `to`, approve
 * `spender`, or the native `to` of a plain transfer. Anything else is "unknown" — never the user's address.
 */
export function decodedRecipient(tx: EvmTx): string {
  const data = (tx.data ?? "0x").toLowerCase();
  if (data === "0x" || data === "") return tx.to;
  try {
    const d = decodeFunctionData({ abi: RECIPIENT_ABI, data: data as Hex });
    const a = d.args as readonly unknown[];
    return String(d.functionName === "transferFrom" ? a[1] : a[0]);
  } catch {
    return "unknown";
  }
}
const normVerdict = (v: unknown): "ok" | "warn" | "danger" =>
  v === "ok" ? "ok" : v === "warn" || v === "caution" ? "warn" : "danger";
/** Strip URLs from guard text before it reaches the user (an RPC URL can carry an API key). */
const scrub = (s: string) => s.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]").slice(0, 600);

// Only these events start a turn. The agent's OWN output (agent_message/action_proposed) must not
// re-trigger it, or it would loop; wallet_result is informational and folds into the next turn.
const TRIGGER_KINDS = new Set<SessionEvent["kind"]>(["user_message", "settled"]);

/** One agent turn for an address. Fail-closed: a bad/blank envelope becomes a message, never an action. */
export async function runTurn(
  store: SessionStore,
  bus: SessionBus,
  address: string,
  respond: Respond,
  guard?: Guard,
): Promise<void> {
  let raw: unknown;
  try {
    // The agent opens the turn itself by calling status_update (see the prompt), in its own voice.
    // onDelta streams the FINAL answer's partial text (transient, replaced by the durable agent_message).
    // onSay (its mid-turn dialogue) and onActivity (per-tool action lines) are appended as DURABLE
    // events, so they persist in the conversation and survive a reload — they are not transient.
    raw = await respond(
      { address, events: store.all(address) },
      (text) => bus.publishDelta(address, text),
      (text) => appendEvent(store, bus, { address, kind: "agent_say", data: { text } }),
      (text) => appendEvent(store, bus, { address, kind: "agent_activity", data: { text } }),
    );
  } catch (e) {
    console.error("[agent] respond failed", e); // detail server-side only
    appendEvent(store, bus, {
      address,
      kind: "agent_message",
      data: { text: RESPOND_FAILED },
    });
    return;
  }

  const parsed = WalletRespond.safeParse(raw);
  if (!parsed.success) {
    appendEvent(store, bus, {
      address,
      kind: "agent_message",
      data: { text: "I could not produce a valid response. Please try again." },
    });
    return;
  }

  const { message, action } = parsed.data;

  const say = (text: string) =>
    appendEvent(store, bus, { address, kind: "agent_message", data: { text } });

  // sign_message is not offered: a model-proposed arbitrary message (permit, login to another
  // site, ...) is refused. SwapChan's own sign-to-view login does not go through the agent.
  if (action.type === "sign_message") {
    say(REFUSE_SIGN_MESSAGE);
    return;
  }

  // Server-side guard: the model's self-asserted verdict/recipient are NOT trusted. For a
  // sign_and_send, run the real on-chain guard (decode + simulate, keyed to the connected wallet)
  // and REPLACE the model's `verify` with the server's. Fail closed on a MISSING guard or a guard
  // ERROR (nothing proposed) — but a `danger` verdict is still PROPOSED, with the real verdict shown,
  // because the user is the final authority and legitimate operations read as danger to a
  // self-receives heuristic (an ERC-4626 vault deposit "loses" USDC and the shares mint elsewhere;
  // a cross-chain send delivers to the bridge). Blocking those outright left real txs impossible.
  // The user still signs every tx in their own wallet; danger never auto-sends and the UI requires
  // an explicit acknowledgment before the manual Sign button enables. The shown recipient is decoded
  // from the calldata.
  let outAction: ModelAction = action;
  let shownMessage = message;
  if (action.type === "sign_and_send") {
    let v: GuardVerdict;
    try {
      if (!guard) throw new Error("server guard not configured");
      v = await guard(action.chainId, action.tx, address);
    } catch (e) {
      console.error("[agent] guard failed", e); // detail server-side only
      say(REFUSE_UNVERIFIED);
      return;
    }
    let verdict = normVerdict(v.verdict);
    const note = scrub(v.note ?? "");
    const recipient = decodedRecipient(action.tx);
    // Paying or empowering anyone but the user is at least a warning, with the real address shown.
    if (verdict === "ok" && recipient.toLowerCase() !== address.toLowerCase()) verdict = "warn";
    if (verdict === "danger") {
      // Override the model's message (it may have called this safe) with guard-derived text so the
      // only risk claim the user reads is the server's, then propose it for the user to decide.
      shownMessage = `⚠️ SwapChan's on-chain check rated this HIGH RISK.${note ? ` ${note}` : ""} I'm showing it so you can decide — read the warning, and sign in your wallet only if you understand and accept the risk.`;
    }
    outAction = {
      ...action,
      verify: {
        recipient,
        ...(action.verify.minOut ? { minOut: action.verify.minOut } : {}),
        verdict,
        note,
      },
    };
  }

  appendEvent(store, bus, { address, kind: "agent_message", data: { text: shownMessage } });
  if (isActionable(outAction)) {
    // The SERVER assigns the actionId — the sign-gate key. The model decides what; we own identity.
    const proposed: ProposedAction = { ...outAction, actionId: randomUUID() };
    appendEvent(store, bus, { address, kind: "action_proposed", data: { action: proposed } });
  }
}

/**
 * Wakes the agent on triggering events, one run at a time per address, coalescing: a wake during a
 * run re-runs once more against the latest log (so bursts and re-deliveries collapse to the newest
 * context instead of piling up). Mirrors paperclip's single-funnel wakeup + coalescing.
 */
export class AgentOrchestrator {
  private running = new Set<string>();
  private pending = new Set<string>();
  private inflight = new Map<string, Promise<void>>();
  private unsub: (() => void) | null = null;

  constructor(
    private store: SessionStore,
    private bus: SessionBus,
    private respond: Respond,
    private guard?: Guard,
  ) {}

  start(): this {
    this.unsub = this.bus.subscribeAll((e) => {
      if (TRIGGER_KINDS.has(e.kind)) this.wake(e.address);
    });
    return this;
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
  }

  wake(address: string): void {
    const addr = normalizeAddress(address);
    if (this.running.has(addr)) {
      this.pending.add(addr);
      return;
    }
    const p = this.run(addr);
    this.inflight.set(addr, p);
  }

  /** Resolves when the current run (and any coalesced re-run) for an address has finished. */
  idle(address: string): Promise<void> {
    return this.inflight.get(normalizeAddress(address)) ?? Promise.resolve();
  }

  private async run(addr: string): Promise<void> {
    this.running.add(addr);
    try {
      do {
        this.pending.delete(addr);
        await runTurn(this.store, this.bus, addr, this.respond, this.guard);
      } while (this.pending.has(addr));
    } finally {
      this.running.delete(addr);
      this.inflight.delete(addr);
    }
  }
}
