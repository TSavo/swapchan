import type { Metadata } from "next";
import Link from "next/link";
import { AgentCTAs } from "@/components/AgentCTA";
import { SpeechBubble } from "@/components/Character";
import { Recover } from "@/components/tools/Recover";
import { RelatedTools } from "@/components/tools/RelatedTools";
import { SolRecover, type SolSpec } from "@/components/tools/SolRecover";
import { SweepRecover } from "@/components/tools/SweepRecover";
import { TronRecover, type TronSpec } from "@/components/tools/TronRecover";
import { verifyRecoverSig } from "@/lib/recoverSig";
import { safeNext } from "@/lib/safeNext";

export const metadata: Metadata = {
  title: "Recover an old crypto wallet (seed, keystore, presale) | SwapChan",
  description:
    "Step 1 of safe signing: recover BIP39 seeds, missing words, keystores, 2014-15 Ethereum presale wallets, Electrum, wallet.dat and hardware wallets LOCALLY and OFFLINE. Never paste a phrase into chat. Then find_money, verify_tx, human signs, broadcast.",
  alternates: { canonical: "/recover" },
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const q = await searchParams;
  const next = safeNext(q.next);
  if (q.tron) {
    let spec: TronSpec | null = null;
    try {
      spec = JSON.parse(Buffer.from(q.tron, "base64url").toString()) as TronSpec;
    } catch {}
    if (spec?.endpoint && spec.body)
      return (
        <main className="flex min-h-screen flex-col items-center px-4 py-10 text-white">
          <TronRecover spec={spec} title={q.title ?? "Recover TRX"} {...(next ? { next } : {})} />
        </main>
      );
  }
  if (q.sol) {
    let spec: SolSpec | null = null;
    try {
      spec = JSON.parse(Buffer.from(q.sol, "base64url").toString()) as SolSpec;
    } catch {}
    if (spec?.owner && Array.isArray(spec.ix))
      return (
        <main className="flex min-h-screen flex-col items-center px-4 py-10 text-white">
          <SolRecover spec={spec} title={q.title ?? "Recover SOL"} {...(next ? { next } : {})} />
        </main>
      );
  }
  if (
    (q.sweep === "utxo" || q.sweep === "fork" || q.sweep === "evm") &&
    q.coin?.match(/^[a-z]{2,10}$/) &&
    q.from?.match(/^[A-Za-z0-9:]{20,100}$/)
  )
    return (
      <main className="flex min-h-screen flex-col items-center px-4 py-10 text-white">
        <SweepRecover
          kind={q.sweep}
          coin={q.coin}
          {...(q.token?.match(/^0x[0-9a-fA-F]{40}$/) ? { token: q.token } : {})}
          from={q.from}
          sym={(q.sym ?? q.coin).slice(0, 8)}
          title={q.title ?? "Sweep coins"}
        />
      </main>
    );
  const ok = q.to?.match(/^0x[0-9a-fA-F]{40}$/) && q.data?.match(/^0x[0-9a-fA-F]*$/);
  if (ok && !(q.owner?.match(/^0x[0-9a-fA-F]{40}$/) && verifyRecoverSig(q)))
    return (
      <main className="flex min-h-screen flex-col items-center px-4 py-10 text-white">
        <div
          className="w-full max-w-2xl rounded-2xl border-2 border-rose-400 bg-rose-950 p-6"
          data-testid="recover-unsigned"
        >
          <h1 className="text-2xl font-black">This recovery link wasn&apos;t made by SwapChan</h1>
          <p className="mt-2">
            Its signature is missing or doesn&apos;t match, so I won&apos;t show it or let you sign
            it. Run find_money again for your wallet to get a fresh link.
          </p>
        </div>
      </main>
    );
  if (ok) {
    return (
      <main className="flex min-h-screen flex-col items-center px-4 py-10 text-white">
        <Recover
          chain={Number(q.chain ?? 1)}
          to={q.to as `0x${string}`}
          data={q.data as `0x${string}`}
          value={q.value ?? "0"}
          title={q.title ?? "Recover funds"}
          owner={q.owner as `0x${string}`}
          next={next}
        />
      </main>
    );
  }
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-10 px-4 py-10 text-white">
      <header className="flex flex-col gap-4">
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-end">
          <img
            src="/characters/full/swapchan.webp"
            alt="Swap-chan"
            width={832}
            height={1088}
            className="animate-float w-36 shrink-0 drop-shadow-[0_0_30px_rgba(217,70,239,0.55)] sm:w-44"
          />
          <div className="relative mb-6 rounded-2xl border-2 border-amber-400/60 bg-violet-950/90 px-4 py-3 text-violet-100 shadow-[0_0_24px_rgba(217,70,239,0.35)]">
            <b className="text-amber-300">Lost the key, not the money?</b> SwapChan is here to help
            you find your money, senpai. First we get the key back on YOUR machine, offline. I never
            see your seed. Then we hunt for stuck funds and you sign every step yourself.
          </div>
        </div>
        <h1 className="text-4xl font-black">Recover an old crypto wallet</h1>
      </header>

      <section className="rounded-2xl border-2 border-rose-400 bg-rose-950 p-6">
        <h2 className="text-2xl font-black">Warnings (read these)</h2>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li>
            NEVER paste a seed phrase, private key, wallet file or password into a chat, an AI
            prompt, an email, or ANY website, including SwapChan.
          </li>
          <li>
            Run recovery code on your own machine, ideally offline. Agents write a local script; you
            run it.
          </li>
          <li>Only PUBLIC addresses leave your machine. Those go to find_money.</li>
          <li>
            &quot;Wallet recovery services&quot; that DM you or ask for your phrase are scams. Use
            open-source tools locally.
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-2xl font-black">What do you have?</h2>
        <ul className="grid gap-3 md:grid-cols-2">
          {(
            [
              [
                "/recover/seed-phrase",
                "BIP39 seed phrase (12/24 words)",
                "MetaMask, Ledger sheet, Trezor, Phantom, Trust…",
              ],
              [
                "/recover/keystore",
                "Ethereum keystore v3 JSON",
                "geth, Mist, MEW, Parity, MyCrypto",
              ],
              [
                "/recover/ethereum-presale-wallet-2015",
                "2014–15 Ethereum crowdsale wallet",
                "The original ethereum.org JSON with encseed",
              ],
              [
                "/find-money",
                "Old coins on a key you still control",
                "BCH, BTG, LTC, DOGE, DASH, ZEC t1, QTUM, GRS and 20+ more: unsigned sweep, sign offline in the coin's wallet",
              ],
              [
                "/agents/secure-signing",
                "Full signing guide (all branches)",
                "Missing word, passphrase, Electrum, wallet.dat, hardware…",
              ],
              [
                "/tools/key-recovery",
                "Why keys never touch SwapChan",
                "Where key derivation and recovery happen instead (your machine)",
              ],
            ] as const
          ).map(([href, t, d]) => (
            <li key={href}>
              <Link
                href={href}
                className="block rounded-2xl border border-fuchsia-400/50 bg-violet-950 p-4 hover:border-amber-300"
              >
                <div className="font-black">{t}</div>
                <div className="text-sm text-violet-200">{d}</div>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3 rounded-2xl border-2 border-fuchsia-400 bg-violet-950 p-6">
        <h2 className="text-2xl font-black">Use this in your agent</h2>
        <p>
          Call the MCP tool <code>signing_guide</code> (or <code>recovery_guide</code>). Pass{" "}
          <code>situation</code> for one branch, or <code>situation=full</code> for the complete
          playbook in-context: every method, decision tree, derivation paths and blocktools
          commands. Example prompt:
        </p>
        <blockquote className="rounded-xl bg-violet-900 p-4 text-lg font-bold">
          “Help me recover my old wallet. Here’s what I still have: …”
        </blockquote>
        <p className="text-sm text-violet-200">
          Loop: recovery_guide → public addresses → find_money → verify_tx → human signs locally →
          broadcast_tx.
        </p>
        <AgentCTAs />
      </section>

      <p className="text-sm text-violet-300">
        Already have a recovery transaction from find_money? Open the permanent link it gave you (it
        includes <code>?to=&amp;data=</code>) and sign step 1 here, then swap.
      </p>
      <RelatedTools ctx="recover" />
    </main>
  );
}
