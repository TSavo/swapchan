import { describe, expect, it } from "vitest";
import { AgentOrchestrator, type Respond, runTurn } from "./agent-runner.js";
import { appendEvent, SessionBus } from "./session-bus.js";
import { openSessionStore, type SessionEvent } from "./sessions.js";
import type { ProposedAction } from "./wallet-action.js";

const A = "0x803b80fC7f3C67f9aCE73750239C60dd764B2ce5";

function setup(respond: Respond) {
  const store = openSessionStore(":memory:");
  const bus = new SessionBus();
  return { store, bus, respond };
}
const kinds = (es: SessionEvent[]) => es.map((e) => e.kind);

describe("runTurn", () => {
  it("emits agent_message + a server-id'd action_proposed for an actionable envelope", async () => {
    const { store, bus, respond } = setup(async () => ({
      message: "Swapping 0.5 BNB to USDC.",
      action: {
        type: "sign_and_send",
        chainId: 56,
        tx: { to: "0xRouter", data: "0xdead", value: "0x0" },
        verify: { recipient: A, minOut: "311 USDC", verdict: "ok" },
      },
    }));
    await runTurn(store, bus, A, respond, async () => ({ verdict: "ok", note: "" }));
    expect(kinds(store.all(A))).toEqual(["agent_message", "action_proposed"]);
    const action = (store.all(A)[1].data as { action: ProposedAction }).action;
    expect(action.type).toBe("sign_and_send");
    expect(typeof action.actionId).toBe("string");
    expect(action.actionId.length).toBeGreaterThan(0);
  });

  it("replaces the model's self-asserted verify with the server guard (never trusts the model)", async () => {
    const { store, bus, respond } = setup(async () => ({
      message: "Approving the router.",
      action: {
        type: "sign_and_send",
        chainId: 1,
        tx: { to: "0xToken", data: "0x095ea7b3", value: "0x0" },
        // The model LIES: claims it is safe and that the user is the recipient.
        verify: { recipient: A, verdict: "ok" },
      },
    }));
    // The real on-chain guard decodes a dangerous unlimited approval to an attacker.
    const guard = async () => ({
      verdict: "danger" as const,
      recipient: A,
      note: "UNLIMITED approval to 0xAttacker",
    });
    await runTurn(store, bus, A, respond, guard);
    // Warn, don't refuse: danger is PROPOSED with the server's "danger" verdict (the user is the
    // final authority and the UI ack-gates it), but the model's self-asserted "ok"/"safe" text is
    // replaced by guard-derived HIGH RISK text carrying the guard's note.
    expect(kinds(store.all(A))).toEqual(["agent_message", "action_proposed"]);
    const text = (store.all(A)[0].data as { text: string }).text;
    expect(text).toMatch(/HIGH RISK/);
    expect(text).toContain("UNLIMITED approval to 0xAttacker");
    expect(text).not.toContain("Approving the router");
    const act = store.all(A).find((e) => e.kind === "action_proposed")!;
    expect((act.data as { action: { verify: { verdict: string } } }).action.verify.verdict).toBe(
      "danger",
    );
  });

  it("emits only a message for a non-actionable envelope", async () => {
    const { store, bus, respond } = setup(async () => ({
      message: "How much?",
      action: { type: "need_info" },
    }));
    await runTurn(store, bus, A, respond);
    expect(kinds(store.all(A))).toEqual(["agent_message"]);
  });

  it("fails closed on a malformed envelope (message, never an action)", async () => {
    const { store, bus, respond } = setup(async () => ({ not: "an envelope" }));
    await runTurn(store, bus, A, respond);
    expect(kinds(store.all(A))).toEqual(["agent_message"]);
  });

  it("fails closed when the model call throws, with no raw error text", async () => {
    const { store, bus, respond } = setup(async () => {
      throw new Error("provider down SECRET?key=abc");
    });
    await runTurn(store, bus, A, respond);
    expect(kinds(store.all(A))).toEqual(["agent_message"]);
    expect(JSON.stringify(store.all(A))).not.toMatch(/SECRET|key=abc|provider down/);
  });
});

describe("AgentOrchestrator", () => {
  it("wakes on a user_message, responds once, and the agent's own output doesn't re-trigger", async () => {
    let calls = 0;
    const respond: Respond = async () => {
      calls++;
      return { message: "ok", action: { type: "none" } };
    };
    const { store, bus } = setup(respond);
    const orch = new AgentOrchestrator(store, bus, respond).start();
    appendEvent(store, bus, { address: A, kind: "user_message", data: { text: "hi" } });
    await orch.idle(A);
    orch.stop();
    expect(calls).toBe(1); // the agent_message it produced did NOT start another turn
    expect(store.all(A).some((e) => e.kind === "agent_message")).toBe(true);
  });

  it("wakes on a chain settlement too", async () => {
    let calls = 0;
    const respond: Respond = async () => {
      calls++;
      return { message: "landed", action: { type: "none" } };
    };
    const { store, bus } = setup(respond);
    const orch = new AgentOrchestrator(store, bus, respond).start();
    appendEvent(store, bus, {
      address: A,
      kind: "settled",
      data: { hash: "0x1" },
      idempotencyKey: "0x1",
    });
    await orch.idle(A);
    orch.stop();
    expect(calls).toBe(1);
  });

  it("coalesces: wakes during a run collapse into one re-run", async () => {
    let resolveFirst: () => void = () => {};
    const first = new Promise<void>((r) => {
      resolveFirst = r;
    });
    let calls = 0;
    const respond: Respond = async () => {
      calls++;
      if (calls === 1) await first; // hold run #1 open
      return { message: "ok", action: { type: "none" } };
    };
    const { store, bus } = setup(respond);
    const orch = new AgentOrchestrator(store, bus, respond);
    orch.wake(A); // starts run #1 (blocked on `first`)
    orch.wake(A); // running -> pending
    orch.wake(A); // pending (coalesced, not a 3rd run)
    resolveFirst(); // run #1 finishes -> pending triggers run #2
    await orch.idle(A);
    expect(calls).toBe(2); // three wakes collapsed to two runs
  });
});
