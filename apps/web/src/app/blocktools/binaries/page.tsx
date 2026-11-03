import Link from "next/link";
import { BtPage, btMeta } from "@/components/blocktools/BtPage";
import { getReleases, mb, pinnedRelease } from "@/lib/blocktools.server";

export const revalidate = 3600;
export const metadata = btMeta(
  "/blocktools/binaries",
  "blocktools binaries and platforms",
  "Which platforms have prebuilt blocktools binaries: Linux x86_64 only (glibc 2.39+ for the full set (54 of 56 binaries need 2.34; sealed-run and tx-decode need 2.39; objdump -T on the published tarball, not CI-stamped)). No macOS, Windows or ARM binaries.",
);

const ROWS: [string, string, string][] = [
  ["Linux x86_64 (glibc 2.39+ for the full set (54 of 56 binaries need 2.34; sealed-run and tx-decode need 2.39; objdump -T on the published tarball, not CI-stamped))", "Prebuilt tarball", "yes"],
  ["Linux, older glibc", "Build from source", "no"],
  ["Linux ARM64", "No asset; source build not documented", "no"],
  ["macOS (Intel or Apple silicon)", "No asset; source build not documented", "no"],
  ["Windows", "No asset; source build not documented", "no"],
  [".deb / .rpm / .apk packages", "Dry-run only, not published", "no"],
];

export default async function Binaries() {
  const { releases } = await getReleases();
  const r = pinnedRelease(releases);
  return (
    <BtPage
      title="Binaries"
      lead={
        <p>
          Prebuilt release binaries exist for one platform today. Elsewhere, the documented path is
          a source build on Linux.
        </p>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-violet-300">
            <tr>
              <th className="p-2">Platform</th>
              <th className="p-2">How</th>
              <th className="p-2">Prebuilt</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map(([p, h, y]) => (
              <tr key={p} className="border-t border-violet-500/30">
                <td className="p-2 font-bold">{p}</td>
                <td className="p-2">{h}</td>
                <td
                  className={`p-2 font-black ${y === "yes" ? "text-emerald-300" : "text-violet-400"}`}
                >
                  {y}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-violet-400">
        The Linux binaries are dynamically linked against glibc (not static). Packaging scripts for
        deb/rpm/apk exist but only run as a dry run.
      </p>
      {r && (
        <section className="mt-8">
          <h2 className="mb-2 text-xl font-black">Release: {r.tag}</h2>
          <ul className="space-y-1 text-sm">
            {r.assets.map((a) => (
              <li key={a.name}>
                <a href={a.url} className="font-mono text-amber-300 underline">
                  {a.name}
                </a>{" "}
                ({mb(a.size)})
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="mt-6">
        <Link href="/blocktools/install" className="underline">
          Install guide
        </Link>{" "}
        ·{" "}
        <Link href="/blocktools/releases" className="underline">
          All releases
        </Link>
      </p>
    </BtPage>
  );
}
