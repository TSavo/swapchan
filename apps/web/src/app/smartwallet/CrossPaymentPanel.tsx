"use client";
import {
  acrossRoute,
  batchAbi,
  checkAcrossApproval,
  checkAcrossAtomicOrigin,
  checkAcrossDeposit,
  paymentContracts,
  paymentDelegationNotice,
} from "@swapchan/shared";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  type Address,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  type Hex,
  toHex,
} from "viem";
import { useConfig, useSendTransaction, useSwitchChain } from "wagmi";
import { getConnectorClient, getTransaction, getTransactionReceipt } from "wagmi/actions";
import {
  atomicWalletRequest,
  supportsAtomicOrigin,
  walletBatchReceipt,
  walletRejectedRequest,
} from "@/lib/atomicWallet";
import { paymentRequest } from "@/lib/paymentRequest";

type Proposal = {
  chainId: number;
  actionId: string;
  recipient: string;
  amountMicroUsdc: string;
  paymentReviewId?: string;
};
type Quote = Pick<Proposal, "recipient" | "amountMicroUsdc"> & {
  sender: Address;
  sourceChainId: number;
  chainId: number;
  quoteId: string;
  expiresAt: number;
  fillDeadline?: number;
  recovery?: string;
  provider?: string;
  atomicOrigin?: { delegate: string; estimatedFeeWei: string } | null;
  fundingFeeWei?: string | null;
  fundingShortfall?: { microUsdc: string; estimatedWei: string | null };
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
type Step = {
  action: "approve" | "deposit" | "transfer" | "atomic_origin";
  tx: Tx;
  hash?: Hex;
  batchId?: Hex;
  fillHash?: Hex;
};
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
  const [atomicWallet, setAtomicWallet] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const lastProgress = useRef("");
  const [message, setMessage] = useState("");
  const [recovery, setRecovery] = useState("");
  const [destinationHash, setDestinationHash] = useState("");
  const config = useConfig();
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();
  const openChatReview = useEffectEvent((list: Comparison) => acceptQuote(list));
  useEffect(() => {
    let active = true;
    try {
      const raw = localStorage.getItem(key);
      setDestinationHash("");
      setReview(raw ? JSON.parse(raw) : null);
      if (raw || !proposal.paymentReviewId) setReady(true);
      else {
        setReady(false);
        paymentRequest<Comparison>("review/" + encodeURIComponent(proposal.paymentReviewId))
          .then((list) => {
            if (active && !localStorage.getItem(key)) openChatReview(list);
          })
          .catch(() => {
            if (active) setMessage("The chat quote is unavailable. Get a fresh payment quote.");
          })
          .finally(() => {
            if (active) setReady(true);
          });
      }
    } catch {
      setMessage("Payment history is unavailable in this browser.");
    }
    return () => {
      active = false;
    };
  }, [key, proposal.paymentReviewId]);
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
    acceptQuote(list);
  }
  function acceptQuote(list: Comparison) {
    if (
      !list.routes.length ||
      list.routes.some(
        (q) =>
          q.expiresAt <= Date.now() / 1000 ||
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
  const estimatedFeeWei = q?.fundingFeeWei ?? q?.originGas.estimate?.totalWei;
  const direct = q?.provider === "direct_transfer";
  const origin = direct ? destination : bridgeOrigin;
  const signingChain = direct ? route.destination : route.origin;
  const action = direct
    ? "transfer"
    : review?.approved || q?.sourceWallet.requiredApprovalMicroUsdc === "0"
      ? "deposit"
      : "approve";
  useEffect(() => {
    let active = true;
    setAtomicWallet(false);
    if (q?.atomicOrigin && signingChain === 84532) {
      void getConnectorClient(config, { account: sender, chainId: 84532 })
        .then((client) =>
          client.request({ method: "wallet_getCapabilities", params: [sender, [toHex(84532)]] }),
        )
        .then((features) => {
          if (active) setAtomicWallet(supportsAtomicOrigin(features));
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [config, sender, q?.quoteId, q?.atomicOrigin, signingChain]);
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
        {
          ...intent,
          expiresAt,
          fillDeadline: q.fillDeadline,
          maxInputMicroUsdc: q.maxInputMicroUsdc,
        },
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
    else
      checkAcrossDeposit(tx, {
        ...intent,
        maxInputMicroUsdc: q.maxInputMicroUsdc,
        fillDeadline: q.fillDeadline,
        expiresAt,
      });
    const step = { action: expectedAction, tx } as Step;
    if (atomic && atomicWallet) {
      const client = await getConnectorClient(config, { account: sender, chainId: 84532 });
      const features = await client.request({
        method: "wallet_getCapabilities",
        params: [sender, [toHex(84532)]],
      });
      if (!supportsAtomicOrigin(features) || expiresAt <= Date.now() / 1000)
        throw Error("Wallet capabilities or payment terms changed. Refresh the quote.");
      const batchId = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const [calls] = decodeFunctionData({ abi: batchAbi, data: tx.data }).args;
      save({ ...review, step: { ...step, batchId } });
      try {
        const reply = await client.request(
          { method: "wallet_sendCalls", params: [atomicWalletRequest(sender, batchId, calls)] },
          { retryCount: 0 },
        );
        if (!reply || typeof reply !== "object" || reply.id !== batchId)
          throw Error(
            "Wallet returned a different batch ID. Check the original request in your wallet.",
          );
        setMessage("Atomic batch submitted to the wallet.");
      } catch (error) {
        if (walletRejectedRequest(error)) {
          save(review);
          throw error;
        }
        throw Error(
          "The wallet submission is unconfirmed. Check transaction status using the saved batch ID.",
        );
      }
      return;
    }
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
      if (walletRejectedRequest(e)) {
        save(review);
        throw e;
      }
      throw Error(
        "The wallet submission is unconfirmed. Enter the origin transaction hash from your wallet to resume.",
      );
    }
  }
  async function check(candidateFillHash?: Hex, candidateOriginHash?: Hex) {
    if (!review?.step || !q || !matches(q)) return;
    const { step } = review;
    let hash = step.hash ?? candidateOriginHash ?? (recovery as Hex);
    if (step.batchId && !step.hash && !candidateOriginHash) {
      const client = await getConnectorClient(config, { account: sender, chainId: 84532 });
      const status = await client.request({
        method: "wallet_getCallsStatus",
        params: [step.batchId],
      });
      const mined = walletBatchReceipt(status, step.batchId);
      if (!mined) {
        setMessage("Waiting for the wallet to include the atomic batch.");
        return;
      }
      hash = mined;
    }
    if (!/^0x[a-f0-9]{64}$/i.test(hash))
      throw Error("Enter the origin transaction hash from your wallet.");
    if (!step.hash && !step.batchId) {
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
      if (step.batchId)
        throw Error("This origin receipt reverted. Check the deposit hash in your wallet.");
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
        fees?: { executionWei?: string; l1DataWei?: string };
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
          fees: result.fees,
        });
      const summary =
        result.status === "settled"
          ? "The recipient’s USDC transfer is finalized."
          : "Waiting for destination finality.";
      setMessage(
        [
          summary,
          result.fees?.executionWei &&
            `Execution fee ${formatEther(BigInt(result.fees.executionWei))} ETH.`,
          result.fees?.l1DataWei &&
            `L1 data fee ${formatEther(BigInt(result.fees.l1DataWei))} ETH.`,
        ]
          .filter(Boolean)
          .join(" "),
      );
      return;
    }
    const reviewedDepositData =
      step.action === "atomic_origin"
        ? decodeFunctionData({ abi: batchAbi, data: step.tx.data }).args[0][1]?.data
        : step.tx.data;
    if (!reviewedDepositData) throw Error("The saved review is missing its deposit call.");
    const result = await paymentRequest<{
      status: string;
      fillHash?: Hex;
      providerStatus?: string;
      refundHash?: Hex;
      returnedMicroUsdc?: string;
      refundFinalized?: boolean;
      spentMicroUsdc?: string;
      paidMicroUsdc?: string;
      originFinalized?: boolean;
      destinationFinalized?: boolean;
      depositExecutionFeeWei?: string;
      depositL1DataFeeWei?: string;
      approval?: {
        transactionHash: Hex;
        fees: { executionWei?: string; l1DataWei?: string };
      } | null;
      fillDeadline?: number;
    }>("cross-chain/status", {
      ...intent,
      sourceChainId: route.origin,
      originHash: hash,
      reviewedDepositData,
      approvalHash: review.approvalHash,
      fillHash: candidateFillHash ?? step.fillHash,
      maxInputMicroUsdc: q.maxInputMicroUsdc,
    });
    const verifiedFill =
      result.status === "settled" || result.status === "awaiting_finality"
        ? result.fillHash
        : undefined;
    if (result.spentMicroUsdc && (!step.hash || (verifiedFill && verifiedFill !== step.fillHash)))
      save({
        ...review,
        step: { ...step, hash, ...(verifiedFill ? { fillHash: verifiedFill } : {}) },
      });
    if (result.status === "settled" && result.fillHash) {
      await report(proposal.actionId, {
        status: "confirmed",
        chainId: route.destination,
        hash: result.fillHash,
        originHash: hash,
        approvalHash: result.approval?.transactionHash,
        approvalFees: result.approval?.fees,
        depositExecutionFeeWei: result.depositExecutionFeeWei,
        depositL1DataFeeWei: result.depositL1DataFeeWei,
        spentMicroUsdc: result.spentMicroUsdc,
        paidMicroUsdc: result.paidMicroUsdc,
      });
    }
    const details = {
      awaiting_origin_receipt: "Waiting for the origin deposit receipt.",
      awaiting_fill_index: "Waiting for Across to index the deposit.",
      expiry_reported:
        "Across reports that the deposit expired. Checking the finalized destination block.",
      fill_deadline_passed:
        "The destination chain has passed the fill deadline. A fill or refund still needs a verified receipt.",
      awaiting_verified_fill: "Waiting for the recipient’s USDC on the destination chain.",
      awaiting_destination_receipt: "Waiting for the destination transaction receipt.",
      awaiting_finality: "The destination transfer matches. Waiting for chain finality.",
      settled: "The exact destination payout is finalized.",
      recovery_reported: result.returnedMicroUsdc
        ? `Across reports a refund. Its origin receipt shows ${usdc(result.returnedMicroUsdc)} USDC returned to the sender. ${result.refundFinalized ? "Finalized." : "Waiting for finality."}`
        : "Across reports a refund. The return of USDC to the sender still needs receipt verification.",
    };
    const deadline = result.fillDeadline
      ? " Fill deadline " + new Date(result.fillDeadline * 1000).toLocaleString() + "."
      : "";
    const summary =
      (details[result.status as keyof typeof details] ?? result.status) +
      deadline +
      (result.refundHash ? " Reported refund transaction " + result.refundHash + "." : "") +
      (result.spentMicroUsdc ? " Source deposit " + usdc(result.spentMicroUsdc) + " USDC." : "") +
      (result.approval === null ? " Separate approval receipt could not be matched." : "") +
      (result.approval?.fees.executionWei
        ? " Approval execution fee " +
          formatEther(BigInt(result.approval.fees.executionWei)) +
          " ETH."
        : "") +
      (result.approval?.fees.l1DataWei
        ? " Approval L1 data fee " + formatEther(BigInt(result.approval.fees.l1DataWei)) + " ETH."
        : "") +
      (result.depositExecutionFeeWei
        ? " Deposit execution fee " + formatEther(BigInt(result.depositExecutionFeeWei)) + " ETH."
        : "") +
      (result.depositL1DataFeeWei
        ? " Deposit L1 data fee " + formatEther(BigInt(result.depositL1DataFeeWei)) + " ETH."
        : "") +
      (result.fillHash ? " Destination transaction " + result.fillHash : "");
    setMessage(summary);
    const fingerprint = hash + summary;
    if (
      result.originFinalized &&
      result.status !== "settled" &&
      lastProgress.current !== fingerprint
    ) {
      await report(proposal.actionId, {
        status: "payment_progress",
        phase: result.status,
        originHash: hash,
        fillHash: result.fillHash,
        refundHash: result.refundHash,
        returnedMicroUsdc: result.returnedMicroUsdc,
        refundFinalized: result.refundFinalized,
        display: summary,
      });
      lastProgress.current = fingerprint;
    }
  }
  const refreshStatus = useEffectEvent(() => {
    if (!lock.current) void run(check);
  });
  const batchId = review?.step?.batchId;
  const submittedHash = review?.step?.hash ?? batchId;
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
          {estimatedFeeWei ? formatEther(BigInt(estimatedFeeWei)) + " ETH" : "unavailable"}.{" "}
          {direct
            ? "The transfer settles on this chain."
            : "Destination settlement requires a separate fill."}
          {q.fillDeadline &&
            " Fill deadline " + new Date(q.fillDeadline * 1000).toLocaleString() + "."}
          {q.recovery && " " + q.recovery}
        </p>
      )}
      {q?.execution === "quote_only" && q.fundingShortfall && (
        <p>
          {BigInt(q.fundingShortfall.microUsdc) > 0n &&
            `Source balance is short by ${usdc(q.fundingShortfall.microUsdc)} USDC on ${origin}. `}
          {q.fundingShortfall.estimatedWei === null
            ? "A verified gas estimate is unavailable."
            : BigInt(q.fundingShortfall.estimatedWei) > 0n
              ? `Estimated gas shortfall on ${origin}: ${formatEther(BigInt(q.fundingShortfall.estimatedWei))} ETH.`
              : "The estimated gas is covered."}
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
            ·{" "}
            {review.step.hash ??
              review.step.batchId ??
              "Check your wallet for the submitted transaction."}
          </p>
          {!review.step.hash && !review.step.batchId && (
            <input
              aria-label="origin transaction hash"
              value={recovery}
              onChange={(e) => setRecovery(e.target.value)}
            />
          )}
          <button disabled={busy} onClick={() => run(check)}>
            Check transaction status
          </button>
          {batchId && (
            <>
              <button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const client = await getConnectorClient(config, {
                      account: sender,
                      chainId: 84532,
                    });
                    await client.request(
                      { method: "wallet_showCallsStatus", params: [batchId] },
                      { retryCount: 0 },
                    );
                  })
                }
              >
                Open batch in wallet
              </button>
              {!review.step.hash && (
                <details>
                  <summary>Recover a mined deposit from the wallet</summary>
                  <label>
                    Base Sepolia deposit transaction hash
                    <input
                      value={recovery}
                      onChange={(e) => setRecovery(e.target.value)}
                      spellCheck={false}
                    />
                  </label>
                  <button
                    disabled={busy || !/^0x[0-9a-f]{64}$/i.test(recovery.trim())}
                    onClick={() => run(() => check(undefined, recovery.trim() as Hex))}
                  >
                    Verify origin receipt
                  </button>
                </details>
              )}
            </>
          )}
          {review.step.hash &&
            (review.step.action === "deposit" || review.step.action === "atomic_origin") && (
              <details>
                <summary>Verify a destination transaction</summary>
                <label>
                  {destination} fill transaction hash
                  <input
                    value={destinationHash}
                    onChange={(event) => setDestinationHash(event.target.value)}
                    spellCheck={false}
                  />
                </label>
                <button
                  disabled={busy || !/^0x[a-f0-9]{64}$/i.test(destinationHash.trim())}
                  onClick={() => run(() => check(destinationHash.trim() as Hex))}
                >
                  Verify fill receipt
                </button>
              </details>
            )}
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
                {atomicWallet && (
                  <p>
                    Your wallet supports atomic calls. Review its final network fee in the wallet.
                  </p>
                )}
                <details>
                  <summary>Delegated contract and revocation</summary>
                  <p>
                    {paymentContracts.delegate}. {paymentDelegationNotice.permission}{" "}
                    {paymentDelegationNotice.revoke}
                  </p>
                </details>
                <button disabled={busy} onClick={() => run(() => sign(true))}>
                  {atomicWallet ? "Review atomic wallet batch" : "Sign atomic approval and deposit"}
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
