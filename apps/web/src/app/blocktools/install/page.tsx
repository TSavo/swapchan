import Link from "next/link";
import { BtPage, btMeta } from "@/components/blocktools/BtPage";
import { CopyCode } from "@/components/blocktools/CopyCode";
import {
  BT_INSTALL,
  BT_SOURCE_BUILD,
  BT_TARBALL,
  BT_TARBALL_SHA256,
  BT_VERSION,
} from "@/lib/blocktools";
import { BT_REPO } from "@/lib/blocktools.server";

export const metadata = btMeta(
  "/blocktools/install",
  "Install blocktools",
  "Install the blocktools CLI: download the Linux x86_64 release and verify its SHA256SUMS, or build from source with cargo and docker.",
);

export default function Install() {
  return (
    <BtPage
      title="Install"
      lead={
        <p>
          Two ways: the release tarball (Linux x86_64) or a source build (anywhere Rust and Docker
          run).
        </p>
      }
      source={`${BT_REPO}#install`}
    >
      <h2 className="mb-2 text-xl font-black">
        1. Release binaries (Linux x86_64, glibc 2.39 or newer)
      </h2>
      <CopyCode code={BT_INSTALL} />
      <p className="mt-2 mb-8 text-sm text-violet-300">
        Needs the GitHub CLI (<code>gh</code>). If <code>sha256sum -c</code> fails, delete the
        archive and do not run it. Expected SHA256 of <code>{BT_TARBALL}</code>:{" "}
        <code className="break-all">{BT_TARBALL_SHA256}</code>. The tarball holds <code>bin/</code>{" "}
        (56 binaries, 42 of them on the sealed-run allowlist), 58 man(1) pages (including the{" "}
        <code>blocktools</code> wrapper and <code>recover.sh</code>) and recipes. The source tree
        has 61 tool directories; 5 are test and parity tools with no man page. It has no Dockerfile: sealed runs (
        <code>./blocktools build</code>) need a {BT_VERSION}
        source checkout and Docker.
      </p>
      <h2 className="mb-2 text-xl font-black">2. Build from source</h2>
      <CopyCode code={BT_SOURCE_BUILD} />
      <p className="mt-2 text-sm text-violet-300">
        <code>./blocktools build</code> builds the sealed Docker image used by{" "}
        <code>./blocktools run</code>. Next:{" "}
        <Link href="/blocktools/docs/getting-started" className="underline">
          Getting started
        </Link>
        .
      </p>
    </BtPage>
  );
}
