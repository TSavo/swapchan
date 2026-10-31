"use client";

import { useEffect, useState } from "react";
import { decodeFunctionData, formatEther, parseAbi } from "viem";
import { useAccount, useSendTransaction, useSwitchChain } from "wagmi";
import { SpeechBubble } from "@/components/Character";
import { ConnectButton } from "@/components/ConnectButton";
import { FullAddress } from "@/components/FullAddress";
import { describeCall, explorerAddressUrl } from "@/lib/callSummary";
import { localCallPaysOwner, ownerMatches } from "@/lib/recoverCheck";
import { RelatedTools } from "./RelatedTools";

const ABI = parseAbi([
  "function withdraw()",
  "function exit()",
  "function getReward()",
  "function claim()",
  "function claim(uint256 index, address account, uint256 amount, bytes32[] merkleProof)",
  "function claimRewards()",
  "function withdraw(uint256 amount)",
  "function redeem(uint256 shares, address receiver, address owner)",
  "function withdrawToken(address token, uint256 amount)",
  "function claimComp(address holder)",
  "function claimVenus(address holder)",
  "function claimWithdrawal(uint256 requestId)",
  "function claimCollateral()",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params)",
]);
// Liquidity / Pendle exits (v2 removeLiquidity, v3 multicall(decrease,collect), v4 modifyLiquidities,
// Pendle exitPostExpToToken, SY redeem): sandwichable in the public mempool, so suggest a private RPC.
const EXIT_SELECTORS = ["0xbaa2abde", "0xac9650d8", "0xdd46508f", "0xf06a07a0", "0x769f8e5d"];
const CHAINS: Record<number, string> = {
  1: "Ethereum",
  8453: "Base",
  10: "Optimism",
  42161: "Arbitrum",
  137: "Polygon",
  56: "BNB Chain",
  43114: "Avalanche",
};
const show = (v: unknown): string =>
  typeof v === "bigint"
    ? v.toString()
    : typeof v === "object" && v
      ? JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x))
      : String(v);

export function Recover(p: {
  chain: number;
  to: `0x${string}`;
  data: `0x${string}`;
  value: string;
  title: string;
  /** wallet the scan was for (signed into the link) */
  owner: `0x${string}`;
  next?: string;
}) {
  const { address, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const [hash, setHash] = useState<string>();
  const [err, setErr] = useState<string>();
  let call: { functionName: string; args?: readonly unknown[] } | undefined;
  try {
    call = decodeFunctionData({ abi: ABI, data: p.data });
  } catch {}
  // calls outside the local ABI (Pendle exit, v4, Safe sweep, ENS deed...) are checked by the API's recovery
  // verifier against the connected wallet: only calls whose every output pays you are signable.
  const [remote, setRemote] = useState<{ verified: boolean; call?: string; reason?: string }>();
  const known = !!call;
  useEffect(() => {
    if (known || !address) return;
    const q = new URLSearchParams({
      to: p.to,
      data: p.data,
      value: p.value || "0",
      owner: address,
    });
    fetch(`https://api.swapchan.com/onchain/recover-verify?${q}`)
      .then((r) => r.json())
      .then(setRemote)
      .catch(() => setRemote({ verified: false, reason: "verifier unreachable" }));
  }, [known, address, p.to, p.data, p.value]);
  // Locally decoded calls still need every receiver/holder to be the connected wallet.
  const sig = describeCall(p.to, p.data);
  const wrongWallet = !!address && !ownerMatches(p.owner, address);
  const safe =
    !wrongWallet &&
    (known ? localCallPaysOwner(call, address) : !!remote?.verified) &&
    p.value === "0";
  return (
    <div className="flex w-full max-w-2xl flex-col gap-4" data-testid="recover">
      <div className="flex items-end gap-3">
        <SpeechBubble who="swapchan">
          {hash
            ? "Yay, it's back in your wallet! Now let's turn it into USDC, senpai!"
            : "I found your money, senpai! Step 1: sign this to pull it out. Step 2: I swap it to USDC."}
        </SpeechBubble>
      </div>
      <div className="rounded-2xl border-2 border-violet-600 bg-violet-950 p-4 text-sm">
        <p className="text-xs font-bold text-violet-300">Step 1 of 2 · recover</p>
        <h1 className="text-xl font-black">{p.title}</h1>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs break-all">
          <dt className="text-violet-400">chain</dt>
          <dd data-testid="chain">
            {CHAINS[p.chain] ?? p.chain} ({p.chain})
          </dd>
          <dt className="text-violet-400">to</dt>
          <dd>
            <FullAddress address={p.to} testId="to" />
            {explorerAddressUrl(Number(p.chain), p.to) && (
              <>
                {" "}
                <a
                  href={explorerAddressUrl(Number(p.chain), p.to)}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                  data-testid="to-explorer"
                >
                  explorer
                </a>
              </>
            )}
          </dd>
          <dt className="text-violet-400">function</dt>
          <dd data-testid="function">
            {sig.fn ?? (remote?.verified && remote.call) ?? "unknown"} [{sig.selector}]
          </dd>
          <dt className="text-violet-400">call</dt>
          <dd data-testid="call">
            {call
              ? `${call.functionName}(${(call.args ?? []).map(show).join(", ")})`
              : remote?.verified
                ? `${remote.call} (verified: pays your wallet)`
                : address
                  ? `not verified${remote?.reason ? `: ${remote.reason}` : ""}`
                  : "connect your wallet to verify this call"}
          </dd>
          <dt className="text-violet-400">value</dt>
          <dd>{formatEther(BigInt(p.value || "0"))} (sends nothing)</dd>
          <dt className="text-violet-400">data</dt>
          <dd data-testid="data">{p.data}</dd>
        </dl>
        {EXIT_SELECTORS.includes(p.data.slice(0, 10).toLowerCase()) && (
          <p className="mt-2 text-amber-200" data-testid="private-submission-note">
            This exit removes liquidity or swaps, so a bot could sandwich it in the public mempool.
            Its minimum outputs come from a live quote (1% slippage) and it expires 20 minutes after
            it was built. For extra protection, send it through a private RPC such as Flashbots
            Protect (rpc.flashbots.net) or MEV Blocker (rpc.mevblocker.io) in your wallet first.
          </p>
        )}
        {wrongWallet && (
          <p className="mt-2 font-bold text-rose-300" data-testid="wrong-wallet">
            I found this for {p.owner}, connect that wallet.
          </p>
        )}
        {!safe && !wrongWallet && (
          <p className="mt-2 font-bold text-rose-300">
            I don't recognise this call as a withdraw-to-you, so I won't let you sign it here.
          </p>
        )}
        {known && address && !wrongWallet && !localCallPaysOwner(call, address) && (
          <p className="mt-2 font-bold text-rose-300">
            This call pays or moves funds for someone other than the connected wallet. Don't sign.
          </p>
        )}
        {address && safe && !hash && (
          <p
            className="mt-3 rounded-lg bg-violet-900 p-2 font-mono text-xs break-all"
            data-testid="sign-prompt"
          >
            You are about to sign <b>{sig.fn ?? remote?.call ?? sig.selector}</b> on contract{" "}
            <FullAddress address={p.to} /> ({CHAINS[p.chain] ?? p.chain}). Check your wallet shows
            the same contract and function.
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {!address ? (
            <ConnectButton />
          ) : (
            <button
              type="button"
              disabled={!safe || !!hash}
              onClick={async () => {
                setErr(undefined);
                try {
                  if (chainId !== p.chain) await switchChainAsync({ chainId: p.chain });
                  setHash(await sendTransactionAsync({ to: p.to, data: p.data, value: 0n }));
                } catch (e) {
                  setErr((e as Error).message.split("\n")[0]);
                }
              }}
              className="rounded-lg border-2 border-violet-950 bg-amber-400 px-4 py-2 font-black text-violet-950 disabled:opacity-50"
            >
              {hash ? "Signed ✓" : "Sign recovery in my wallet"}
            </button>
          )}
        </div>
        {hash && <p className="mt-2 font-mono text-xs break-all">tx {hash}</p>}
        {err && <p className="mt-2 text-xs text-rose-300">{err}</p>}
      </div>
      {p.next && (
        <a
          href={p.next}
          data-testid="next"
          className="rounded-2xl border-2 border-emerald-500 bg-emerald-950 p-4 font-bold"
        >
          Step 2 of 2 · swap it to USDC on SwapChan →
        </a>
      )}
      <p className="text-xs text-violet-400">
        You sign in your own wallet; SwapChan never holds your keys or funds. The call is decoded
        above so you can check it first.
      </p>
      <RelatedTools ctx="recover" />
    </div>
  );
}
