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
  [
    "Linux x86_64 (glibc 2.39+ for the full set (54 of 56 binaries need 2.34; sealed-run and tx-decode need 2.39; objdump -T on the published tarball, not CI-stamped))",
    "Prebuilt tarball",
    "yes",
  ],
  ["Linux, older glibc", "Build from source", "no"],
  ["Linux ARM64", "No asset; source build not documented", "no"],
  ["macOS (Intel or Apple silicon)", "No asset; source build not documented", "no"],
  ["Windows", "No asset; source build not documented", "no"],
  [".deb / .rpm / .apk packages (x86_64)", "Published, signed repos, x86_64 only", "yes"],
];

const REPOS: [string, string, string][] = [
  [
    "Debian / Ubuntu (apt, amd64)",
    "Key fingerprint: 08D9 04B0 EB3B CC0F 6D24  C621 607A 6605 8B6C 256E",
    `sudo install -d -m 0755 /etc/apt/keyrings
sudo wget -O /etc/apt/keyrings/blocktools-archive-keyring.asc \\
  https://raw.githubusercontent.com/TSavo/blocktools/main/packaging/apt/blocktools-archive-keyring.asc
echo "deb [signed-by=/etc/apt/keyrings/blocktools-archive-keyring.asc] https://tsavo.github.io/blocktools/apt stable main" \\
  | sudo tee /etc/apt/sources.list.d/blocktools.list
sudo apt update && sudo apt install blocktools`,
  ],
  [
    "Fedora / RHEL (dnf, x86_64)",
    "Key fingerprint: 8C50 B7A7 95D1 D3EC C5FC  97FF B83B E907 A65A 3F3F",
    `sudo curl -o /etc/yum.repos.d/blocktools.repo \\
  https://raw.githubusercontent.com/TSavo/blocktools/main/packaging/rpm/blocktools.repo
sudo dnf install blocktools`,
  ],
  [
    "Alpine (apk, x86_64)",
    "Key SHA-256: 07ca30cd9d1d599342d87514b8585326a28880d62308fe9304007b62db66c09f",
    `wget -O /etc/apk/keys/blocktools@tsavo-2026.rsa.pub \\
  https://raw.githubusercontent.com/TSavo/blocktools/main/packaging/alpine/keys/blocktools@tsavo-2026.rsa.pub
echo https://tsavo.github.io/blocktools/alpine >> /etc/apk/repositories
apk update && apk add blocktools`,
  ],
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
        The tarball's Linux binaries are dynamically linked against glibc (not static). The deb and
        rpm carry those same glibc binaries (most need glibc 2.34+; sealed-run and tx-decode need
        2.39). The apk is a static musl build.
      </p>
      <section className="mt-8">
        <h2 className="mb-2 text-xl font-black">Package repos (0.4.0)</h2>
        <p className="text-sm">Published, signed repos, x86_64 only.</p>
        {REPOS.map(([name, key, cmd]) => (
          <div key={name} className="mt-4">
            <h3 className="font-bold">{name}</h3>
            <p className="text-xs text-violet-400">{key}</p>
            <pre className="mt-1 overflow-x-auto rounded bg-black/40 p-3 text-xs">{cmd}</pre>
          </div>
        ))}
      </section>
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
