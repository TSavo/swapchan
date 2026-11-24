"use client";
import {
  type PaymentQuote,
  paymentContracts,
  paymentDelegationNotice,
  paymentSignatureRequest,
} from "@swapchan/shared";
import { useEffect, useRef, useState } from "react";
import {
  type Address,
  erc20Abi,
  formatUnits,
  type Hex,
  isAddress,
  parseUnits,
  type SignedAuthorization,
} from "viem";
import {
  useConfig,
  useReadContract,
  useSignTypedData,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { simulateContract, waitForTransactionReceipt } from "wagmi/actions";
import { PaymentRequestError, paymentRequest as request } from "@/lib/paymentRequest";

type Review = PaymentQuote & { quoteId: string; authorizationNonce?: string };
function readAuthorization(raw: string, q: Review): SignedAuthorization {
  const value = JSON.parse(raw),
    a = value.authorization ?? value;
  const nonce = Number(a.nonce),
    chainId = Number(a.chainId),
    yParity = Number(a.yParity);
  if (
    a.address?.toLowerCase() !== paymentContracts.delegate.toLowerCase() ||
    chainId !== 84532 ||
    !Number.isSafeInteger(nonce) ||
    String(nonce) !== q.authorizationNonce ||
    ![0, 1].includes(yParity) ||
    ![a.r, a.s].every((s) => /^0x[0-9a-f]{64}$/i.test(s))
  )
    throw new Error("Delegation authorization does not match this account setup.");
  return { chainId, address: paymentContracts.delegate, nonce, yParity, r: a.r, s: a.s };
}
export function PaymentPanel({
  sender,
  chainId,
  proposal,
  report,
}: {
  sender: Address;
  chainId: number | undefined;
  proposal?: { actionId: string; recipient: string; amountMicroUsdc: string };
  report?: (id: string, data: Record<string, unknown>) => Promise<void>;
}) {
  const [recipient, setRecipient] = useState(proposal?.recipient ?? ""),
    [amount, setAmount] = useState(
      proposal ? formatUnits(BigInt(proposal.amountMicroUsdc), 6) : "",
    ),
    [auth, setAuth] = useState("");
  const [q, setQ] = useState<Review | null>(null),
    [msg, setMsg] = useState(""),
    [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(""),
    [receipt, setReceipt] = useState("");
  const lock = useRef(false);
  const actionId = proposal?.actionId;
  const trackingKey =
    `swapchan:payment:84532:${sender.toLowerCase()}` + (actionId ? ":" + actionId : "");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(trackingKey);
      if (saved && /^0x[0-9a-f]{64}$/i.test(saved)) {
        setPending(saved);
        setMsg("Checking the previous payment…");
      }
    } catch {
      /* Storage can be disabled in private browsing. */
    }
  }, [trackingKey]);
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const allowance = useReadContract({
    chainId: 84532,
    address: paymentContracts.usdc,
    abi: erc20Abi,
    functionName: "allowance",
    args: [sender, paymentContracts.paymaster],
    query: { refetchInterval: 15000 },
  });
  async function clearAllowance() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      if (chainId !== 84532) await switchChainAsync({ chainId: 84532 });
      const { request: revoke } = await simulateContract(config, {
        chainId: 84532,
        account: sender,
        address: paymentContracts.usdc,
        abi: erc20Abi,
        functionName: "approve",
        args: [paymentContracts.paymaster, 0n],
      });
      const hash = await writeContractAsync({ ...revoke, chainId: 84532 });
      setMsg("Waiting for approval revocation " + hash);
      const receipt = await waitForTransactionReceipt(config, { chainId: 84532, hash });
      const current = await allowance.refetch();
      if (receipt.status !== "success" || current.data !== 0n)
        throw Error("Could not verify a zero paymaster allowance.");
      setMsg("Paymaster approval cleared. Receipt " + hash);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Revocation failed");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const { signTypedDataAsync } = useSignTypedData(),
    { switchChainAsync } = useSwitchChain();
  useEffect(() => {
    if (!pending) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let interval = 3000;
      try {
        const r = await request<{
          status: string;
          transactionHash?: string;
          gasChargedMicroUsdc: string;
          paidMicroUsdc: string;
        }>("status/" + pending);
        if (stopped) return;
        if (r.status === "settled" || r.status === "failed") {
          if (actionId && report)
            await report(actionId, {
              status: r.status === "settled" ? "confirmed" : "reverted",
              chainId: 84532,
              hash: r.transactionHash,
              userOpHash: pending,
              paidMicroUsdc: r.paidMicroUsdc,
              gasChargedMicroUsdc: r.gasChargedMicroUsdc,
            });
          setMsg(
            r.status === "failed"
              ? "Payment reverted."
              : `Paid ${formatUnits(BigInt(r.paidMicroUsdc), 6)} USDC. Gas charged: ${formatUnits(BigInt(r.gasChargedMicroUsdc), 6)} USDC.`,
          );
          if (r.transactionHash && /^0x[0-9a-f]{64}$/i.test(r.transactionHash))
            setReceipt(r.transactionHash);
          setPending("");
          try {
            localStorage.removeItem(trackingKey);
          } catch {}
          return;
        }
        if (r.status === "submission_unconfirmed")
          setMsg("Submission is unconfirmed. Checking for a receipt…");
        if (r.status === "awaiting_finality") {
          interval = 15000;
          setMsg("Payment included on Base Sepolia. Waiting for chain finality.");
          if (r.transactionHash && /^0x[0-9a-f]{64}$/i.test(r.transactionHash))
            setReceipt(r.transactionHash);
        }
      } catch (e) {
        if (!stopped) setMsg(e instanceof Error ? e.message : "Waiting for settlement");
      }
      if (!stopped) timer = setTimeout(poll, interval);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pending, trackingKey, actionId, report]);
  async function act() {
    if (lock.current || pending) return;
    lock.current = true;
    setBusy(true);
    setMsg("");
    setReceipt("");
    try {
      if (!q) {
        if (
          !isAddress(recipient) ||
          !/^\d+(\.\d{1,6})?$/.test(amount) ||
          parseUnits(amount, 6) <= 0n
        )
          throw new Error(
            "Enter a recipient address and a positive amount with up to six decimals.",
          );
        const units = parseUnits(amount, 6).toString();
        const review = await request<Review>("quote", {
          chainId: 84532,
          sender,
          recipient,
          amountMicroUsdc: units,
        });
        if (
          review.chainId !== 84532 ||
          review.sender.toLowerCase() !== sender.toLowerCase() ||
          review.recipient.toLowerCase() !== recipient.toLowerCase() ||
          review.amountMicroUsdc !== units
        )
          throw new Error("Quote differs from the requested payment.");
        setQ(review);
        return;
      }
      if (q.expiresAt <= Date.now() / 1000) {
        setQ(null);
        throw new Error("Quote expired. Request a fresh quote.");
      }
      const authorization = q.requiresDelegation ? readAuthorization(auth, q) : undefined;
      if (chainId !== 84532) await switchChainAsync({ chainId: 84532 });
      const built = await request<{ userOperation: unknown; userOpHash: Hex }>("build", {
        quoteId: q.quoteId,
        authorization,
      });
      const typed = paymentSignatureRequest(
        q,
        built.userOperation,
        built.userOpHash,
        authorization,
      );
      const verification = await request<{ status: string; userOpHash: Hex }>("verify", {
        quoteId: q.quoteId,
        userOpHash: built.userOpHash,
        userOperation: built.userOperation,
        authorization,
      });
      if (
        verification.status !== "verified" ||
        verification.userOpHash !== built.userOpHash ||
        q.expiresAt <= Date.now() / 1000
      )
        throw Error("Payment verification failed. Request a fresh quote.");
      const signature = await signTypedDataAsync({ ...typed, account: sender });
      try {
        localStorage.setItem(trackingKey, built.userOpHash);
      } catch {}
      const signed = { quoteId: q.quoteId, userOpHash: built.userOpHash, signature };
      let acknowledged = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const reply = await request<{ status: string }>("submit", signed);
          acknowledged = reply.status === "submitted";
          break;
        } catch (err) {
          if (
            attempt === 0 &&
            err instanceof PaymentRequestError &&
            [400, 409, 410, 422].includes(err.status)
          ) {
            try {
              localStorage.removeItem(trackingKey);
            } catch {}
            throw err;
          }
          // Only replay these same signed bytes. Either HTTP response can be lost after relay.
        }
      }
      setPending(built.userOpHash);
      setQ(null);
      setMsg(
        acknowledged
          ? "Submitted. Checking settlement…"
          : "Submission is unconfirmed. Checking for a receipt…",
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Payment failed");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <details
      open={proposal ? true : undefined}
      className="rounded-xl border border-white/20 p-3 text-sm"
    >
      <summary className="cursor-pointer font-semibold">Pay exact USDC · Base Sepolia</summary>
      <div className="mt-2 grid gap-2">
        <label>
          Recipient{" "}
          <input
            className="w-full rounded bg-black/30 p-2"
            value={recipient}
            readOnly={!!proposal}
            disabled={busy || !!pending}
            onChange={(e) => {
              setRecipient(e.target.value);
              setQ(null);
            }}
          />
        </label>
        <label>
          USDC amount{" "}
          <input
            className="rounded bg-black/30 p-2"
            inputMode="decimal"
            value={amount}
            readOnly={!!proposal}
            disabled={busy || !!pending}
            onChange={(e) => {
              setAmount(e.target.value);
              setQ(null);
            }}
          />
        </label>
        {q && (
          <>
            <p>
              Recipient receives {formatUnits(BigInt(q.amountMicroUsdc), 6)} USDC. Maximum gas{" "}
              {formatUnits(BigInt(q.maxGasMicroUsdc), 6)} USDC. Maximum WETH spend{" "}
              {formatUnits(BigInt(q.maxWethWei), 18)}.
            </p>
            {q.requiresDelegation && (
              <label>
                First payment: import the signed Block Tools delegation for Base Sepolia, nonce{" "}
                {q.authorizationNonce}, delegate {paymentContracts.delegate}.
                <textarea
                  aria-label="Signed delegation authorization"
                  className="w-full rounded bg-black/30 p-2"
                  value={auth}
                  onChange={(e) => setAuth(e.target.value)}
                />
              </label>
            )}
            <details open={q.requiresDelegation}>
              <summary>{q.requiresDelegation ? "New" : "Existing"} account delegation</summary>
              <p>{paymentContracts.delegate}</p>
              <p>
                {paymentDelegationNotice.permission} {paymentDelegationNotice.revoke}
              </p>
            </details>
          </>
        )}
        <button type="button" disabled={busy || !!pending} onClick={() => void act()}>
          {busy ? "Working…" : q ? "Review and sign in wallet" : "Get payment quote"}
        </button>
        {q && (
          <p>
            The paymaster collects its fee after the batch. Any unused USDC allowance persists until
            replaced or revoked.
          </p>
        )}
        {allowance.data !== undefined && allowance.data > 0n && (
          <p>
            Current paymaster allowance {formatUnits(allowance.data, 6)} USDC.{" "}
            <button disabled={busy || !!pending} onClick={() => void clearAllowance()}>
              Revoke approval with Base Sepolia ETH
            </button>
          </p>
        )}
        {msg && <p role="status">{msg}</p>}
        {actionId && report && !pending && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void report(actionId, { status: "rejected" })
                .catch(() => setMsg("Could not dismiss the payment. Try again."))
                .finally(() => setBusy(false));
            }}
          >
            Dismiss payment
          </button>
        )}
        {pending && <p className="break-all">Operation hash {pending}</p>}
        {receipt && <a href={`https://sepolia.basescan.org/tx/${receipt}`}>View payment receipt</a>}
      </div>
    </details>
  );
}
