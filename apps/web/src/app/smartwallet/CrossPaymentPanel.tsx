"use client";
import {
  acrossRoute,
  checkAcrossApproval,
  checkAcrossAtomicOrigin,
  checkAcrossDeposit,
  paymentContracts,
} from "@swapchan/shared";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  type Hex,
} from "viem";
import { useConfig, useSendTransaction, useSwitchChain } from "wagmi";
import { getTransaction, getTransactionReceipt } from "wagmi/actions";
import { paymentRequest } from "@/lib/paymentRequest";

type Proposal = { chainId: number; actionId: string; recipient: string; amountMicroUsdc: string };
type Quote = Pick<Proposal, "recipient" | "amountMicroUsdc"> & {
  sender: Address;
  sourceChainId: number;
  chainId: number;
  quoteId: string;
  expiresAt: number;
  provider?: string;
  atomicOrigin?: { delegate: string; estimatedFeeWei: string } | null;
  fundingFeeWei?: string | null;
  estimatedTotalMicroUsdc?: string | null;
  maxInputMicroUsdc: string;
  sourceWallet: {
    requiredApprovalMicroUsdc: string;
    balanceMicroUsdc: string;
    nativeBalanceWei: string;
  };
  originGas: { estimate: { totalWei: string } | null };
  execution: string;
};
type Tx = { from: Address; to: Address; data: Hex; chainId: number; value: string };
type Step = { action: "approve" | "deposit" | "transfer" | "atomic_origin"; tx: Tx; hash?: Hex };
type Comparison = {
  routes: Quote[];
  recommendedQuoteId: string | null;
  gasConversionSource: string | null;
  unavailableSourceChainIds: number[];
};
type Review = { quote: Quote; approved?: boolean; approvalHash?: Hex; step?: Step };
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
  const [choices, setChoices] = useState<Comparison | null>(null);
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
  const route = acrossRoute(proposal.chainId);
  const bridgeOrigin = route.origin === 84532 ? "Base Sepolia" : "Base";
  const destination = route.destination === 10 ? "Optimism" : "Optimism Sepolia";
  const intent = {
    chainId: route.destination,
    sender,
    recipient: proposal.recipient as Address,
    amountMicroUsdc: proposal.amountMicroUsdc,
  };
  function matches(q: Quote) {
    return (
      q.chainId === route.destination &&
      (q.provider === "direct_transfer"
        ? q.sourceChainId === route.destination && q.maxInputMicroUsdc === intent.amountMicroUsdc
        : q.sourceChainId === route.origin) &&
      q.sender.toLowerCase() === sender.toLowerCase() &&
      q.recipient.toLowerCase() === proposal.recipient.toLowerCase() &&
      q.amountMicroUsdc === proposal.amountMicroUsdc
    );
  }
  async function quote() {
    const list = await paymentRequest<Comparison>("quote", intent);
    if (
      !list.routes.length ||
      list.routes.some(
        (q) =>
          !matches(q) ||
          BigInt(q.sourceWallet.requiredApprovalMicroUsdc) > BigInt(q.maxInputMicroUsdc),
      )
    )
      throw Error("Quote differs from your request.");
    const selected =
      list.routes.find((q) => q.quoteId === list.recommendedQuoteId) ?? list.routes[0]!;
    setChoices(list);
    save({
      quote: selected,
      ...(review?.approvalHash ? { approvalHash: review.approvalHash } : {}),
    });
    if (!list.recommendedQuoteId)
      setMessage("Review the available funding routes and their costs.");
  }
  const q = review?.quote;
  const direct = q?.provider === "direct_transfer";
  const origin = direct ? destination : bridgeOrigin;
  const signingChain = direct ? route.destination : route.origin;
  const action = direct
    ? "transfer"
    : review?.approved || q?.sourceWallet.requiredApprovalMicroUsdc === "0"
      ? "deposit"
      : "approve";
  async function sign(atomic = false) {
    if (!review || !q || review.step || !matches(q) || !q.originGas.estimate) return;
    if (
      atomic &&
      (action !== "approve" ||
        q.atomicOrigin?.delegate.toLowerCase() !== paymentContracts.delegate.toLowerCase() ||
        signingChain !== 84532)
    )
      throw Error("Atomic origin unavailable");
    const expectedAction = atomic ? "atomic_origin" : action;
    const reviewedFee = atomic ? q.atomicOrigin!.estimatedFeeWei : q.originGas.estimate.totalWei;
    await switchChainAsync({ chainId: signingChain });
    const b = await paymentRequest<{
      quoteId: string;
      action: string;
      unsignedTransaction: Tx;
      expiresAt: number;
      originSimulation: { status: string };
      estimatedOriginFeeWei: string;
    }>("cross-chain/build", {
      quoteId: q.quoteId,
      stage: atomic ? "atomic_origin" : review.approved ? "after_approval" : "initial",
    });
    const tx = b.unsignedTransaction;
    const expiresAt = Math.min(b.expiresAt, q.expiresAt);
    if (
      b.quoteId !== q.quoteId ||
      b.action !== expectedAction ||
      tx.chainId !== signingChain ||
      tx.from.toLowerCase() !== sender.toLowerCase() ||
      b.originSimulation.status !== "succeeded" ||
      !(expiresAt > Date.now() / 1000) ||
      BigInt(b.estimatedOriginFeeWei) > BigInt(reviewedFee)
    )
      throw Error("Payment terms changed. Request a fresh quote.");
    if (atomic)
      checkAcrossAtomicOrigin(
        tx,
        { ...intent, expiresAt, maxInputMicroUsdc: q.maxInputMicroUsdc },
        q.sourceWallet.requiredApprovalMicroUsdc,
      );
    else if (action === "transfer") {
      const expected = encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [intent.recipient, BigInt(intent.amountMicroUsdc)],
      });
      if (
        tx.to.toLowerCase() !== route.destinationToken.toLowerCase() ||
        tx.data.toLowerCase() !== expected.toLowerCase() ||
        BigInt(tx.value) !== 0n
      )
        throw Error("Transfer differs from your request.");
    } else if (action === "approve")
      checkAcrossApproval(tx, q.sourceWallet.requiredApprovalMicroUsdc, route.destination);
    else checkAcrossDeposit(tx, { ...intent, maxInputMicroUsdc: q.maxInputMicroUsdc, expiresAt });
    const step = { action: expectedAction, tx } as Step;
    save({ ...review, step });
    try {
      const hash = await sendTransactionAsync({
        account: sender,
        chainId: signingChain,
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
      throw Error("Enter the origin transaction hash from your wallet.");
    if (!step.hash) {
      const tx = await getTransaction(config, { chainId: signingChain, hash });
      if (
        tx.from.toLowerCase() !== sender.toLowerCase() ||
        tx.to?.toLowerCase() !== step.tx.to.toLowerCase() ||
        tx.input.toLowerCase() !== step.tx.data.toLowerCase() ||
        tx.value !== 0n
      )
        throw Error("Transaction differs from the reviewed step.");
      save({ ...review, step: { ...step, hash } });
    }
    const receipt = await getTransactionReceipt(config, { chainId: signingChain, hash });
    if (receipt.status !== "success") {
      save({ quote: q });
      throw Error("Origin transaction reverted. Refresh the quote before signing again.");
    }
    if (step.action === "approve") {
      save({ quote: q, approved: true, approvalHash: hash });
      setMessage("Approval confirmed on Base.");
      return;
    }
    if (step.action === "transfer") {
      const result = await paymentRequest<{
        status: string;
        paidMicroUsdc?: string;
        transactionHash?: Hex;
      }>("direct/status", { ...intent, transactionHash: hash });
      if (
        result.status === "settled" &&
        result.transactionHash === hash &&
        result.paidMicroUsdc === intent.amountMicroUsdc
      )
        await report(proposal.actionId, {
          status: "confirmed",
          chainId: route.destination,
          hash,
          paidMicroUsdc: result.paidMicroUsdc,
        });
      setMessage(
        result.status === "settled"
          ? "The recipient’s USDC transfer is finalized."
          : "Waiting for destination finality.",
      );
      return;
    }
    const result = await paymentRequest<{
      status: string;
      fillHash?: Hex;
      providerStatus?: string;
      spentMicroUsdc?: string;
      paidMicroUsdc?: string;
      originFinalized?: boolean;
      destinationFinalized?: boolean;
      fillDeadline?: number;
    }>("cross-chain/status", {
      ...intent,
      sourceChainId: route.origin,
      originHash: hash,
      maxInputMicroUsdc: q.maxInputMicroUsdc,
    });
    if (result.status === "settled" && result.fillHash) {
      await report(proposal.actionId, {
        status: "confirmed",
        chainId: route.destination,
        hash: result.fillHash,
        originHash: hash,
        approvalHash: review.approvalHash,
        spentMicroUsdc: result.spentMicroUsdc,
        paidMicroUsdc: result.paidMicroUsdc,
      });
    }
    const details = {
      awaiting_origin_receipt: "Waiting for the origin deposit receipt.",
      awaiting_fill_index: "Waiting for Across to index the deposit.",
      awaiting_verified_fill: "Waiting for the recipient’s USDC on the destination chain.",
      awaiting_destination_receipt: "Across reported a fill. Waiting for its on-chain receipt.",
      awaiting_finality: "The destination transfer matches. Waiting for chain finality.",
      settled: "The exact destination payout is finalized.",
      recovery_reported:
        "Across reported " +
        result.providerStatus +
        ". Check the origin receipt and recovery status before taking further action.",
    };
    const deadline = result.fillDeadline
      ? " Fill deadline " + new Date(result.fillDeadline * 1000).toLocaleString() + "."
      : "";
    setMessage(
      (details[result.status as keyof typeof details] ?? result.status) +
        deadline +
        (result.fillHash ? " Destination transaction " + result.fillHash : ""),
    );
  }
  const refreshStatus = useEffectEvent(() => {
    if (!lock.current) void run(check);
  });
  const submittedHash = review?.step?.hash;
  useEffect(() => {
    if (!submittedHash) return;
    const timer = setInterval(refreshStatus, 15000);
    return () => clearInterval(timer);
  }, [submittedHash]);
  return (
    <section className="space-y-3 p-3">
      <p>
        Pay {usdc(intent.amountMicroUsdc)} USDC on {destination} to <code>{intent.recipient}</code>{" "}
        {q ? (direct ? "by direct USDC transfer." : `from ${origin} via Across.`) : "."}
      </p>
      {choices && !review?.step && (
        <div>
          {choices.routes.map((option) => (
            <button
              type="button"
              key={option.quoteId}
              disabled={busy || q?.quoteId === option.quoteId}
              onClick={() =>
                run(async () =>
                  save({
                    quote: option,
                    ...(review?.approvalHash ? { approvalHash: review.approvalHash } : {}),
                  }),
                )
              }
            >
              {option.provider === "direct_transfer"
                ? destination + " direct"
                : bridgeOrigin + " via Across"}{" "}
              · {usdc(option.sourceWallet.balanceMicroUsdc)} USDC available ·{" "}
              {formatEther(BigInt(option.sourceWallet.nativeBalanceWei))} ETH available ·{" "}
              {option.execution === "quote_only"
                ? "unavailable"
                : option.estimatedTotalMicroUsdc
                  ? "estimated total " + usdc(option.estimatedTotalMicroUsdc) + " USDC"
                  : "spend " +
                    usdc(option.maxInputMicroUsdc) +
                    " USDC plus " +
                    formatEther(
                      BigInt(option.fundingFeeWei ?? option.originGas.estimate!.totalWei),
                    ) +
                    " ETH"}{" "}
              {option.quoteId === choices.recommendedQuoteId ? "(recommended)" : ""}
            </button>
          ))}
          {choices.gasConversionSource && <p>Gas conversion uses {choices.gasConversionSource}.</p>}
          {!!choices.unavailableSourceChainIds.length && (
            <p>Quote unavailable on chain {choices.unavailableSourceChainIds.join(", ")}.</p>
          )}
        </div>
      )}
      {q && (
        <p>
          Maximum source spend {usdc(q.maxInputMicroUsdc)} USDC. Estimated {origin} gas{" "}
          {q.originGas.estimate
            ? formatEther(BigInt(q.originGas.estimate.totalWei)) + " ETH"
            : "unavailable"}
          .{" "}
          {direct
            ? "The transfer settles on this chain."
            : "Destination settlement requires a separate fill."}
        </p>
      )}
      {review?.approvalHash && (
        <p>
          Approval receipt · <code>{review.approvalHash}</code>
        </p>
      )}
      {review?.step ? (
        <>
          <p>
            {review.step.action === "approve"
              ? "Token approval"
              : direct
                ? "USDC transfer"
                : "Base deposit"}{" "}
            · {review.step.hash ?? "Check your wallet for the submitted transaction."}
          </p>
          {!review.step.hash && (
            <input
              aria-label="origin transaction hash"
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
          {action === "approve" &&
            q &&
            q.execution !== "quote_only" &&
            q.atomicOrigin?.delegate.toLowerCase() === paymentContracts.delegate.toLowerCase() && (
              <div>
                <p>
                  Your existing Simple7702Account delegation can approve and deposit in one Base
                  Sepolia transaction. Estimated gas{" "}
                  {formatEther(BigInt(q.atomicOrigin.estimatedFeeWei))} ETH. The destination fill
                  settles separately.
                </p>
                <button disabled={busy} onClick={() => run(() => sign(true))}>
                  Sign atomic approval and deposit
                </button>
              </div>
            )}
          {q?.execution === "unsigned_origin_steps" && (
            <button disabled={busy} onClick={() => run(sign)}>
              {action === "approve"
                ? `Sign USDC approval on ${origin}`
                : direct
                  ? `Sign USDC transfer on ${origin}`
                  : `Sign deposit on ${origin}`}
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
