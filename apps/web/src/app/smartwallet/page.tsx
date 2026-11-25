"use client";

import DOMPurify from "dompurify";
import { marked } from "marked";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useConfig, useSendTransaction, useSignMessage, useSwitchChain } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { ConnectButton } from "@/components/ConnectButton";
import {
  type LiveEvent,
  postEvent,
  type StreamStatus,
  signInWallet,
  streamSession,
} from "@/lib/liveStream";
import { SANITIZE_CONFIG } from "@/lib/sanitize";

// Client-only (the Crossmint SDK must not run during SSR / the build).
// MoonPay is the active card on-ramp provider; Crossmint (./FundWithCard) stays dormant pending access.
const FundWithMoonPay = dynamic(() => import("./FundWithMoonPay"), { ssr: false });

/** Mirrors the server wallet_respond contract (apps/api/src/wallet-action.ts). */
interface EvmTx {
  to: `0x${string}`;
  data?: `0x${string}`;
  value?: string;
  chainId?: number;
  gas?: string;
}
interface VerifySummary {
  recipient: string;
  minOut?: string;
  verdict: "ok" | "warn" | "danger";
  note?: string;
}
type ModelAction =
  | { type: "sign_and_send"; chainId: number; tx: EvmTx; verify: VerifySummary }
  | { type: "sign_message"; message: string }
  | { type: "switch_chain"; chainId: number }
  | { type: "onramp"; chainId?: number; suggestedUsd?: string }
  | { type: "need_info" }
  | { type: "none" };
type ProposedAction = ModelAction & { actionId: string };

interface Line {
  id: number;
  role: "you" | "wallet" | "chain" | "activity";
  text: string;
}

/** Fold a run of consecutive identical activity lines into one, carrying a count (shown as ×N). */
function coalesceActivity(lines: Line[]): (Line & { count: number })[] {
  const out: (Line & { count: number })[] = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    if (l.role === "activity" && prev && prev.role === "activity" && prev.text === l.text) {
      prev.count += 1; // same action again → bump the count instead of stacking a line
    } else {
      out.push({ ...l, count: 1 });
    }
  }
  return out;
}

const isActionable = (a: ProposedAction) =>
  // sign_message is no longer offered by the agent (an old stored one is shown but not actionable).
  // onramp (card on-ramp) is gated off until MoonPay signature validation is resolved on their side —
  // re-add "|| a.type === 'onramp'" here (and in the api's isActionable) to turn it back on.
  a.type === "sign_and_send" || a.type === "switch_chain";

export default function SmartWalletPage() {
  const config = useConfig();
  const { address, chainId } = useAccount();
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();
  const { signMessageAsync } = useSignMessage();

  const [lines, setLines] = useState<Line[]>([]);
  const [pending, setPending] = useState<ProposedAction | null>(null);
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());
  const [echo, setEcho] = useState<string | null>(null); // optimistic user line, shown instantly
  const [echoQueued, setEchoQueued] = useState(false); // typed while an action was pending
  const [thinking, setThinking] = useState(false); // agent is working → keep the UI alive
  const [workStart, setWorkStart] = useState<number | null>(null); // for the live "Working Ns" timer
  const [typeId, setTypeId] = useState<number | null>(null); // the wallet line to typewriter in
  const [streamText, setStreamText] = useState<string | null>(null); // live partial agent response
  const streamingRef = useRef(false); // did this turn stream? (don't also typewriter the final)
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ackFor, setAckFor] = useState<string | null>(null); // actionId whose warning was acknowledged
  const [autoSend, setAutoSend] = useState(false); // on → fire proposed actions straight to the wallet
  const [confirmAutoSend, setConfirmAutoSend] = useState(false); // "are you sure?" modal before enabling
  const [needsAuth, setNeedsAuth] = useState(false); // server returned 401: must sign to view history
  const [signingIn, setSigningIn] = useState(false);
  const [authErr, setAuthErr] = useState<string | null>(null);
  const [authEpoch, setAuthEpoch] = useState(0); // bump after a successful sign-in to reopen the stream
  const autoFired = useRef<string | null>(null); // actionId we've already auto-fired (no re-fire loop)
  const kicked = useRef(false); // posted the on-connect greeting yet?
  const sawUserMsg = useRef(false); // any user message already in this session's log?
  const synced = useRef(false); // past the initial catch-up replay? (only auto-send LIVE proposals)
  const resolvedRef = useRef<Set<string>>(new Set()); // actionIds that already have a result/settlement
  const seen = useRef<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef(false); // fresh pending-action flag for the SSE closure
  useEffect(() => {
    pendingRef.current = !!pending;
  }, [pending]);

  // One SSE subscription per connected address; switching addresses switches context.
  useEffect(() => {
    if (!address) return;
    setLines([]);
    setPending(null);
    setResolvedIds(new Set());
    setEcho(null);
    setEchoQueued(false);
    setThinking(false);
    setTypeId(null);
    setStreamText(null);
    streamingRef.current = false;
    autoFired.current = null;
    kicked.current = false;
    sawUserMsg.current = false;
    synced.current = false;
    resolvedRef.current = new Set();
    seen.current = new Set();

    const onEvent = (e: LiveEvent) => {
      if (seen.current.has(e.id)) return;
      seen.current.add(e.id);
      const d = (e.data ?? {}) as Record<string, unknown>;
      if (e.kind === "user_message") {
        sawUserMsg.current = true; // session already has history → don't auto-greet
        const text = String(d.text ?? "");
        setEcho((cur) => (cur === text ? null : cur)); // the real event replaces our optimistic echo
        setEchoQueued(false);
        if (!pendingRef.current) setThinking(true); // held messages don't start a run yet
        setLines((ls) => [...ls, { id: e.id, role: "you", text }]);
      } else if (e.kind === "agent_message" || e.kind === "agent_say") {
        // Her final answer AND each mid-turn line are streamed-then-durable wallet dialogue bubbles,
        // handled identically: the live buffer (if this one streamed) is replaced by the durable line.
        setThinking(false);
        setTypeId(streamingRef.current ? null : e.id); // already streamed → show full; else typewriter
        streamingRef.current = false;
        setStreamText(null); // the durable line replaces the streaming buffer
        setLines((ls) => [...ls, { id: e.id, role: "wallet", text: String(d.text ?? "") }]);
      } else if (e.kind === "agent_activity") {
        // A per-tool action line ("Getting a quote…"): a muted, persistent record of what she did.
        setLines((ls) => [...ls, { id: e.id, role: "activity", text: String(d.text ?? "") }]);
      } else if (e.kind === "settled") {
        setThinking(true); // settlement re-wakes the agent for the next step
        const aid = String(d.action_id ?? "");
        if (aid) resolvedRef.current.add(aid);
        setLines((ls) => [
          ...ls,
          { id: e.id, role: "chain", text: String(d.display ?? d.text ?? "settled") },
        ]);
      } else if (e.kind === "action_proposed") {
        const action = d.action as ProposedAction | undefined;
        if (action && isActionable(action)) setPending(action);
      } else if (e.kind === "wallet_result") {
        const aid = String(d.action_id ?? "");
        if (aid) {
          resolvedRef.current.add(aid); // mark handled synchronously (defeats reload replay-fire)
          setResolvedIds((s) => new Set(s).add(aid));
        }
      }
    };

    const onDelta = (text: string) => {
      streamingRef.current = true;
      setThinking(false);
      setStreamText(text); // type the response in as the model generates it
    };
    const h = streamSession({
      address,
      onEvent,
      onDelta,
      onStatus: setStatus,
      onAuthRequired: () => setNeedsAuth(true),
    });

    // Past the initial catch-up replay → only now may Auto-send fire (live proposals, never replays).
    const syncTimer = setTimeout(() => {
      synced.current = true;
    }, 1300);

    // On a FRESH session (no history after catch-up), greet immediately: have the agent check this
    // wallet's balances AND introduce what it can help with, so the user lands on a live, welcoming
    // response, not a blank box.
    const greet = setTimeout(() => {
      if (kicked.current || sawUserMsg.current) return;
      kicked.current = true;
      const text =
        "Check my balances, then introduce yourself: give me a quick, friendly rundown of the main things you can help me do with this wallet (swaps and bridges, finding forgotten money, checking token safety and approvals, yields/deposits, and anything else), so I know where to start.";
      setEcho(text);
      setThinking(true);
      void postEvent({
        address,
        kind: "user_message",
        data: { text, chainId },
      })
        .then((r) => {
          if (r.status === 401) {
            setNeedsAuth(true);
            setThinking(false);
            setEcho(null);
            kicked.current = false; // let the greet fire again after sign-in
          }
        })
        .catch(() => {});
    }, 900);

    return () => {
      clearTimeout(greet);
      clearTimeout(syncTimer);
      h.close();
    };
  }, [address, authEpoch]);

  // Clear the pending card once its action has a wallet_result.
  useEffect(() => {
    if (pending && resolvedIds.has(pending.actionId)) setPending(null);
  }, [pending, resolvedIds]);

  // Auto-send: fire a proposed action straight to the wallet (never a danger-verdict one).
  useEffect(() => {
    if (!autoSend || !pending || busy) return;
    if (!synced.current) return; // never auto-fire during a reload's catch-up replay
    if (resolvedRef.current.has(pending.actionId)) return; // already broadcast/handled
    // The server guard never proposes a danger action (danger → nothing is proposed), so a pending
    // sign_and_send is already guard-vetted as ok or warn. Both auto-send: the user opted in through
    // the Auto-send confirmation and still signs every tx in their own wallet, and "warn" is the
    // common case for legitimate txs (a payment to a non-self recipient, an unverified-source
    // contract). Requiring exactly "ok" left Auto-send firing on almost nothing. Only danger (which
    // shouldn't reach here) is skipped, belt-and-suspenders.
    if (pending.type === "sign_and_send" && pending.verify.verdict === "danger") return;
    if (autoFired.current === pending.actionId) return;
    autoFired.current = pending.actionId;
    void doAction(pending);
  }, [autoSend, pending, busy]);

  // Persist the Auto-send preference.
  useEffect(() => {
    try {
      setAutoSend(localStorage.getItem("sw-autosend") === "1");
    } catch {
      /* ignore */
    }
  }, []);

  // Drive the live "Working Ns" timer off the thinking flag.
  useEffect(() => {
    setWorkStart(thinking ? Date.now() : null);
  }, [thinking]);

  // Persist the composer draft per address (a separate, resilient typing space).
  const draftKey = address ? `sw-draft:${address.toLowerCase()}` : null;
  useEffect(() => {
    if (!draftKey) return;
    try {
      const saved = localStorage.getItem(draftKey);
      if (saved) setInput(saved);
    } catch {
      /* ignore */
    }
  }, [draftKey]);
  useEffect(() => {
    if (!draftKey) return;
    try {
      if (input.trim()) localStorage.setItem(draftKey, input);
      else localStorage.removeItem(draftKey);
    } catch {
      /* ignore */
    }
  }, [draftKey, input]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [lines, pending, thinking, echo, streamText]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !address) return;
    setInput("");
    setErr(null);
    setEcho(text); // show it instantly — don't wait for the round-trip
    setEchoQueued(!!pending); // typed while an action is pending → it's queued behind this step
    if (!pending) setThinking(true);
    try {
      const r = await postEvent({ address, kind: "user_message", data: { text, chainId } });
      if (!r.ok) {
        if (r.status === 401) {
          setNeedsAuth(true);
          setInput(text); // keep what they typed; it sends after sign-in
        } else {
          setErr(
            r.status === 429
              ? `Easy there — about ${r.retryAfter ?? 30}s until your next message.`
              : "Couldn't send that. Try again in a moment.",
          );
        }
        setEcho(null);
        setEchoQueued(false);
        setThinking(false);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed to send");
      setEcho(null);
      setEchoQueued(false);
      setThinking(false);
    }
  }, [input, address, chainId, pending]);

  // Sign-to-view: prove control of this address, then the server sets the session cookie and the
  // stream/chat reopen. The signature authorizes nothing on-chain — it only proves ownership.
  const signIn = useCallback(async () => {
    if (!address || signingIn) return;
    setSigningIn(true);
    setAuthErr(null);
    const r = await signInWallet(address, (message) => signMessageAsync({ message }));
    setSigningIn(false);
    if (r.ok) {
      setNeedsAuth(false);
      setAuthEpoch((e) => e + 1); // reopen the stream now that the cookie is set
    } else if (r.error !== "rejected") {
      setAuthErr("Sign-in failed — please try again.");
    }
  }, [address, signingIn, signMessageAsync]);

  // Report a wallet action's result back onto the channel (the agent holds until this settles).
  const report = useCallback(
    async (actionId: string, data: Record<string, unknown>) => {
      if (!address) return;
      await postEvent({
        address,
        kind: "wallet_result",
        data: { action_id: actionId, ...data },
        idempotencyKey: `${actionId}:${String(data.status)}:${String(data.hash ?? "")}`,
      });
    },
    [address],
  );

  const doAction = useCallback(
    async (a: ProposedAction) => {
      if (!address) return;
      setBusy(true);
      setErr(null);
      try {
        if (a.type === "switch_chain") {
          await switchChainAsync({ chainId: a.chainId });
          await report(a.actionId, { status: "switched", chainId: a.chainId });
          setThinking(true);
        } else if (a.type === "sign_message") {
          const signature = await signMessageAsync({ message: a.message });
          await report(a.actionId, { status: "signed", signature });
          setThinking(true);
        } else if (a.type === "sign_and_send") {
          if (chainId !== a.chainId) await switchChainAsync({ chainId: a.chainId });
          const hash = await sendTransactionAsync({
            to: a.tx.to,
            ...(a.tx.data ? { data: a.tx.data } : {}),
            value: BigInt(a.tx.value ?? "0"),
            chainId: a.chainId,
            ...(a.tx.gas ? { gas: BigInt(a.tx.gas) } : {}),
          });
          await report(a.actionId, { status: "sent", hash, chainId: a.chainId });
          try {
            const receipt = await waitForTransactionReceipt(config, { hash, chainId: a.chainId });
            await report(a.actionId, {
              status: receipt.status === "success" ? "confirmed" : "reverted",
              hash,
              chainId: a.chainId,
            });
          } catch {
            // receipt wait failed (timeout/rpc) — the server poller is the backstop
          }
          setThinking(true);
        }
        setPending(null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/reject|denied|cancell?ed/i.test(msg)) {
          setErr(null); // a cancel isn't an error to shout about
          await report(a.actionId, { status: "rejected" });
          setThinking(true); // the agent will acknowledge the cancel
        } else {
          setErr(msg);
        }
      } finally {
        setBusy(false);
      }
    },
    [address, chainId, config, report, sendTransactionAsync, signMessageAsync, switchChainAsync],
  );

  if (!address) {
    return (
      <div className="mx-auto mt-16 max-w-2xl px-4 text-center">
        <h1 className="bg-gradient-to-r from-pink-400 to-violet-300 bg-clip-text text-3xl font-black text-transparent">
          Smart Wallet
        </h1>
        <p className="mt-3 text-violet-200/80">
          Connect your wallet and just say what you want to do — “swap 0.1 ETH to USDC”, “find my
          money”, “bridge to Base”. I build and verify every transaction; you sign it in your own
          wallet. Your keys never leave it.
        </p>
        <div className="mt-7 flex justify-center">
          <ConnectButton primary />
        </div>
      </div>
    );
  }

  const verdictColor = (v: VerifySummary["verdict"]) =>
    v === "danger" ? "text-red-300" : v === "warn" ? "text-amber-300" : "text-emerald-300";
  const actionLabel = (a: ProposedAction) =>
    a.type === "sign_and_send"
      ? "Sign & send"
      : a.type === "sign_message"
        ? "Sign message"
        : "Switch network";

  return (
    <div className="mx-auto mt-6 flex h-[82vh] w-full max-w-5xl flex-col px-4">
      <style>{`
        .sw-md p { margin: 0.25rem 0; }
        .sw-md p:first-child { margin-top: 0; }
        .sw-md p:last-child { margin-bottom: 0; }
        .sw-md ul { list-style: disc; padding-left: 1.25rem; margin: 0.25rem 0; }
        .sw-md ol { list-style: decimal; padding-left: 1.25rem; margin: 0.25rem 0; }
        .sw-md li { margin: 0.1rem 0; }
        .sw-md a { text-decoration: underline; }
        .sw-md strong { font-weight: 600; }
        .sw-md code { background: rgba(255,255,255,0.1); padding: 0 0.25rem; border-radius: 4px; font-size: 0.85em; word-break: break-all; }
        .sw-md pre { background: rgba(0,0,0,0.3); padding: 0.5rem; border-radius: 8px; overflow-x: auto; margin: 0.4rem 0; }
        .sw-md img { max-height: 2.25rem; display: inline-block; vertical-align: middle; border-radius: 6px; margin: 0 0.25rem 0.1rem 0; }
        .sw-md h1, .sw-md h2, .sw-md h3 { font-weight: 700; margin: 0.4rem 0 0.2rem; }
      `}</style>

      {confirmAutoSend && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="max-w-sm rounded-2xl border border-red-500/50 bg-violet-950 p-5 text-center shadow-2xl">
            <div className="text-4xl">⚠️</div>
            <h2 className="mt-2 text-lg font-black text-red-300">Are you really sure?</h2>
            <p className="mt-2 text-sm text-amber-100/80">
              With Auto-send ON, every transaction the AI proposes goes{" "}
              <span className="font-semibold text-amber-200">straight to your wallet to sign</span>{" "}
              — there is no button in between. The AI can make mistakes and send your money
              somewhere you never intended. If that happens,{" "}
              <span className="font-semibold text-red-300">
                it’s gone. You will lose it, and no one can get it back.
              </span>{" "}
              Only do this with throwaway funds you are willing to lose.
            </p>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmAutoSend(false)}
                className="flex-1 rounded-xl border border-white/20 px-4 py-2 text-sm font-semibold text-violet-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setAutoSend(true);
                  setConfirmAutoSend(false);
                  try {
                    localStorage.setItem("sw-autosend", "1");
                  } catch {
                    /* ignore */
                  }
                }}
                className="flex-1 rounded-xl bg-gradient-to-r from-red-500 to-pink-600 px-4 py-2 text-sm font-semibold text-white"
              >
                Yes, turn it on
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h1 className="bg-gradient-to-r from-pink-400 to-violet-300 bg-clip-text text-xl font-black text-transparent">
          Smart Wallet
        </h1>
        <div className="flex items-center gap-3 text-xs text-violet-200/70">
          <button
            type="button"
            role="switch"
            aria-checked={autoSend}
            onClick={() => {
              if (autoSend) {
                // Turning OFF needs no confirmation.
                setAutoSend(false);
                try {
                  localStorage.setItem("sw-autosend", "0");
                } catch {
                  /* ignore */
                }
              } else {
                // Turning ON is dangerous — make them confirm in a modal first.
                setConfirmAutoSend(true);
              }
            }}
            className="flex items-center gap-1.5"
            title="Fire proposed actions straight to your wallet (it still prompts you to sign)"
          >
            <span
              className={
                "relative inline-block h-4 w-7 rounded-full transition-colors " +
                (autoSend ? "bg-gradient-to-r from-pink-500 to-violet-500" : "bg-white/15")
              }
            >
              <span
                className={
                  "absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all " +
                  (autoSend ? "left-3.5" : "left-0.5")
                }
              />
            </span>
            <span className={autoSend ? "text-violet-100" : ""}>Auto-send</span>
          </button>
          <span className="flex items-center gap-1">
            <span
              className={
                "inline-block h-2 w-2 rounded-full " +
                (status === "open"
                  ? "bg-emerald-400"
                  : status === "retrying"
                    ? "animate-pulse bg-amber-400"
                    : "animate-pulse bg-violet-400")
              }
            />
            {status === "open" ? "live" : status === "retrying" ? "reconnecting" : "connecting"}
          </span>
        </div>
      </div>
      <p className="mt-1 font-mono text-xs text-violet-300/60">
        {address.slice(0, 6)}…{address.slice(-4)} · chain {chainId ?? "—"}
      </p>

      {needsAuth && (
        <div className="mt-3 flex-1 overflow-y-auto rounded-2xl border border-violet-400/30 bg-white/5 p-6 backdrop-blur">
          <div className="mx-auto max-w-md text-center">
            <div className="text-3xl">🔏</div>
            <h2 className="mt-2 bg-gradient-to-r from-pink-400 to-violet-300 bg-clip-text text-lg font-black text-transparent">
              One quick signature to open your wallet
            </h2>
            <p className="mt-3 text-sm text-violet-200/80">
              Your SmartWallet chat and history are private to you. To make sure only the owner of{" "}
              <span className="font-mono text-violet-100">
                {address.slice(0, 6)}…{address.slice(-4)}
              </span>{" "}
              can see them, your wallet signs a short message proving it’s really you.
            </p>
            <ul className="mx-auto mt-4 max-w-xs space-y-1.5 text-left text-xs text-violet-200/70">
              <li className="flex gap-2">
                <span className="text-emerald-400">✓</span> Free — it’s a signature, not a
                transaction, so there’s no gas and no cost.
              </li>
              <li className="flex gap-2">
                <span className="text-emerald-400">✓</span> Safe — it can’t move your funds or
                approve any spending. It only proves ownership.
              </li>
              <li className="flex gap-2">
                <span className="text-emerald-400">✓</span> Once — after this we remember you on
                this device, so you won’t be asked again.
              </li>
            </ul>
            <button
              type="button"
              onClick={() => void signIn()}
              disabled={signingIn}
              className="mt-5 inline-flex items-center justify-center rounded-xl bg-gradient-to-r from-pink-500 to-violet-500 px-6 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
            >
              {signingIn ? "Check your wallet…" : "Sign to open my wallet"}
            </button>
            {authErr && <p className="mt-3 text-xs text-red-300">{authErr}</p>}
            <p className="mt-3 text-[11px] text-violet-300/50">
              You’ll see a “signature request” pop up in your wallet. Approving it just confirms
              your address — it never costs anything.
            </p>
          </div>
        </div>
      )}

      <div
        ref={scrollRef}
        className={
          "mt-3 flex-1 space-y-3 overflow-y-auto rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur" +
          (needsAuth ? " hidden" : "")
        }
      >
        {lines.length === 0 && !echo && !needsAuth && (
          <p className="text-sm text-violet-200/50">Say what you’d like to do with this wallet.</p>
        )}
        {coalesceActivity(lines).map((l) => (
          <Bubble
            key={l.id}
            role={l.role}
            text={l.text}
            count={l.count}
            typing={l.role === "wallet" && l.id === typeId}
          />
        ))}
        {echo && (
          <div className="text-right">
            <span className="inline-block max-w-[85%] whitespace-pre-wrap rounded-2xl bg-gradient-to-br from-pink-500/70 to-violet-600/70 px-3 py-2 text-sm text-white">
              {echo}
            </span>
            <div className="mt-0.5 text-[11px] text-violet-300/60">
              {echoQueued ? "Queued — runs after this step" : "Sending…"}
            </div>
          </div>
        )}
        {streamText !== null && (
          <div>
            <span className="sw-md inline-block max-w-[85%] rounded-2xl bg-white/10 px-3 py-2 text-sm text-violet-50">
              <span
                dangerouslySetInnerHTML={{ __html: renderMd(safeMarkdownPrefix(streamText)) }}
              />
              <span className="ml-0.5 inline-block w-1.5 animate-pulse">▍</span>
            </span>
          </div>
        )}
        {thinking && streamText === null && <Working start={workStart} />}

        {pending && (
          <div className="rounded-2xl border border-violet-400/30 bg-violet-500/10 p-3">
            {pending.type === "onramp" && (
              <FundWithMoonPay
                chainId={pending.chainId ?? chainId ?? 8453}
                walletAddress={address ?? ""}
                suggestedUsd={pending.suggestedUsd}
                onClose={() => {
                  void report(pending.actionId, { status: "rejected" }).then(() =>
                    setPending(null),
                  );
                }}
              />
            )}
            {pending.type === "sign_and_send" && (
              <div className="mb-2 space-y-0.5 text-xs text-violet-100">
                <div>
                  Recipient: <span className="font-mono">{pending.verify.recipient}</span>
                </div>
                {pending.verify.minOut && <div>Min received: {pending.verify.minOut}</div>}
                <div className={verdictColor(pending.verify.verdict)}>
                  Verify: {pending.verify.verdict}
                  {pending.verify.note ? ` — ${pending.verify.note}` : ""}
                </div>
                <div className="text-violet-300/60">
                  to <span className="font-mono">{pending.tx.to}</span> · chain {pending.chainId}
                </div>
              </div>
            )}
            {pending.type === "sign_message" && (
              <div className="mb-2 break-words text-xs text-violet-100">
                Sign message: <span className="font-mono">{pending.message}</span>
              </div>
            )}
            {pending.type === "switch_chain" && (
              <div className="mb-2 text-xs text-violet-100">
                Switch your wallet to chain {pending.chainId}.
              </div>
            )}
            {pending.type === "sign_and_send" &&
              (pending.verify.verdict === "warn" || pending.verify.verdict === "danger") && (
                <label
                  className={`mb-2 flex items-center gap-2 text-xs ${
                    pending.verify.verdict === "danger"
                      ? "font-semibold text-red-300"
                      : "text-amber-200"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={ackFor === pending.actionId}
                    onChange={(e) => setAckFor(e.target.checked ? pending.actionId : null)}
                  />
                  {pending.verify.verdict === "danger"
                    ? "This was flagged HIGH RISK. I understand and want to sign it anyway."
                    : "I read the warning above and want to send this anyway."}
                </label>
              )}
            {pending.type !== "onramp" && (
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={
                    busy ||
                    (pending.type === "sign_and_send" &&
                      pending.verify.verdict !== "ok" &&
                      ackFor !== pending.actionId)
                  }
                  onClick={() => void doAction(pending)}
                  className="rounded-xl bg-gradient-to-r from-pink-500 to-violet-600 px-3 py-1.5 text-sm font-semibold text-white shadow-lg shadow-violet-900/40 disabled:opacity-50"
                >
                  {busy ? "Check your wallet…" : actionLabel(pending)}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setThinking(true); // the agent will respond to the dismissal
                    void report(pending.actionId, { status: "rejected" }).then(() =>
                      setPending(null),
                    );
                  }}
                  className="rounded-xl border border-white/15 px-3 py-1.5 text-sm text-violet-100 disabled:opacity-50"
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {err && <p className="mt-2 text-xs text-red-300">{err}</p>}
      {pending && (
        <p className="mt-2 text-xs text-violet-300/60">
          One step at a time — finish the action above and I’ll continue. Anything you type is
          queued.
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="mt-3 flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Tell your wallet what to do…"
          className="flex-1 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-violet-50 placeholder-violet-300/40 outline-none focus:border-violet-400/60"
        />
        <button
          type="submit"
          disabled={!input.trim()}
          className="rounded-xl bg-gradient-to-r from-pink-500 to-violet-600 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-violet-900/40 disabled:opacity-40"
        >
          Send
        </button>
      </form>

      <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-[11px] leading-relaxed text-amber-100/70">
        <p className="font-bold tracking-wide text-amber-300 uppercase">
          ⚠️ Beta — not production ready. Do not use with real funds.
        </p>
        <p className="mt-1.5">
          Honestly,{" "}
          <span className="font-semibold text-amber-200">
            using AI to manage your money is probably a bad idea.
          </span>{" "}
          This is experimental software: use it at your own risk, only with throwaway funds you’re
          willing to lose. AI makes mistakes, and using SmartWallet means trusting AI with your
          money — <span className="font-semibold text-amber-200">your funds can disappear.</span>{" "}
          You sign every transaction yourself, in your own wallet, and we are not responsible for
          anything you do or any transaction you send. We keep logs of everything you do here,
          including your conversation and the agent’s reasoning; if you don’t want that stored with
          us, don’t use this product.
        </p>
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

function renderMd(text: string): string {
  let html: string;
  try {
    html = marked.parse(text, { async: false, breaks: true, gfm: true }) as string;
  } catch {
    html = escapeHtml(text);
  }
  // Sanitize before this is injected via dangerouslySetInnerHTML: agent text can echo attacker-
  // controlled strings (e.g. a malicious token name), so a <script>/onerror must never survive.
  // DOMPurify needs a DOM; on the server we emit nothing rather than any unsanitized HTML (the
  // messages are client-rendered, and the client re-renders sanitized after hydration).
  if (typeof window === "undefined") return "";
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}

/**
 * Trim a streaming markdown buffer back to the last point where every markdown glyph is complete,
 * so a half-formed token (an image/link mid-`![…](…`, an unclosed `**` or `` ` ``) never flashes
 * on screen. The held-back tail renders as soon as the rest of the glyph streams in.
 */
export function safeMarkdownPrefix(s: string): string {
  // In-progress link/image: a trailing `[` (or `![`) without its closing `](...)`.
  const lastBracket = s.lastIndexOf("[");
  if (lastBracket !== -1 && !/\]\([^)]*\)/.test(s.slice(lastBracket))) {
    s = s.slice(0, lastBracket > 0 && s[lastBracket - 1] === "!" ? lastBracket - 1 : lastBracket);
  }
  // Unclosed inline code / bold — cut before the dangling marker.
  if ((s.match(/`/g)?.length ?? 0) % 2 === 1) s = s.slice(0, s.lastIndexOf("`"));
  if ((s.match(/\*\*/g)?.length ?? 0) % 2 === 1) s = s.slice(0, s.lastIndexOf("**"));
  return s;
}

function Bubble({
  role,
  text,
  typing,
  count = 1,
}: {
  role: "you" | "wallet" | "chain" | "activity";
  text: string;
  typing?: boolean;
  count?: number;
}) {
  const [shown, setShown] = useState(typing ? "" : text);
  const done = useRef(!typing);
  useEffect(() => {
    if (done.current) {
      setShown(text);
      return;
    }
    const step = Math.max(1, Math.round(text.length / 50));
    let i = 0;
    const id = setInterval(() => {
      i += step;
      if (i >= text.length) {
        setShown(text);
        done.current = true;
        clearInterval(id);
      } else {
        setShown(text.slice(0, i));
      }
    }, 16);
    return () => clearInterval(id);
  }, [text]);

  if (role === "activity") {
    // A per-tool action line — muted, inline, persistent; not a dialogue bubble, no typewriter.
    // A repeated action shows a running count (×2, ×3, …) instead of stacking identical lines.
    return (
      <div className="flex items-center gap-2 pl-1 text-xs text-violet-300/60">
        <span className="text-violet-400/50">⚙</span>
        <span>{text}</span>
        {count > 1 && <span className="text-violet-400/50">×{count}</span>}
      </div>
    );
  }
  const typingNow = !done.current && shown.length < text.length;
  const cls =
    "sw-md inline-block max-w-[85%] rounded-2xl px-3 py-2 text-sm " +
    (role === "you"
      ? "whitespace-pre-wrap bg-gradient-to-br from-pink-500 to-violet-600 text-white"
      : role === "chain"
        ? "bg-emerald-500/15 text-emerald-200"
        : "bg-white/10 text-violet-50");
  return (
    <div className={role === "you" ? "text-right" : ""}>
      {role === "you" ? (
        <span className={cls}>{shown}</span>
      ) : (
        <span className={cls}>
          <span
            dangerouslySetInnerHTML={{
              __html: renderMd(typingNow ? safeMarkdownPrefix(shown) : shown),
            }}
          />
          {typingNow && <span className="ml-0.5 inline-block w-1.5 animate-pulse">▍</span>}
        </span>
      )}
    </div>
  );
}

/** Live "Working Ns…" indicator with a shimmering label and bouncing dots — keeps the UI alive. */
function Working({ start }: { start: number | null }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!start) return;
    setElapsed(Math.floor((Date.now() - start) / 1000));
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [start]);
  return (
    <div>
      <span className="inline-flex items-center gap-2 rounded-2xl bg-white/10 px-3 py-2">
        <span className="animate-pulse bg-gradient-to-r from-violet-200 to-pink-200 bg-clip-text text-sm font-medium text-transparent">
          Working{elapsed > 0 ? ` ${elapsed}s` : ""}
        </span>
        <span className="flex gap-1">
          {["0ms", "150ms", "300ms"].map((d) => (
            <span
              key={d}
              className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-violet-300"
              style={{ animationDelay: d }}
            />
          ))}
        </span>
      </span>
    </div>
  );
}
