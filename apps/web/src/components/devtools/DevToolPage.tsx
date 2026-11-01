import Link from "next/link";
import { DEV_TOOLS, type DevTool, devToolLd } from "@/lib/devTools";
import { DevToolForm } from "./DevToolForm";
import { PoweredBy } from "./PoweredBy";

const CHAIN_LINKED = new Set([
  "validate-address",
  "convert-address",
  "chain-params",
  "supported-chains",
]);

const RECIPE: Record<string, string> = {
  "evm-abi": "evm-decode-calldata",
  "create-address": "evm-contract-address",
  "bytecode-inspect": "evm-inspect-contract",
  "typed-data-verify": "evm-eip712-verify",
};

/** Shared layout for every /tools/<slug> developer tool: H1, form, copy, FAQ, related, JSON-LD. */
export function DevToolPage({ tool }: { tool: DevTool }) {
  const related = tool.related
    .map((s) => DEV_TOOLS.find((t) => t.slug === s))
    .filter((t): t is DevTool => !!t);
  return (
    <article className="w-full" data-testid="devtool-page">
      <script type="application/ld+json">{JSON.stringify(devToolLd(tool))}</script>
      <h1 className="text-2xl font-black md:text-3xl">{tool.h1}</h1>
      <p className="mb-4 text-sm text-violet-200 md:text-base">{tool.intro}</p>
      {tool.warning && (
        <p className="mb-4 rounded-xl border border-amber-400 bg-amber-400/10 p-3 text-sm font-bold text-amber-200">
          {tool.warning}
        </p>
      )}
      <DevToolForm tool={tool} />
      <section className="mt-8 space-y-3 text-violet-100">
        {tool.body.map((p) => (
          <p key={p.slice(0, 32)}>{p}</p>
        ))}
        <p className="text-sm text-violet-300">
          AI agents can run this through the SwapChan MCP tool <code>{tool.mcp}</code>.{" "}
          <Link href="/agents" className="underline hover:text-amber-300">
            Set up MCP
          </Link>
        </p>
        {RECIPE[tool.slug] && (
          <p className="text-sm">
            <Link
              href={`/blocktools/recipes/${RECIPE[tool.slug]}`}
              className="underline hover:text-amber-300"
            >
              Recipe
            </Link>
          </p>
        )}
        {CHAIN_LINKED.has(tool.slug) && (
          <p className="text-sm text-violet-300">
            Address format, prefixes and decimals per chain:{" "}
            <Link href="/chains" className="underline hover:text-amber-300">
              browse all chains
            </Link>
            .
          </p>
        )}
      </section>
      <section className="mt-8">
        <h2 className="mb-3 text-xl font-black">FAQ</h2>
        <dl className="space-y-3">
          {tool.faq.map((f) => (
            <div key={f.q}>
              <dt className="font-bold">{f.q}</dt>
              <dd className="text-violet-200">{f.a}</dd>
            </div>
          ))}
        </dl>
      </section>
      {related.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-xl font-black">Related tools</h2>
          <ul className="flex flex-wrap gap-2">
            {related.map((r) => (
              <li key={r.slug}>
                <Link
                  href={`/tools/${r.slug}`}
                  className="block rounded-full border border-violet-500 px-3 py-1 text-sm hover:border-amber-300"
                >
                  {r.emoji} {r.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <footer className="mt-10 border-t border-violet-800 pt-4 text-xs text-violet-400">
        <PoweredBy />
      </footer>
    </article>
  );
}
