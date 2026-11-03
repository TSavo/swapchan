import Link from "next/link";
import { BtPage, btMeta, JsonLd } from "@/components/blocktools/BtPage";
import { CopyCode } from "@/components/blocktools/CopyCode";
import { BT_EXAMPLES, BT_GROUPS, BT_INSTALL, BT_SOURCE_BUILD } from "@/lib/blocktools";
import { BT_REPO, BT_TAG, getReleases, mb, pinnedRelease } from "@/lib/blocktools.server";
import { BT_ITEMS } from "@/lib/blocktoolsManifest";
import { DEV_TOOLS } from "@/lib/devTools";

export const revalidate = 3600;
export const metadata = btMeta(
  "/blocktools",
  "blocktools: one CLI, many chains",
  "blocktools is an open source (MIT) command-line toolkit for blockchains: 56 command-line tools that read wallets, derive addresses and build, check and sign transactions offline across many chains; see the chain table for what each supports.",
);

const btnPrimary =
  "inline-flex items-center gap-2 rounded-full bg-amber-400 px-6 py-3 text-lg font-black text-violet-950 shadow-[0_0_28px_rgba(251,191,36,0.5)] transition hover:bg-amber-300";
const btnGhost =
  "inline-flex items-center gap-2 rounded-full border-2 border-violet-400 px-6 py-3 text-lg font-black text-violet-50 transition hover:border-amber-300 hover:text-amber-300";
const card = "rounded-2xl border border-violet-500/60 bg-violet-900/30 p-5";
const H2 = ({
  id,
  kicker,
  children,
}: {
  id: string;
  kicker: string;
  children: React.ReactNode;
}) => (
  <div className="mb-6">
    <div className="font-mono text-xs font-bold tracking-widest text-fuchsia-300 uppercase">
      {kicker}
    </div>
    <h2 id={id} className="mt-1 text-3xl font-black">
      {children}
    </h2>
  </div>
);
const Guide = ({ children }: { children: React.ReactNode }) => (
  <div className="mt-5 flex items-start gap-3">
    <img
      src="/characters/swapchan.png"
      alt="Swap-chan"
      width={44}
      height={44}
      className="h-11 w-11 shrink-0 rounded-full bg-violet-950 object-cover object-top ring-2 ring-fuchsia-400"
    />
    <p className="rounded-2xl rounded-tl-none border border-fuchsia-400/50 bg-violet-950/70 px-4 py-2 text-sm text-violet-100">
      {children}
    </p>
  </div>
);

export default async function BlocktoolsHome() {
  const { releases } = await getReleases();
  const latest = pinnedRelease(releases);
  const tarball = latest?.assets.find((a) => a.name.endsWith(".tar.gz"));
  const sums = latest?.assets.find((a) => a.name === "SHA256SUMS");
  const docs = BT_ITEMS.filter((i) => i.kind === "docs");
  const recipes = BT_ITEMS.filter((i) => i.kind === "recipes");
  const tag = BT_TAG;

  const Ctas = () => (
    <div className="flex flex-wrap items-center gap-3">
      <a href={tarball?.url ?? `${BT_REPO}/releases`} className={btnPrimary}>
        ⬇ Download {tag}
      </a>
      <a href={BT_REPO} className={btnGhost} rel="noopener">
        View on GitHub
      </a>
    </div>
  );

  return (
    <BtPage title="All chains, one CLI" bare>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "blocktools",
          applicationCategory: "DeveloperApplication",
          operatingSystem: "Linux x86_64 (release binaries); source build",
          softwareVersion: tag,
          license: "https://opensource.org/licenses/MIT",
          url: "https://swapchan.com/blocktools",
          downloadUrl: tarball?.url,
          sameAs: BT_REPO,
          description:
            "Command-line toolkit for blockchains: reads wallet files and seed phrases, derives addresses, and builds, checks and signs transactions offline.",
        }}
      />

      {/* Header strip */}
      <div className="mb-8 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-violet-500/50 bg-violet-950/60 px-4 py-2 text-sm">
        <span className="font-mono font-black text-amber-300">blocktools</span>
        <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-xs font-bold text-emerald-300">
          {tag} · {latest?.date.slice(0, 10)}
        </span>
        <span className="text-violet-300">MIT · Rust</span>
        <a
          href={BT_REPO}
          rel="noopener"
          className="ml-auto font-bold text-violet-100 hover:text-amber-300"
        >
          ★ GitHub
        </a>
      </div>

      {/* Hero */}
      <section className="relative grid items-center gap-8 md:grid-cols-[1fr_220px]">
        <div className="min-w-0">
          <div className="font-mono text-xs font-bold tracking-widest text-fuchsia-300 uppercase">
            blocktools CLI
          </div>
          <h1 className="mt-2 bg-gradient-to-r from-amber-200 via-amber-300 to-fuchsia-400 bg-clip-text text-5xl leading-[1.05] font-black text-transparent md:text-6xl">
            All chains, one CLI
          </h1>
          <p className="mt-4 max-w-2xl text-lg text-violet-100">
            56 command-line tools that read wallet files and seed phrases, derive addresses, and
            build, check and sign transactions, offline. Pipe them together. No browser, no wallet
            app.
          </p>
          <div className="mt-6">
            <Ctas />
          </div>
          <p className="mt-3 text-xs text-violet-400">
            {tarball ? `${tarball.name} · ${mb(tarball.size)}` : ""} · Linux x86_64, glibc 2.39+ for
            the full set (54 of 56 binaries need 2.34; sealed-run and tx-decode need 2.39; objdump
            -T on the published tarball, not CI-stamped) · verify with{" "}
            {sums ? (
              <a href={sums.url} className="underline">
                SHA256SUMS
              </a>
            ) : (
              "SHA256SUMS"
            )}{" "}
            · no macOS, Windows or ARM build yet (
            <Link href="/blocktools/binaries" className="underline">
              platforms
            </Link>
            )
          </p>
          <div className="mt-5 max-w-2xl">
            <CopyCode code={`gh release download ${tag} -R TSavo/blocktools`} wrap />
          </div>
        </div>
        <div className="hidden flex-col items-center md:flex">
          <img
            src="/characters/full/swapchan.webp"
            alt="Swap-chan, your guide"
            width={832}
            height={1088}
            className="animate-float w-44 drop-shadow-[0_0_30px_rgba(217,70,239,0.6)]"
          />
          <p className="-mt-2 rounded-xl border border-fuchsia-400/70 bg-violet-950/90 px-3 py-2 text-center text-xs text-violet-100">
            SwapChan&apos;s developer tools are built on it. Here&apos;s the tour.
          </p>
        </div>
      </section>

      {/* Terminal demo */}
      <section className="mt-12 overflow-hidden rounded-2xl border border-violet-500/70 bg-[#0d0618] shadow-[0_0_50px_rgba(124,58,237,0.25)]">
        <div className="flex items-center gap-1.5 border-b border-violet-500/40 bg-violet-950 px-4 py-2">
          <span className="h-3 w-3 rounded-full bg-rose-400" />
          <span className="h-3 w-3 rounded-full bg-amber-300" />
          <span className="h-3 w-3 rounded-full bg-emerald-400" />
          <span className="ml-3 font-mono text-xs text-violet-400">
            sealed run · public BIP39 test phrase
          </span>
        </div>
        <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed text-violet-100">
          <span className="text-fuchsia-300">$</span> ./blocktools run &apos;classify
          /in/seed.txt&apos;{"\n"}
          <span className="text-violet-400">
            {"…"}&quot;class&quot;:&quot;mnemonic&quot;{"…"}
          </span>
          {"\n\n"}
          <span className="text-fuchsia-300">$</span> ./blocktools run &apos;seed-repair &lt;
          /in/seed.txt | seed-to-master | derive --chain btc --count 1&apos;{"\n"}
          <span className="text-emerald-300">
            {"…"}1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA{"…"}
          </span>
          {"\n"}
          <span className="text-emerald-300">
            {"…"}bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu{"…"}
          </span>
          {"\n"}
          <span className="text-violet-500"># key fields print as [REDACTED]</span>
        </pre>
        <p className="border-t border-violet-500/30 px-5 py-2 text-xs text-violet-400">
          Commands and expected addresses from the repo&apos;s Getting started; CI checks these
          values. Output trimmed to the checked fields.
        </p>
      </section>

      {/* Why */}
      <section className="mt-20">
        <H2 id="why" kicker="Why blocktools">
          One toolkit, chain by chain
        </H2>
        <div className="grid gap-4 sm:grid-cols-2">
          {[
            [
              "⛓️",
              "One tool, many chains",
              "Bitcoin and its forks, Ethereum and EVM, Solana, Tron, XRP, Cosmos, Cardano, Polkadot, TON and older Bitcoin forks, each marked in the chain table with what is built: some chains are address checking only, others can also be signed.",
            ],
            [
              "💻",
              "Runs on your machine",
              "A local CLI. Pipelines that touch a secret run sealed: no network, read-only filesystem, all capabilities dropped.",
            ],
            [
              "🔓",
              "Open source (MIT)",
              "Source, 58 man(1) pages and the recipes are on GitHub, so you can read it before you trust it.",
            ],
            [
              "🔒",
              "Secrets stay local",
              "Passwords live in ./secrets, never on the command line. Key fields print as [REDACTED].",
            ],
          ].map(([i, h, t]) => (
            <div key={h} className={card}>
              <div className="text-2xl">{i}</div>
              <h3 className="mt-2 text-lg font-black text-amber-300">{h}</h3>
              <p className="mt-1 text-sm text-violet-100">{t}</p>
            </div>
          ))}
        </div>
        <Guide>
          It&apos;s a set of tiny blades: each tool does one job and speaks JSON lines, so you snap
          them together with pipes.
        </Guide>
      </section>

      {/* Features */}
      <section className="mt-20">
        <H2 id="features" kicker="Highlights">
          What&apos;s in the box
        </H2>
        <ul className="grid gap-x-8 gap-y-4 text-sm md:grid-cols-2">
          {[
            [
              "Wallet readers",
              "wallet.dat, Ethereum keystores, Electrum, MultiBit, Armory, BIP38 and seed phrases (typos repaired).",
            ],
            [
              "Address derivation",
              "derive, key-to-addresses and xpub-addresses across the chain table.",
            ],
            [
              "Transactions",
              "tx-build, tx-verify, tx-sign and tx-broadcast, with policy files that cap destinations, amounts and fees.",
            ],
            [
              "Node RPC",
              "rpc talks to EVM, bitcoind, Solana, Tron, Cosmos, Esplora and Blockbook, refusing key-export and wallet-signing methods by default.",
            ],
            [
              "Sealed runs",
              "./blocktools run in Docker with --network none; only ./blocktools reveal, at a real terminal after a typed code, prints keys. reveal runs through the same sealed Docker flow, so it needs a source checkout.",
            ],
            [
              "Library and wasm",
              "A Rust library and a wasm build: the same code that powers SwapChan's web tools and MCP.",
            ],
          ].map(([h, t]) => (
            <li key={h} className="flex gap-3">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-fuchsia-400 shadow-[0_0_10px_rgba(217,70,239,0.8)]" />
              <span>
                <b className="text-violet-50">{h}.</b> <span className="text-violet-200">{t}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* v0.4.0 */}
      <section className="mt-20">
        <H2 id="v040" kicker="New in v0.4.0">
          What changed
        </H2>
        <p className="mb-4 text-sm text-violet-300">
          From the blocktools CHANGELOG at main 12b4d8e0. v0.4.0 is not tagged yet.
        </p>
        <ul className="grid gap-x-8 gap-y-4 text-sm md:grid-cols-2">
          {[
            [
              "tx-sign refuses by default",
              "tx-sign runs the same checks as tx-verify before it reads a key and again on the signed bytes. Unlimited approvals (2^128 or more, or all tokens), batch inner calls that were not asserted, and Safe delegatecalls are refused unless asserted with --expect-spender ADDR --expect-unlimited, --allow-inner-call TO:SELECTOR or --allow-delegatecall TO. --expect-amount, --expect-recipient and --expect-value also work, including with --plan. There is no blanket allow.",
            ],
            [
              "Pre-sign checks in wasm",
              "The wasm verifyTx runs the same approval, transfer and batch checks as tx-verify, deny by default, and returns approvals, transfers and inner_calls. Opt-ins are call_json keys expect_spender, expect_amount, expect_recipient, expect_value (strings), expect_unlimited (bool), allow_inner_call and allow_delegatecall (arrays).",
            ],
            [
              "msg-verify: Tron, Solana, Cosmos",
              "msg-verify checks Tron signMessageV2, Solana (--format raw|offchain-v0, required) and Cosmos ADR-036 (--pubkey, required) signatures; the chain is detected from the address. In wasm, msgVerify covers Tron, and the new msgVerifyOpts takes format, pubkey and chain for Solana and Cosmos.",
            ],
            [
              "msg-sign (CLI only)",
              "msg-sign signs Tron, Solana and Cosmos messages with the same gate as Ethereum and Bitcoin: blind hashes, hex and transaction-looking text are refused before any key is read, the signature is re-verified, then the message is shown and a code typed on /dev/tty. There is no wasm signing.",
            ],
            [
              "siwe (CLI only)",
              "siwe build makes an EIP-4361 Sign-In with Ethereum message from JSON fields; siwe parse accepts only valid, canonical text, with opt-in --domain, --nonce and --now/--check-time checks. It uses no keys and does not check the signature (use msg-verify). No wasm export.",
            ],
            [
              "Ambiguous addresses",
              'Some strings are valid both as a Cosmos bech32 address and as a Solana key. They are now refused with ambiguous_address unless the chain is named: --chain cosmos|sol on the CLI, or the msgVerifyOpts key "chain" in wasm. A named chain that does not match gives chain_does_not_match_address.',
            ],
            [
              "Partial ABI decodes",
              "abi-decode --allow-gaps (wasm evmAbiDecode allow_gaps, a bool) is opt-in: a dynamic tail may start after its canonical position and the skipped bytes are reported as gap_bytes. Backwards or overlapping offsets, bounds, dirty padding and trailing_data are still refused by default; SwapChan also passes allow_trailing at its own decode sites.",
            ],
            ["76 wasm exports", "Measured in a green main run (msgVerifyOpts is the 76th)."],
            [
              "Not tested",
              "Cosmos ADR-036 and Solana offchain-v0 are self round-trip only, with no published or real-wallet vector. siwe is tested only on spruceid's published vectors. The tx-verify checks have not been tested on transactions from a live wallet, and Universal Router commands are surfaced but not decoded.",
            ],
          ].map(([h, t]) => (
            <li key={h} className="flex gap-3">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-fuchsia-400 shadow-[0_0_10px_rgba(217,70,239,0.8)]" />
              <span>
                <b className="text-violet-50">{h}.</b> <span className="text-violet-200">{t}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* Install */}
      <section className="mt-20">
        <H2 id="install" kicker="How to install">
          Two ways in
        </H2>
        <div className="grid gap-5 md:grid-cols-2">
          <div className={`${card} min-w-0`}>
            <h3 className="font-black text-amber-300">Release download (Linux x86_64)</h3>
            <p className="mb-3 text-xs text-violet-300">
              Download, check the checksum, unpack, add to PATH.
            </p>
            <CopyCode code={BT_INSTALL} />
            <p className="mt-2 text-xs text-violet-400">If sha256sum -c does not say OK, stop.</p>
          </div>
          <div className={`${card} min-w-0`}>
            <h3 className="font-black text-amber-300">Build from source</h3>
            <p className="mb-3 text-xs text-violet-300">
              Rust plus Docker; the last step builds the sealed image.
            </p>
            <CopyCode code={BT_SOURCE_BUILD} />
            <p className="mt-2 text-xs text-violet-400">
              <Link href="/blocktools/install" className="underline">
                Full install guide
              </Link>
            </p>
          </div>
        </div>
      </section>

      {/* First run */}
      <section className="mt-20">
        <H2 id="first-run" kicker="First run">
          From zero to addresses in four steps
        </H2>
        <ol className="relative space-y-6 border-l-2 border-amber-300/40 pl-6">
          {[
            [
              "Make the folders and add the public test phrase",
              "./in is mounted read-only as /in inside the sealed run. Never use a real seed to practise.",
              "mkdir -p in secrets\nprintf '%s\\n' 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' > in/seed.txt",
            ],
            [
              "Ask what the file is",
              'classify answers "class":"mnemonic".',
              "./blocktools run 'classify /in/seed.txt'",
            ],
            [
              "Derive addresses",
              "Repair, make the master key, derive the first address of each Bitcoin type.",
              "./blocktools run 'seed-repair < /in/seed.txt | seed-to-master | derive --chain btc --count 1'",
            ],
            [
              "Or let the front door choose",
              "recover.sh picks the pipeline for any file.",
              "recipes/recover.sh /in/seed.txt - --goal addresses",
            ],
          ].map(([h, t, c], i) => (
            <li key={h} className="relative min-w-0">
              <span className="absolute -left-[41px] flex h-8 w-8 items-center justify-center rounded-full bg-amber-400 font-black text-violet-950 shadow-[0_0_14px_rgba(251,191,36,0.5)]">
                {i + 1}
              </span>
              <h3 className="font-black">{h}</h3>
              <p className="mb-2 text-sm text-violet-300">{t}</p>
              <CopyCode code={c ?? ""} />
            </li>
          ))}
        </ol>
        <Guide>
          Next, try your own file type in the{" "}
          <Link href="/blocktools/examples" className="underline">
            examples
          </Link>
          . Before moving funds, read{" "}
          <Link href="/blocktools/recipes/goal-sweep" className="underline">
            Sweep
          </Link>
          : sweeps are tested end to end only against a mock chain.
        </Guide>
      </section>

      {/* Who */}
      <section className="mt-20">
        <H2 id="who" kicker="Who it's for">
          Pick your path
        </H2>
        <div className="grid gap-4 md:grid-cols-3">
          {(
            [
              [
                "🗝️",
                "You have an old wallet file or seed",
                "See its addresses offline, then check balances.",
                [
                  ["Examples", "/blocktools/examples"],
                  ["Unknown file", "/blocktools/recipes/input-unknown"],
                  ["Check a balance", "/blocktools/recipes/goal-check-balance"],
                ],
              ],
              [
                "✍️",
                "You sign transactions",
                "Decode and verify before you sign, with policy limits.",
                [
                  ["Verify offline", "/blocktools/recipes/goal-verify-and-offline"],
                  ["Decode a tx", "/blocktools/recipes/decode-a-transaction"],
                  ["Policy files", "/blocktools/docs/policy"],
                ],
              ],
              [
                "🤖",
                "You build tools or agents",
                "Script it in pipes, call nodes, use the library, wasm or MCP.",
                [
                  ["Cookbook", "/blocktools/docs/cookbook"],
                  ["Library", "/blocktools/docs/library-api"],
                  ["MCP", "/blocktools/mcp"],
                ],
              ],
            ] as [string, string, string, string[][]][]
          ).map(([i, h, t, links]) => (
            <div key={h} className={card}>
              <div className="text-2xl">{i}</div>
              <h3 className="mt-2 font-black text-amber-300">{h}</h3>
              <p className="mt-1 text-sm text-violet-200">{t}</p>
              <ul className="mt-3 space-y-1 text-sm font-bold">
                {links.map(([l, href]) => (
                  <li key={href}>
                    <Link
                      href={href ?? "/blocktools"}
                      className="text-fuchsia-300 hover:text-amber-300"
                    >
                      {l} →
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* Safety */}
      <div className="mt-16 rounded-2xl border border-rose-400/60 bg-rose-950/40 p-5 text-sm text-rose-50">
        <b>Dangerous with real funds.</b> Read and audit code that handles keys before you trust it,
        and run secret steps sealed and offline.{" "}
        <Link className="underline" href="/blocktools/docs/security">
          Security model
        </Link>
      </div>

      {/* Reference cards */}
      <section className="mt-20">
        <H2 id="reference" kicker="Reference">
          Everything else
        </H2>
        <div className="grid gap-4 sm:grid-cols-2">
          {[
            [
              "/blocktools/commands",
              "Commands",
              `${BT_GROUPS.reduce((n, g) => n + g.tools.length, 0)} of the 58 man(1) pages, in ${BT_GROUPS.length} groups.`,
              BT_GROUPS.map((g) => g.label).join(" · "),
            ],
            [
              "/blocktools/recipes",
              "Recipes",
              `${recipes.length} task how-tos by goal, input and chain.`,
              "Sweep · Check a balance · Verify offline · Decode a tx",
            ],
            [
              "/blocktools/examples",
              "Examples",
              `${BT_EXAMPLES.length} worked examples on public test fixtures.`,
              BT_EXAMPLES.slice(0, 3)
                .map((e) => e.title)
                .join(" · "),
            ],
            [
              "/blocktools/docs",
              "Docs",
              `${docs.length} pages, searchable.`,
              "Getting started · Security · Chain table · Policy",
            ],
            [
              "/blocktools/releases",
              "Releases",
              `Latest ${tag}${latest ? `, ${latest.date.slice(0, 10)}` : ""}.`,
              "Assets, checksums and notes",
            ],
            [
              "/blocktools/mcp",
              "MCP and SwapChan",
              `${DEV_TOOLS.length} web tools on SwapChan run on blocktools.`,
              "Connect your AI agent",
            ],
          ].map(([href, h, t, sub]) => (
            <Link
              key={href}
              href={href ?? "/blocktools"}
              className={`${card} group block min-w-0 transition hover:border-amber-300 hover:shadow-[0_0_24px_rgba(251,191,36,0.2)]`}
            >
              <h3 className="flex items-center justify-between text-lg font-black">
                {h} <span className="text-amber-300 transition group-hover:translate-x-1">→</span>
              </h3>
              <p className="mt-1 text-sm text-violet-100">{t}</p>
              <p className="mt-2 truncate text-xs text-violet-400">{sub}</p>
            </Link>
          ))}
        </div>
        <form action="/blocktools/docs" className="mt-6">
          <input
            name="q"
            type="search"
            placeholder="Search the docs, recipes and examples…"
            aria-label="Search blocktools docs"
            className="w-full rounded-full border-2 border-violet-500 bg-violet-950/70 px-5 py-3 text-violet-50 placeholder:text-violet-400 focus:border-amber-300 focus:outline-none"
          />
        </form>
      </section>

      {/* Full page index: keeps every page within two clicks */}
      <section className="mt-12" aria-label="All blocktools pages">
        <h3 className="text-lg font-black text-amber-300">All pages</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {(
            [
              [
                "Recipes",
                "/blocktools/recipes",
                recipes.map((r) => [r.title, `/blocktools/recipes/${r.slug}`]),
              ],
              [
                "Examples",
                "/blocktools/examples",
                BT_EXAMPLES.map((e) => [e.title, `/blocktools/examples/${e.slug}`]),
              ],
              [
                "Docs",
                "/blocktools/docs",
                [
                  ...docs.map((d) => [d.title, `/blocktools/docs/${d.slug}`]),
                  ["FAQ", "/blocktools/faq"],
                ],
              ],
            ] as [string, string, string[][]][]
          ).map(([h, idx, items]) => (
            <details key={h} className={`${card} min-w-0`}>
              <summary className="cursor-pointer font-black">
                {h} <span className="text-sm text-violet-300">({items.length})</span>
              </summary>
              <ul className="mt-3 space-y-1 text-sm">
                {items.map(([t, href]) => (
                  <li key={href} className="truncate">
                    <Link href={href ?? idx} className="text-fuchsia-300 hover:text-amber-300">
                      {t}
                    </Link>
                  </li>
                ))}
              </ul>
              <Link href={idx} className="mt-3 block text-xs font-bold text-amber-300">
                Open {h.toLowerCase()} index →
              </Link>
            </details>
          ))}
        </div>
      </section>

      {/* Final CTA */}
      <section className="mt-20 rounded-3xl border border-fuchsia-400/50 bg-gradient-to-br from-violet-900 via-violet-900 to-fuchsia-900/70 p-8 text-center shadow-[0_0_60px_rgba(217,70,239,0.25)]">
        <img
          src="/characters/swapchan.png"
          alt=""
          width={64}
          height={64}
          className="mx-auto h-16 w-16"
        />
        <h2 className="mt-3 text-3xl font-black">All chains, one CLI</h2>
        <p className="mx-auto mt-2 max-w-xl text-violet-200">
          Open source (MIT), runs on your machine. Get {tag} or read the source first.
        </p>
        <div className="mt-6 flex justify-center">
          <Ctas />
        </div>
      </section>
    </BtPage>
  );
}
