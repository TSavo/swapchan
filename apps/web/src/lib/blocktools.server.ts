import fs from "node:fs";
import path from "node:path";
import { Marked } from "marked";
import { BT_ITEMS, type BtItem } from "@/lib/blocktoolsManifest";

/** Vendored from https://github.com/TSavo/blocktools (see content/blocktools/SOURCE). */
export const BT_REPO = "https://github.com/TSavo/blocktools";
export const BT_COMMIT = "400384d4";
/** The release this site reviewed and links. Newer releases stay listed on /blocktools/releases. */
export const BT_TAG = "v0.5.0";
export const pinnedRelease = <T extends { tag: string }>(rs: T[]): T | undefined =>
  rs.find((r) => r.tag === BT_TAG);
const ROOT = path.join(process.cwd(), "content", "blocktools");

/** Where each vendored file lives in the upstream repo (for resolving its relative links). */
function repoPath(file: string): string {
  if (file === "README.md") return "README.md";
  if (file === "docs/DESIGN.md") return "DESIGN.md";
  if (file === "docs/wasm.md") return "bindings/wasm/README.md";
  return file;
}

const LOCAL: Record<string, string> = {
  "README.md": "/blocktools",
  "docs/README.md": "/blocktools/docs",
  "docs/troubleshooting.md": "/blocktools/faq",
  "recipes/README.md": "/blocktools/recipes",
};
for (const it of BT_ITEMS) {
  if (it.kind === "docs" || it.file.startsWith("recipes/"))
    LOCAL[repoPath(it.file)] = `/blocktools/${it.kind}/${it.slug}`;
}

function rewrite(href: string, from: string): string {
  if (/^(https?:|mailto:|#|\/)/.test(href)) return href;
  const [p, hash] = href.split("#");
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(repoPath(from)), p ?? ""),
  );
  const local = LOCAL[resolved];
  if (local) return local + (hash ? `#${hash}` : "");
  return `${BT_REPO}/blob/main/${resolved}${hash ? `#${hash}` : ""}`;
}

export function readMd(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

/** Render a vendored markdown file to HTML (trusted, vendored content), dropping its H1. */
export function renderMd(file: string): string {
  const src = readMd(file)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^# .+\n/, "");
  const m = new Marked({ gfm: true });
  m.use({
    walkTokens(t) {
      if (t.type === "link") t.href = rewrite(t.href, file);
    },
  });
  return m.parse(src, { async: false }) as string;
}

export function plain(file: string, max = 4000): string {
  return readMd(file)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*#>|_]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, max);
}

export type SearchDoc = { href: string; title: string; kind: string; text: string };
export function searchIndex(): SearchDoc[] {
  const docs: SearchDoc[] = BT_ITEMS.map((it: BtItem) => ({
    href: `/blocktools/${it.kind}/${it.slug}`,
    title: it.title,
    kind: it.kind === "docs" ? "Docs" : "Recipe",
    text: plain(it.file),
  }));
  docs.push(
    {
      href: "/blocktools/faq",
      title: "Troubleshooting / FAQ",
      kind: "Docs",
      text: plain("docs/troubleshooting.md"),
    },
    {
      href: "/blocktools/install",
      title: "Install blocktools",
      kind: "Docs",
      text: plain("README.md"),
    },
  );
  return docs;
}

export type Asset = { name: string; size: number; url: string };
export type Release = {
  tag: string;
  name: string;
  date: string;
  body: string;
  url: string;
  assets: Asset[];
};

/** Measured 2026-10-30 (v0.4.0 entry 2026-11-02; v0.5.0 entry 2026-11-08) from api.github.com/repos/TSavo/blocktools/releases (fallback if the API is unreachable). */
const FALLBACK: Release[] = [
  {
    tag: "v0.5.0",
    name: "v0.5.0",
    date: "2026-11-09T02:37:23Z",
    body: "Linux x86_64 binaries. Verify with: sha256sum -c SHA256SUMS",
    url: `${BT_REPO}/releases/tag/v0.5.0`,
    assets: [
      {
        name: "blocktools-v0.5.0-linux-x86_64.tar.gz",
        size: 47215603,
        url: `${BT_REPO}/releases/download/v0.5.0/blocktools-v0.5.0-linux-x86_64.tar.gz`,
      },
      { name: "SHA256SUMS", size: 104, url: `${BT_REPO}/releases/download/v0.5.0/SHA256SUMS` },
    ],
  },
  {
    tag: "v0.4.0",
    name: "v0.4.0",
    date: "2026-11-03T03:35:27Z",
    body: "Linux x86_64 binaries. Verify with: sha256sum -c SHA256SUMS",
    url: `${BT_REPO}/releases/tag/v0.4.0`,
    assets: [
      {
        name: "blocktools-v0.4.0-linux-x86_64.tar.gz",
        size: 47018016,
        url: `${BT_REPO}/releases/download/v0.4.0/blocktools-v0.4.0-linux-x86_64.tar.gz`,
      },
      { name: "SHA256SUMS", size: 104, url: `${BT_REPO}/releases/download/v0.4.0/SHA256SUMS` },
    ],
  },
  {
    tag: "v0.3.3",
    name: "v0.3.3",
    date: "2026-10-30T19:11:51Z",
    body: "Linux x86_64 binaries. Verify with: sha256sum -c SHA256SUMS",
    url: `${BT_REPO}/releases/tag/v0.3.3`,
    assets: [
      {
        name: "blocktools-v0.3.3-linux-x86_64.tar.gz",
        size: 46494429,
        url: `${BT_REPO}/releases/download/v0.3.3/blocktools-v0.3.3-linux-x86_64.tar.gz`,
      },
      { name: "SHA256SUMS", size: 104, url: `${BT_REPO}/releases/download/v0.3.3/SHA256SUMS` },
    ],
  },
  {
    tag: "v0.3.0",
    name: "v0.3.0",
    date: "2026-10-29T09:27:37Z",
    body: "Linux x86_64 binaries. Verify with: sha256sum -c SHA256SUMS",
    url: `${BT_REPO}/releases/tag/v0.3.0`,
    assets: [
      {
        name: "blocktools-v0.3.0-linux-x86_64.tar.gz",
        size: 46502512,
        url: `${BT_REPO}/releases/download/v0.3.0/blocktools-v0.3.0-linux-x86_64.tar.gz`,
      },
      { name: "SHA256SUMS", size: 104, url: `${BT_REPO}/releases/download/v0.3.0/SHA256SUMS` },
    ],
  },
  {
    tag: "v0.2.0",
    name: "v0.2.0",
    date: "2026-10-28T15:20:54Z",
    body: "Linux x86_64 binaries. Verify with: sha256sum -c SHA256SUMS",
    url: `${BT_REPO}/releases/tag/v0.2.0`,
    assets: [
      {
        name: "blocktools-v0.2.0-linux-x86_64.tar.gz",
        size: 41927348,
        url: `${BT_REPO}/releases/download/v0.2.0/blocktools-v0.2.0-linux-x86_64.tar.gz`,
      },
      { name: "SHA256SUMS", size: 104, url: `${BT_REPO}/releases/download/v0.2.0/SHA256SUMS` },
    ],
  },
  {
    tag: "v0.1.1",
    name: "v0.1.1",
    date: "2026-10-26T23:20:46Z",
    body: "Linux x86_64 binaries. Verify with: sha256sum -c SHA256SUMS",
    url: `${BT_REPO}/releases/tag/v0.1.1`,
    assets: [
      {
        name: "blocktools-v0.1.1-linux-x86_64.tar.gz",
        size: 35150662,
        url: `${BT_REPO}/releases/download/v0.1.1/blocktools-v0.1.1-linux-x86_64.tar.gz`,
      },
      { name: "SHA256SUMS", size: 104, url: `${BT_REPO}/releases/download/v0.1.1/SHA256SUMS` },
    ],
  },
];

/** Public GitHub releases API, cached for an hour (ISR), static fallback. */
export async function getReleases(): Promise<{ releases: Release[]; live: boolean }> {
  try {
    const r = await fetch("https://api.github.com/repos/TSavo/blocktools/releases", {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: 3600 },
    });
    if (!r.ok) throw new Error(String(r.status));
    const j = (await r.json()) as any[];
    const releases = j
      .filter((x) => !x.draft)
      .map((x) => ({
        tag: x.tag_name,
        name: x.name || x.tag_name,
        date: x.published_at,
        body: x.body ?? "",
        url: x.html_url,
        assets: (x.assets ?? []).map((a: any) => ({
          name: a.name,
          size: a.size,
          url: a.browser_download_url,
        })),
      }));
    return releases.length ? { releases, live: true } : { releases: FALLBACK, live: false };
  } catch {
    return { releases: FALLBACK, live: false };
  }
}

export const mb = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${n} bytes`);
