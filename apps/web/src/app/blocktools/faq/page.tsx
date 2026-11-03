import Link from "next/link";
import { BtPage, btMeta, JsonLd } from "@/components/blocktools/BtPage";
import { BT_REPO, renderMd } from "@/lib/blocktools.server";

export const metadata = btMeta(
  "/blocktools/faq",
  "blocktools FAQ and troubleshooting",
  "Answers about blocktools: what it is, platforms, safety, and fixes for bad_input, refusals, sealed-run errors, Alpine, wasm and unsupported chains.",
);

const QA: [string, string][] = [
  [
    "What is blocktools?",
    "An open source (MIT) set of small Rust command-line tools that pass JSON lines through pipes. They read wallet files and seed phrases, derive addresses, and build, verify and sign transactions offline.",
  ],
  [
    "Which chains?",
    "The chain table lists each supported chain, from Bitcoin and Ethereum to Solana, Tron, XRP, Cosmos, Cardano, Polkadot and TON, plus many older Bitcoin forks. Sweep building is per chain: check the table.",
  ],
  [
    "Which platforms?",
    "Release binaries: Linux x86_64, glibc 2.39 or newer. Sealed runs (./blocktools build) need a v0.4.0 source checkout and Docker, not just the tarball. No macOS, Windows or ARM binaries yet.",
  ],
  [
    "Does SwapChan see my keys?",
    "No. SwapChan's web tools and MCP use only public input. Anything secret runs in the CLI on your machine, sealed and offline.",
  ],
  [
    "Is it safe with real money?",
    "The README warns it is dangerous with real funds: read and audit it first, and run secret steps offline.",
  ],
];

export default function Faq() {
  return (
    <BtPage title="FAQ and troubleshooting" source={`${BT_REPO}/blob/main/docs/troubleshooting.md`}>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: QA.map(([q, a]) => ({
            "@type": "Question",
            name: q,
            acceptedAnswer: { "@type": "Answer", text: a },
          })),
        }}
      />
      <dl className="mb-10 space-y-3">
        {QA.map(([q, a]) => (
          <div key={q} className="rounded-xl border border-violet-500/70 bg-violet-900/30 p-4">
            <dt className="font-black text-amber-300">{q}</dt>
            <dd className="mt-1 text-sm">{a}</dd>
          </div>
        ))}
      </dl>
      <h2 className="mb-3 text-2xl font-black">Troubleshooting</h2>
      <div
        className="bt-md"
        dangerouslySetInnerHTML={{ __html: renderMd("docs/troubleshooting.md") }}
      />
      <p className="mt-6 text-sm">
        <Link href="/blocktools/docs" className="underline">
          All docs
        </Link>
      </p>
    </BtPage>
  );
}
