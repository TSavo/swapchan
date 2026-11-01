import type { Metadata } from "next";
import Link from "next/link";
import { ContractTool } from "@/components/tools/ContractTool";

export const metadata: Metadata = {
  title: "Read & Write Contract: call any EVM contract function | SwapChan",
  description:
    "Load a contract's verified ABI (Sourcify, Etherscan) on Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche, Linea or Scroll. Query read functions and build write calls that your own wallet signs and sends.",
  alternates: { canonical: "/tools/contract" },
};

export default function ContractPage() {
  return (
    <article className="w-full max-w-3xl">
      <h1 className="text-2xl font-black md:text-3xl">Read &amp; Write Contract</h1>
      <p className="mb-4 text-sm text-violet-200 md:text-base">
        Pick a chain, paste a contract address, and call its functions like a block explorer&apos;s
        Contract tab. Read functions run as an eth_call. Write functions are built here and sent by
        your own connected wallet: SwapChan never signs or sends anything.
      </p>
      <ContractTool />
      <p className="mt-6 text-sm">
        <Link href="/blocktools/recipes/evm-contract-tx" className="underline hover:text-amber-300">
          Recipe
        </Link>
      </p>
    </article>
  );
}
