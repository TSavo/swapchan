import Link from "next/link";
import { BtPage, btMeta } from "@/components/blocktools/BtPage";
import { BT_GROUPS, BT_ON_SWAPCHAN } from "@/lib/blocktools";
import { BT_REPO } from "@/lib/blocktools.server";
import { BT_TOOLS } from "@/lib/blocktoolsManifest";

export const metadata = btMeta(
  "/blocktools/commands",
  "blocktools commands reference",
  "blocktools man(1) pages (58 in v0.4.0, including the blocktools wrapper and recover.sh) with their man page summaries: wallet readers, address derivation, transaction build, verify, sign and broadcast, contract tools and pipeline plumbing.",
);

export default function Commands() {
  const desc = Object.fromEntries(BT_TOOLS.map((t) => [t.name, t.desc]));
  const web = Object.fromEntries(BT_ON_SWAPCHAN.map((w) => [w.tool, w]));
  return (
    <BtPage
      title="Commands"
      lead={
        <p>
          {BT_GROUPS.reduce((n, g) => n + g.tools.length, 0)} of the 58 man(1) pages in v0.4.0,
          grouped by job (<code>man blocktools</code> lists them all). Summaries are the
          man pages&apos; NAME lines.
        </p>
      }
      source={`${BT_REPO}/tree/main/man/man1`}
    >
      {BT_GROUPS.map((g) => (
        <section key={g.id} className="mb-8">
          <h2 className="text-xl font-black">{g.label}</h2>
          <p className="mb-3 text-sm text-violet-300">{g.blurb}</p>
          <dl className="divide-y divide-violet-500/30 rounded-xl border border-violet-500/70 bg-violet-900/30">
            {g.tools.map((t) => (
              <div key={t} id={t} className="scroll-mt-24 p-3 md:flex md:gap-4">
                <dt className="shrink-0 font-mono font-bold text-amber-300 md:w-44">{t}</dt>
                <dd className="text-sm text-violet-100">
                  {desc[t] ?? ""}
                  {web[t] && (
                    <>
                      {" "}
                      ·{" "}
                      <Link href={web[t].href} className="text-fuchsia-300 underline">
                        try it on SwapChan: {web[t].label}
                      </Link>
                    </>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </BtPage>
  );
}
