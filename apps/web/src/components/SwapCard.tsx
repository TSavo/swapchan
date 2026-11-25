"use client";

import {
  isVmAddress,
  NATIVE_TOKEN,
  nativeOf,
  type Quote,
  type QuoteRequest,
  SUPPORTED_CHAINS,
  sameAddressSpace,
  type Token,
  tokenList,
  type Vm,
  vmOf,
} from "@swapchan/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { erc20Abi } from "viem";
import {
  useAccount,
  useBalance,
  useConfig,
  useReadContract,
  useSendTransaction,
  useSignTypedData,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { formatAmount, parseAmount, sanitizeAmountInput } from "@/lib/amount";
import { API_URL, api, cowExplorer, submitCowOrder } from "@/lib/api";
import { sendBitcoinPsbt, useBitcoin } from "@/lib/bitcoin";
import { assertBuilt } from "@/lib/buildCheck";
import { characterForChain } from "@/lib/characters";
import { quoteParams, track } from "@/lib/ga";
import { publishSays, say, unverifiedWarning } from "@/lib/says";
import { toSolanaTx } from "@/lib/solana";
import { sendTron, useTron } from "@/lib/tron";
import { useSolana } from "@/lib/useSolana";
import { AmountField, AmountReadout, BalanceRow } from "./AmountField";
import { Character, SpeechBubble } from "./Character";
import { ConnectButton } from "./ConnectButton";
import { ChainPicker, TokenPicker } from "./Pickers";
import { RouteList, RoutesLoading } from "./RouteList";
import { StatusTracker, type TrackParams } from "./StatusTracker";
import { UtxoSend } from "./UtxoSend";

const SLIPPAGES = [10, 50, 100, 300];

// Prefilled example so the first paint already shows a real quote: 100 USDC Ethereum -> Base.
const BASE_USDC: Token = {
  chainId: 8453,
  symbol: "USDC",
  name: "USD Coin",
  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  decimals: 6,
};
const usdc = (chainId: number) =>
  tokenList.find((t) => t.chainId === chainId && t.symbol === "USDC") ??
  (chainId === 8453 ? BASE_USDC : undefined);
const STATIC_CHAINS = Object.entries(SUPPORTED_CHAINS).map(([id, c]) => ({ id: Number(id), ...c }));

const isNative = (t: Token | undefined) =>
  !!t && t.address.toLowerCase() === nativeOf(t.chainId).toLowerCase();
const VM_NAME: Record<Vm, string> = {
  evm: "EVM",
  svm: "Solana",
  bvm: "Bitcoin",
  tvm: "Tron",
  uvm: "UTXO",
};

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const id = setTimeout(() => setD(v), ms);
    return () => clearTimeout(id);
  }, [v, ms]);
  return d;
}

type Phase =
  | { k: "idle" }
  | { k: "approving" }
  | { k: "swapping" }
  | { k: "tracking"; p: TrackParams }
  | { k: "order"; uid: string }
  | { k: "error"; msg: string };

export interface SwapInitial {
  fromChain: number;
  toChain: number;
  fromToken: string;
  toToken: string;
  amount: string;
}

/** Widget (/embed) options: lock the destination ("buy our token"), compact layout. */
export interface SwapEmbedOptions {
  lockTo?: boolean;
  compact?: boolean;
}

export function SwapCard({
  initial,
  embed,
}: {
  initial?: SwapInitial;
  embed?: SwapEmbedOptions;
} = {}) {
  const lockTo = !!embed?.lockTo;
  const compact = !!embed?.compact;
  const config = useConfig();
  const { address: evmAddress, chainId: walletChain } = useAccount();
  const sol = useSolana();
  const btc = useBitcoin();
  const tron = useTron();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();
  const { signTypedDataAsync } = useSignTypedData();

  const [fromChain, setFromChain] = useState(1);
  const [toChain, setToChain] = useState(8453);
  const [fromToken, setFromToken] = useState<Token | undefined>(() => usdc(1));
  const [toToken, setToToken] = useState<Token | undefined>(() => usdc(8453));
  const [amountStr, setAmountStr] = useState("100");
  const [slippageBps, setSlippage] = useState(50);
  const [selected, setSelected] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const [settled, setSettled] = useState<"done" | "failed">();
  const [recipientInput, setRecipientInput] = useState("");
  const [recipientFromLink, setRecipientFromLink] = useState(false);

  const fromVm = vmOf(fromChain);
  const toVm = vmOf(toChain);
  // Who signs: EVM (wagmi), Solana + Bitcoin (AppKit), Tron (tronwallet-adapters, loaded on demand).
  const addrFor = (vm: Vm) =>
    vm === "evm"
      ? evmAddress
      : vm === "svm"
        ? sol.address
        : vm === "bvm"
          ? btc.address
          : vm === "tvm"
            ? tron.address
            : undefined; // LTC/DOGE/BCH: no wallet connection; the user pastes an address (UtxoSend)
  const address: string | undefined = addrFor(fromVm);
  const ownOnDest = addrFor(toVm);
  const needsRecipient = !sameAddressSpace(fromChain, toChain);
  // Load Tron wallet adapters only once the user actually picks Tron.
  const loadTron = tron.load;
  useEffect(() => {
    if (fromVm === "tvm") loadTron();
  }, [fromVm, loadTron]);
  const recipient = needsRecipient ? recipientInput.trim() || ownOnDest || "" : "";
  const recipientInvalid = needsRecipient && recipient !== "" && !isVmAddress(recipient, toVm);

  const chains = useQuery({
    queryKey: ["chains"],
    queryFn: api.chains,
    placeholderData: { data: STATIC_CHAINS, mocked: false },
  });
  const fromTokens = useQuery({
    queryKey: ["tokens", fromChain],
    queryFn: () => api.tokens(fromChain),
  });
  const toTokens = useQuery({ queryKey: ["tokens", toChain], queryFn: () => api.tokens(toChain) });
  const mocked = Boolean(chains.data?.mocked || fromTokens.data?.mocked);

  // Deep link prefill: ?fromChain=1&toChain=8453&fromToken=0x..&toToken=0x..&amount=100 (MCP swapUrl).
  const prefill = useRef<{ fromToken?: string | undefined; toToken?: string | undefined } | null>(
    null,
  );
  const wantMax = useRef(false);
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search);
    if (initial && !raw.get("fromChain"))
      for (const [k, v] of Object.entries(initial)) raw.set(k, String(v));
    const apply = (sp: URLSearchParams) => {
      const fc = Number(sp.get("fromChain"));
      const tc = Number(sp.get("toChain"));
      if (fc > 0) setFromChain(fc);
      if (tc > 0) setToChain(tc);
      const amt = sp.get("amount");
      if (amt && /^\d+(\.\d+)?$/.test(amt)) setAmountStr(amt);
      const rcp = sp.get("recipient");
      if (rcp) {
        setRecipientInput(rcp);
        setRecipientFromLink(true);
      }
      const ft = sp.get("fromToken") ?? undefined;
      const tt = sp.get("toToken") ?? undefined;
      if (ft || tt) {
        prefill.current = { ...(ft ? { fromToken: ft } : {}), ...(tt ? { toToken: tt } : {}) };
        const pick = async (chain: number, a: string, set: (t: Token) => void) => {
          const t = await api.token(chain, a);
          if (t) set(t);
        };
        if (ft && fc > 0) void pick(fc, ft, setFromToken);
        if (tt && tc > 0) void pick(tc, tt, setToToken);
      }
    };
    // Human deep links (?fromChain=base&fromToken=ETH&amount=max) resolve via the API first.
    if (raw.get("amount")?.toLowerCase() === "max") {
      wantMax.current = true;
      raw.delete("amount");
    }
    const isAddr = (v: string | null) =>
      !v || /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{25,44})$/.test(v);
    const needs =
      ["fromChain", "toChain"].some((k) => raw.get(k) && !/^\d+$/.test(raw.get(k) ?? "")) ||
      !isAddr(raw.get("fromToken")) ||
      !isAddr(raw.get("toToken"));
    if (!needs) return apply(raw);
    const q = new URLSearchParams();
    for (const k of ["fromChain", "toChain", "fromToken", "toToken", "amount", "recipient"]) {
      const v = raw.get(k);
      if (v) q.set(k, v);
    }
    fetch(`${API_URL}/links/swap?${q}`, { signal: AbortSignal.timeout(15_000) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { url?: string }) =>
        apply(new URL(j.url ?? "", window.location.origin).searchParams),
      )
      .catch(() => apply(raw));
  }, []);

  // Default token selection per chain: native in, USDC (or first) out.
  useEffect(() => {
    const list = fromTokens.data?.data ?? [];
    const want = prefill.current?.fromToken?.toLowerCase();
    const hit = want ? list.find((t) => t.address.toLowerCase() === want) : undefined;
    if (hit) {
      setFromToken(hit);
      if (prefill.current) prefill.current.fromToken = undefined;
    } else if (!fromToken || fromToken.chainId !== fromChain)
      setFromToken(list.find(isNative) ?? list[0]);
  }, [fromTokens.data, fromChain, fromToken]);
  useEffect(() => {
    const list = toTokens.data?.data ?? [];
    const want = prefill.current?.toToken?.toLowerCase();
    const hit = want ? list.find((t) => t.address.toLowerCase() === want) : undefined;
    if (hit) {
      setToToken(hit);
      if (prefill.current) prefill.current.toToken = undefined;
    } else if (!toToken || toToken.chainId !== toChain)
      setToToken(list.find((t) => t.symbol === "USDC") ?? list[0]);
  }, [toTokens.data, toChain, toToken]);

  const amount = fromToken ? parseAmount(amountStr, fromToken.decimals) : null;
  const amountInvalid = amountStr !== "" && amount === null;
  const debouncedAmount = useDebounced(amount, 400);

  const request: QuoteRequest | null = useMemo(
    () =>
      fromToken && toToken && debouncedAmount
        ? {
            fromChainId: fromChain,
            toChainId: toChain,
            fromToken: fromToken.address,
            toToken: toToken.address,
            amount: debouncedAmount.toString(),
            slippageBps,
            ...(address ? { taker: address as `0x${string}` } : {}),
            ...(recipient && !recipientInvalid ? { recipient: recipient as `0x${string}` } : {}),
          }
        : null,
    [
      fromChain,
      toChain,
      fromToken,
      toToken,
      debouncedAmount,
      slippageBps,
      address,
      recipient,
      recipientInvalid,
    ],
  );

  const quotes = useQuery({
    queryKey: ["quotes", request],
    queryFn: () => (request ? api.quotes(request) : Promise.reject(new Error("no request"))),
    enabled: request !== null && phase.k === "idle",
    refetchInterval: 20_000,
  });
  const qres = quotes.data?.data;
  useEffect(() => {
    if (qres && !qres.quotes.some((q) => q.id === selected)) setSelected(qres.best);
  }, [qres, selected]);
  const quote: Quote | undefined = qres?.quotes.find((q) => q.id === selected);
  const quotesMocked = quotes.data?.mocked ?? mocked;
  const submitted = useRef<Quote | null>(null);
  const bestQuote = qres?.quotes[0];
  useEffect(() => {
    if (bestQuote && !quotesMocked)
      track("quote_received", { ...quoteParams(bestQuote), routes: qres?.quotes.length ?? 0 });
  }, [bestQuote, quotesMocked, qres?.quotes.length]);
  useEffect(() => {
    if (address) track("wallet_connected", { chain: walletChain });
  }, [address, walletChain]);
  useEffect(() => {
    if (settled === "done" && submitted.current) {
      track("swap_completed", quoteParams(submitted.current));
      submitted.current = null;
    }
  }, [settled]);

  // Balances & allowance
  const evmFrom = fromVm === "evm";
  const nativeBal = useBalance({
    address: evmAddress,
    chainId: fromChain,
    query: { enabled: !!evmAddress && evmFrom },
  });
  const erc20Bal = useReadContract({
    address: fromToken?.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: evmAddress ? [evmAddress] : undefined,
    chainId: fromChain,
    query: { enabled: !!evmAddress && evmFrom && !!fromToken && !isNative(fromToken) },
  });
  const balance = !evmFrom
    ? undefined
    : isNative(fromToken)
      ? nativeBal.data?.value
      : erc20Bal.data;
  const spender = quote?.approvalAddress ?? null;
  const allowance = useReadContract({
    address: fromToken?.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: evmAddress && spender ? [evmAddress, spender] : undefined,
    chainId: fromChain,
    query: {
      enabled: !!evmAddress && evmFrom && !!spender && !isNative(fromToken) && !quotesMocked,
    },
  });
  const needsApproval =
    !!spender &&
    !isNative(fromToken) &&
    !quotesMocked &&
    amount !== null &&
    (allowance.data ?? 0n) < amount;
  useEffect(() => {
    if (!wantMax.current || balance === undefined || !fromToken) return;
    wantMax.current = false;
    const b = isNative(fromToken) ? (balance * 98n) / 100n : balance;
    setAmountStr(formatAmount(b, fromToken.decimals, fromToken.decimals).replace(/,/g, ""));
  }, [balance, fromToken]);
  const insufficient = balance !== undefined && amount !== null && balance < amount;

  // Swap-chan's greeting follows the swap box.
  const chainName = (id: number) =>
    SUPPORTED_CHAINS[id as keyof typeof SUPPORTED_CHAINS]?.name ?? `chain ${id}`;
  const says = say({
    amount: amountStr,
    amountInvalid,
    fromToken,
    toToken,
    fromChainName: chainName(fromChain),
    toChainName: chainName(toChain),
    connected: !!address,
    wrongNetwork: evmFrom && !!address && walletChain !== fromChain,
    insufficient,
    quoting: request === null ? amount !== null : quotes.isFetching,
    error: quotes.isError ? (quotes.error as Error).message : undefined,
    quotes: request === null ? undefined : qres?.quotes,
    best: qres?.best,
    phase: phase.k,
    phaseError: phase.k === "error" ? phase.msg : undefined,
    settled: phase.k === "tracking" ? settled : undefined,
  });
  useEffect(() => publishSays(says), [says]);
  const tokenWarning = unverifiedWarning({ fromToken, toToken });

  const ensureChain = async () => {
    if (walletChain !== fromChain) await switchChainAsync({ chainId: fromChain });
  };

  const approve = async () => {
    if (!fromToken || !spender || amount === null) return;
    setPhase({ k: "approving" });
    try {
      await ensureChain();
      // Always approve exactly the swap amount (never unlimited, including to Permit2).
      const value = amount;
      const hash = await writeContractAsync({
        address: fromToken.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, value],
        chainId: fromChain,
      });
      await waitForTransactionReceipt(config, { hash, chainId: fromChain });
      await allowance.refetch();
      setPhase({ k: "idle" });
    } catch (e) {
      setPhase({ k: "error", msg: (e as Error).message.split("\n")[0] ?? "Approval failed" });
    }
  };

  const swapSolana = async (q: Quote, from: string) => {
    if (!sol.provider || !sol.connection) throw new Error("Connect a Solana wallet first");
    const built = await api.build(q, from, false);
    assertBuilt(built, q, from);
    if (!built.nonEvmTx) throw new Error("Provider returned no Solana transaction");
    const tx = await toSolanaTx(built.nonEvmTx, from, sol.connection);
    if (tx.message.staticAccountKeys[0]?.toBase58() !== from)
      throw new Error("Solana transaction has a different fee payer. Review a new quote.");
    const simulation = await sol.connection.simulateTransaction(tx, {
      commitment: "confirmed",
      sigVerify: false,
      replaceRecentBlockhash: false,
    });
    if (simulation.value.err !== null)
      throw new Error(`Solana simulation failed: ${JSON.stringify(simulation.value.err)}`);
    if (Date.now() >= (q.expiresAt < 1e12 ? q.expiresAt * 1000 : q.expiresAt))
      throw new Error("Quote expired during simulation. Review a new quote.");
    const sig = await sol.provider.signAndSendTransaction(tx);
    submitted.current = q;
    track("swap_submitted", { ...quoteParams(q), execution: "svm", tx_hash: sig });
    setPhase({
      k: "tracking",
      p: {
        provider: q.provider,
        txHash: sig,
        fromChainId: fromChain,
        toChainId: toChain,
        mocked: false,
      },
    });
  };

  const swapNonEvm = async (q: Quote, from: string) => {
    const built = await api.build(q, from, false);
    assertBuilt(built, q, from);
    if (!built.nonEvmTx) throw new Error(`Provider returned no ${VM_NAME[fromVm]} transaction`);
    const txHash =
      fromVm === "bvm"
        ? await sendBitcoinPsbt(btc, built.nonEvmTx)
        : await sendTron(built.nonEvmTx);
    submitted.current = q;
    track("swap_submitted", { ...quoteParams(q), execution: fromVm, tx_hash: txHash });
    setPhase({
      k: "tracking",
      p: {
        provider: q.provider,
        txHash,
        fromChainId: fromChain,
        toChainId: toChain,
        mocked: false,
      },
    });
  };

  const swap = async () => {
    if (!quote || !address) return;
    setPhase({ k: "swapping" });
    try {
      if (fromVm === "svm" && !quotesMocked) {
        await swapSolana(quote, address);
        return;
      }
      if ((fromVm === "bvm" || fromVm === "tvm") && !quotesMocked) {
        await swapNonEvm(quote, address);
        return;
      }
      if (quotesMocked) {
        // Demo mode: never send a real transaction against mock data.
        await new Promise((r) => setTimeout(r, 1200));
        const fake =
          `0x${Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}` as `0x${string}`;
        setPhase({
          k: "tracking",
          p: {
            provider: quote.provider,
            txHash: fake,
            fromChainId: fromChain,
            toChainId: toChain,
            mocked: true,
          },
        });
        return;
      }
      await ensureChain();
      const built = await api.build(quote, address, false);
      assertBuilt(built, quote, address);
      const evm = evmAddress as `0x${string}`;
      if (built.execution === "order" && built.order) {
        // CoW: sign the EIP-712 order (no gas), submit to CoW's orderbook.
        const o = built.order;
        const signature = await signTypedDataAsync({
          domain: o.domain,
          types: o.types,
          primaryType: o.primaryType,
          message: o.message,
        } as Parameters<typeof signTypedDataAsync>[0]);
        const uid = await submitCowOrder(fromChain, o, signature, evm);
        setPhase({ k: "order", uid });
        submitted.current = quote;
        track("swap_submitted", { ...quoteParams(quote), execution: "order", tx_hash: uid });
        return;
      }
      if (built.simulation && !built.simulation.ok)
        throw new Error(`Simulation failed: ${built.simulation.error ?? "reverted"}`);
      if (built.approval) {
        const ah = await sendTransactionAsync({
          to: built.approval.to,
          data: built.approval.data,
          value: BigInt(built.approval.value),
          chainId: built.approval.chainId,
        });
        await waitForTransactionReceipt(config, { hash: ah, chainId: fromChain });
      }
      const tx = built;
      const hash = await sendTransactionAsync({
        to: tx.to,
        data: tx.data,
        value: BigInt(tx.value),
        chainId: tx.chainId,
        ...(tx.gasLimit ? { gas: BigInt(tx.gasLimit) } : {}),
      });
      submitted.current = quote;
      track("swap_submitted", { ...quoteParams(quote), execution: "tx", tx_hash: hash });
      setPhase({
        k: "tracking",
        p: {
          provider: quote.provider,
          txHash: hash,
          fromChainId: fromChain,
          toChainId: toChain,
          mocked: false,
        },
      });
    } catch (e) {
      setPhase({ k: "error", msg: (e as Error).message.split("\n")[0] ?? "Swap failed" });
    }
  };

  const flip = () => {
    setFromChain(toChain);
    setToChain(fromChain);
    setFromToken(toToken);
    setToToken(fromToken);
    setAmountStr("");
  };

  if (phase.k === "order") {
    return (
      <Card>
        <div className="space-y-3 text-center">
          <p className="text-lg font-bold">
            CoW order submitted~ solvers will fill it, no gas for you!
          </p>
          <a className="underline" href={cowExplorer(phase.uid)} target="_blank" rel="noreferrer">
            Track order on CoW Explorer
          </a>
          <button
            type="button"
            className="block w-full rounded-xl bg-violet-800 py-2"
            onClick={() => {
              setPhase({ k: "idle" });
              setAmountStr("");
            }}
          >
            New swap
          </button>
        </div>
      </Card>
    );
  }

  if (phase.k === "tracking") {
    return (
      <Card>
        <StatusTracker
          p={phase.p}
          onSettled={setSettled}
          onReset={() => {
            setSettled(undefined);
            setPhase({ k: "idle" });
            setAmountStr("");
          }}
        />
      </Card>
    );
  }

  const chainList = chains.data?.data ?? [];
  const fromCh = characterForChain(fromChain);
  let cta: { label: string; action?: () => void } = { label: "Enter an amount" };
  if (!address)
    cta =
      fromVm === "svm"
        ? { label: "Connect a Solana wallet", action: sol.open }
        : fromVm === "bvm"
          ? { label: "Connect a Bitcoin wallet", action: btc.open }
          : fromVm === "tvm"
            ? {
                label: "Connect a Tron wallet",
                action: tron.open,
              }
            : { label: "Connect wallet to swap" };
  else if (needsRecipient && !recipient)
    cta = { label: `Enter your ${VM_NAME[toVm]} address to receive` };
  else if (recipientInvalid)
    cta = {
      label: `That's not a ${toVm === "uvm" ? (chainList.find((c) => c.id === toChain)?.name ?? "valid") : VM_NAME[toVm]} address`,
    };
  else if (amountInvalid) cta = { label: `Max ${fromToken?.decimals} decimals` };
  else if (amount === null) cta = { label: "Enter an amount" };
  else if (insufficient) cta = { label: `Not enough ${fromToken?.symbol}` };
  else if (!quote) cta = { label: quotes.isFetching ? "Finding routes…" : "No route" };
  else if (needsApproval)
    cta = {
      label: phase.k === "approving" ? "Approving…" : `Approve ${fromToken?.symbol}`,
      action: approve,
    };
  else
    cta = {
      label: phase.k === "swapping" ? "Confirm in wallet…" : quotesMocked ? "Swap (demo)" : "Swap!",
      action: swap,
    };
  const busy = phase.k === "approving" || phase.k === "swapping";

  return (
    <Card>
      {mocked && (
        <div
          className="mb-3 rounded-xl bg-amber-400/15 px-3 py-1.5 text-xs text-amber-200"
          data-testid="mock-banner"
        >
          Demo mode: API unreachable, showing mock routes. Nothing will be sent on-chain.
        </div>
      )}
      {tokenWarning && (
        <div
          className="mb-3 rounded-xl border border-amber-400/50 bg-amber-400/15 px-3 py-2 text-sm text-amber-200"
          data-testid="unverified-warning"
          role="alert"
        >
          ⚠ Unverified token: {tokenWarning}
        </div>
      )}
      <section className="rounded-2xl border-2 border-violet-700 bg-violet-900 p-3">
        <ChainPicker
          chains={chainList}
          value={fromChain}
          onChange={setFromChain}
          label="From"
          sending
        />
        <AmountField
          label="You pay"
          ariaLabel="Amount"
          value={amountStr}
          onChange={(v) => setAmountStr(sanitizeAmountInput(v))}
          invalid={amountInvalid}
          autoFocus
          right={
            <TokenPicker
              tokens={fromTokens.data?.data ?? []}
              value={fromToken}
              onChange={setFromToken}
              chainId={fromChain}
            />
          }
          footer={
            balance !== undefined && fromToken ? (
              <BalanceRow
                text={`${formatAmount(balance, fromToken.decimals)} ${fromToken.symbol}`}
                onPct={(pct) =>
                  setAmountStr(
                    formatAmount(
                      (balance * BigInt(pct)) / 100n,
                      fromToken.decimals,
                      fromToken.decimals,
                    ).replace(/,/g, ""),
                  )
                }
              />
            ) : null
          }
        />
      </section>

      <div className="relative z-10 -my-3 flex justify-center">
        <button
          hidden={lockTo}
          type="button"
          onClick={flip}
          aria-label="Flip"
          className="rounded-full border-4 border-violet-950 bg-amber-400 px-3 py-1 font-black text-violet-950 hover:rotate-180 transition"
        >
          ⇅
        </button>
      </div>

      <section className="rounded-2xl border-2 border-violet-700 bg-violet-900 p-3">
        <fieldset disabled={lockTo} className="contents" data-locked={lockTo || undefined}>
          <ChainPicker chains={chainList} value={toChain} onChange={setToChain} label="To" />
          <AmountReadout
            label="You receive"
            value={quote && toToken ? formatAmount(quote.toAmount, toToken.decimals) : "0.0"}
            right={
              <TokenPicker
                tokens={toTokens.data?.data ?? []}
                value={toToken}
                onChange={setToToken}
                chainId={toChain}
              />
            }
          />
        </fieldset>
        {needsRecipient && (
          <input
            aria-label="Recipient address"
            data-testid="recipient"
            placeholder={ownOnDest ?? `Your ${VM_NAME[toVm]} address`}
            value={recipientInput}
            onChange={(e) => {
              setRecipientInput(e.target.value);
              setRecipientFromLink(false);
            }}
            className={`mt-2 w-full rounded-xl bg-violet-950/70 px-3 py-2 font-mono text-xs outline-none ${recipientInvalid ? "text-rose-400" : "text-violet-100"}`}
          />
        )}
        {needsRecipient && recipientFromLink && recipient !== "" && recipient !== ownOnDest && (
          <p className="mt-2 text-xs font-bold text-amber-300" data-testid="recipient-link-warning">
            Heads up: this link sets the receiving address to {recipient}
            {ownOnDest ? `, not your connected wallet ${ownOnDest}` : ""}. Only continue if that
            address is yours or you meant to send there.
          </p>
        )}
      </section>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-violet-300">
        <div className="flex items-center gap-1">
          Slippage
          {SLIPPAGES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSlippage(s)}
              className={`rounded-full px-2 py-0.5 ${s === slippageBps ? "bg-amber-400 font-bold text-violet-950" : "bg-violet-800"}`}
            >
              {s / 100}%
            </button>
          ))}
        </div>
      </div>

      {!compact && request !== null && (
        <p
          className="mt-3 text-center text-xs font-semibold text-violet-200"
          data-testid="route-summary"
        >
          {quote
            ? `Best of ${qres?.quotes.length ?? 0} routes: ${quote.provider}`
            : quotes.isFetching
              ? "Finding routes…"
              : qres
                ? "No route for this pair"
                : ""}
        </p>
      )}
      {fromVm === "uvm" ? (
        <UtxoSend
          request={request}
          quote={quote}
          recipient={recipient}
          recipientInvalid={recipientInvalid}
          chainName={chainList.find((c) => c.id === fromChain)?.name ?? "this chain"}
          toChainName={chainList.find((c) => c.id === toChain)?.name ?? "the destination"}
        />
      ) : !address && fromVm === "evm" ? (
        <div className="mt-3" data-testid="connect-cta">
          <ConnectButton primary />
        </div>
      ) : (
        <button
          type="button"
          disabled={!cta.action || busy}
          onClick={cta.action}
          data-testid="swap-cta"
          className="mt-3 w-full cursor-pointer rounded-2xl border-2 border-violet-950 bg-amber-400 py-4 text-xl font-black text-violet-950 shadow-[0_4px_0_#2e1065] transition enabled:hover:bg-amber-300 enabled:active:translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {cta.label}
        </button>
      )}
      <div className="mt-4">
        {compact ? (
          <p className="text-center text-xs text-violet-300" data-testid="compact-route">
            {quote
              ? `Best of ${qres?.quotes.length ?? 0} routes: ${quote.provider}`
              : request && quotes.isFetching
                ? "Finding routes…"
                : request && qres
                  ? "No route for this pair"
                  : "Type an amount to compare routes"}
          </p>
        ) : request === null ? (
          <div
            className="flex items-center justify-center gap-3 py-2 text-sm text-violet-300"
            data-testid="empty-state"
          >
            <Character who={fromCh.key} size={48} mood="idle" />
            <span>
              {fromChain === toChain
                ? `${fromCh.name} is ready to swap.`
                : `${fromCh.name} → ${characterForChain(toChain).name}: cross-chain!`}
              <br />
              Type an amount and Swap-chan will find the best route.
            </span>
          </div>
        ) : quotes.isLoading ? (
          <RoutesLoading from={fromChain} to={toChain} />
        ) : quotes.isError ? (
          <SpeechBubble who="swapchan">
            Uwaa, the quote service said: {(quotes.error as Error).message}
          </SpeechBubble>
        ) : qres && qres.quotes.length === 0 ? (
          <div className="flex flex-col items-center py-4 text-sm text-violet-300">
            <Character who="swapchan" size={90} mood="sad" />
            No routes found for this pair. Try another token or amount.
          </div>
        ) : qres && toToken ? (
          <RouteList
            quotes={qres.quotes}
            best={qres.best}
            selected={selected}
            onSelect={setSelected}
            toToken={toToken}
            errors={qres.errors}
          />
        ) : null}
      </div>

      {phase.k === "error" && (
        <div className="mt-3">
          <SpeechBubble who="swapchan">
            <span className="text-rose-300">Gomen! {phase.msg}</span>{" "}
            <button type="button" className="underline" onClick={() => setPhase({ k: "idle" })}>
              dismiss
            </button>
          </SpeechBubble>
        </div>
      )}
    </Card>
  );
}

export function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full max-w-lg rounded-3xl border-2 border-violet-500 bg-violet-950 p-4 shadow-[0_0_60px_rgba(168,85,247,.25)]">
      {children}
    </div>
  );
}
