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
      <p className="mb-4 text-sm text-violet-200 md:text-base">
        Before the wallet button, blocktools verifyTx checks the call. By default it fails an
        approval of 2^128 or more, inner calls inside a multicall or Safe transaction that were not
        allowed, and any delegatecall. Through the API (/contract-tool/approve) and the MCP tool
        contract_approve_call you can also state what you intend: expect_spender, expect_amount,
        expect_unlimited, expect_recipient, expect_value, allow_inner_call and allow_delegatecall.
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
