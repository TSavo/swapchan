"use client";
import { checkAcrossApproval, checkAcrossDeposit } from "@swapchan/shared";
import { useEffect, useRef, useState } from "react";
import { type Address, formatEther, formatUnits, type Hex } from "viem";
import { useConfig, useSendTransaction, useSwitchChain } from "wagmi";
import { getTransaction, getTransactionReceipt } from "wagmi/actions";
import { paymentRequest } from "@/lib/paymentRequest";

type Proposal = { actionId: string; recipient: string; amountMicroUsdc: string };
type Quote = Pick<Proposal, "recipient" | "amountMicroUsdc"> & {
  sender: Address;
  sourceChainId: number;
  chainId: number;
  quoteId: string;
  expiresAt: number;
  maxInputMicroUsdc: string;
  sourceWallet: { requiredApprovalMicroUsdc: string };
  originGas: { estimate: { totalWei: string } | null };
  execution: string;
};
type Tx = { from: Address; to: Address; data: Hex; chainId: number; value: string };
type Step = { action: "approve" | "deposit"; tx: Tx; hash?: Hex };
type Review = { quote: Quote; approved?: boolean; step?: Step };
const usdc = (n: string) => formatUnits(BigInt(n), 6);
export function CrossPaymentPanel({
  sender,
  proposal,
  report,
}: {
  sender: Address;
  proposal: Proposal;
  report: (id: string, data: Record<string, unknown>) => Promise<void>;
}) {
  const key = `swapchan:across:${sender.toLowerCase()}:${proposal.actionId}`;
  const [review, setReview] = useState<Review | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [message, setMessage] = useState("");
  const [recovery, setRecovery] = useState("");
  const config = useConfig();
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      setReview(raw ? JSON.parse(raw) : null);
      setReady(true);
    } catch {
      setMessage("Payment history is unavailable in this browser.");
    }
  }, [key]);
  function save(value: Review) {
    localStorage.setItem(key, JSON.stringify(value));
    setReview(value);
  }
  async function run(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      await navigator.locks.request(key, async () => {
        if ((review ? JSON.stringify(review) : null) !== localStorage.getItem(key))
          throw Error("This payment was updated in another tab. Reload to continue.");
        await fn();
      });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const intent = {
    sourceChainId: 8453,
    chainId: 10,
    sender,
    recipient: proposal.recipient as Address,
    amountMicroUsdc: proposal.amountMicroUsdc,
  };
  function matches(q: Quote) {
    return (
      q.chainId === 10 &&
      q.sourceChainId === 8453 &&
      q.sender.toLowerCase() === sender.toLowerCase() &&
      q.recipient.toLowerCase() === proposal.recipient.toLowerCase() &&
      q.amountMicroUsdc === proposal.amountMicroUsdc
    );
  }
  async function quote() {
    const q = await paymentRequest<Quote>("quote", intent);
    if (
      !matches(q) ||
      BigInt(q.sourceWallet.requiredApprovalMicroUsdc) > BigInt(q.maxInputMicroUsdc)
    )
      throw Error("Quote differs from your request.");
    save({ quote: q });
  }
  const q = review?.quote;
  const action =
    review?.approved || q?.sourceWallet.requiredApprovalMicroUsdc === "0" ? "deposit" : "approve";
  async function sign() {
    if (!review || !q || review.step || !matches(q) || !q.originGas.estimate) return;
    await switchChainAsync({ chainId: 8453 });
    const b = await paymentRequest<{
      quoteId: string;
      action: string;
      unsignedTransaction: Tx;
      expiresAt: number;
      originSimulation: { status: string };
      estimatedOriginFeeWei: string;
    }>("cross-chain/build", {
      quoteId: q.quoteId,
      stage: review.approved ? "after_approval" : "initial",
    });
    const tx = b.unsignedTransaction;
    const expiresAt = Math.min(b.expiresAt, q.expiresAt);
    if (
      b.quoteId !== q.quoteId ||
      b.action !== action ||
      tx.chainId !== 8453 ||
      tx.from.toLowerCase() !== sender.toLowerCase() ||
      b.originSimulation.status !== "succeeded" ||
      !(expiresAt > Date.now() / 1000) ||
      BigInt(b.estimatedOriginFeeWei) > BigInt(q.originGas.estimate.totalWei)
    )
      throw Error("Payment terms changed. Request a fresh quote.");
    if (action === "approve") checkAcrossApproval(tx, q.sourceWallet.requiredApprovalMicroUsdc);
    else checkAcrossDeposit(tx, { ...intent, maxInputMicroUsdc: q.maxInputMicroUsdc, expiresAt });
    const step = { action, tx } as Step;
    save({ ...review, step });
    try {
      const hash = await sendTransactionAsync({
        account: sender,
        chainId: 8453,
        to: tx.to,
        data: tx.data,
        value: 0n,
      });
      save({ ...review, step: { ...step, hash } });
    } catch (e) {
      if (e instanceof Error && /user rejected|user denied/i.test(e.message)) save(review);
      throw e;
    }
  }
  async function check() {
    if (!review?.step || !q || !matches(q)) return;
    const { step } = review;
    const hash = step.hash ?? (recovery as Hex);
    if (!/^0x[a-f0-9]{64}$/i.test(hash))
      throw Error("Enter the Base transaction hash from your wallet.");
    if (!step.hash) {
      const tx = await getTransaction(config, { chainId: 8453, hash });
      if (
        tx.from.toLowerCase() !== sender.toLowerCase() ||
        tx.to?.toLowerCase() !== step.tx.to.toLowerCase() ||
        tx.input.toLowerCase() !== step.tx.data.toLowerCase() ||
        tx.value !== 0n
      )
        throw Error("Transaction differs from the reviewed step.");
      save({ ...review, step: { ...step, hash } });
    }
    const receipt = await getTransactionReceipt(config, { chainId: 8453, hash });
    if (receipt.status !== "success") {
      save({ quote: q });
      throw Error("Base transaction reverted. Refresh the quote before signing again.");
    }
    if (step.action === "approve") {
      save({ quote: q, approved: true });
      setMessage("Approval confirmed on Base.");
      return;
    }
    const result = await paymentRequest<{
      status: string;
      fillHash?: Hex;
      providerStatus?: string;
    }>("cross-chain/status", {
      ...intent,
      originHash: hash,
      maxInputMicroUsdc: q.maxInputMicroUsdc,
    });
    if (result.status === "settled" && result.fillHash) {
      await report(proposal.actionId, {
        status: "confirmed",
        chainId: 10,
        hash: result.fillHash,
        originHash: hash,
      });
    }
    setMessage([result.status, result.providerStatus, result.fillHash].filter(Boolean).join(" · "));
  }
  return (
    <section className="space-y-3 p-3">
      <p>
        Pay {usdc(intent.amountMicroUsdc)} USDC on Optimism to <code>{intent.recipient}</code> from
        Base via Across.
      </p>
      {q && (
        <p>
          Maximum source spend {usdc(q.maxInputMicroUsdc)} USDC. Estimated Base gas{" "}
          {q.originGas.estimate
            ? formatEther(BigInt(q.originGas.estimate.totalWei)) + " ETH"
            : "unavailable"}
          . Destination settlement requires a separate fill.
        </p>
      )}
      {review?.step ? (
        <>
          <p>
            {review.step.action === "approve" ? "Token approval" : "Base deposit"} ·{" "}
            {review.step.hash ?? "Check your wallet for the submitted transaction."}
          </p>
          {!review.step.hash && (
            <input
              aria-label="Base transaction hash"
              value={recovery}
              onChange={(e) => setRecovery(e.target.value)}
            />
          )}
          <button disabled={busy} onClick={() => run(check)}>
            Check transaction status
          </button>
        </>
      ) : (
        <div className="flex flex-wrap gap-3">
          <button disabled={!ready || busy} onClick={() => run(quote)}>
            {q ? "Refresh quote" : "Get payment quote"}
          </button>
          {q?.execution === "unsigned_origin_steps" && (
            <button disabled={busy} onClick={() => run(sign)}>
              {action === "approve" ? "Sign USDC approval on Base" : "Sign deposit on Base"}
            </button>
          )}
          <button
            disabled={!ready || busy}
            onClick={() => run(() => report(proposal.actionId, { status: "rejected" }))}
          >
            Dismiss payment
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
