import { BITCOIN, EvmAddress, NATIVE_TOKEN, NON_EVM, SOLANA, TRON } from "@swapchan/shared";
import { z } from "zod";
import { bitcoinPaymentInput, quoteBitcoinPayment } from "./payment-bitcoin.js";
import { destinationIntent } from "./payment-direct.js";
import { quoteSolanaPayment, solanaPaymentInput } from "./payment-solana.js";
import { quoteTronPayment, tronPaymentInput } from "./payment-tron.js";
import { type Pricer } from "./pricing.js";
export const multiFundingInput = z
  .object({
    chainId: z.literal(10),
    amountMicroUsdc: z.string().regex(/^[1-9]\d{0,37}$/),
    recipient: EvmAddress,
    fundingAddresses: z
      .object({
        evm: EvmAddress.optional(),
        bitcoin: bitcoinPaymentInput.shape.sender.optional(),
        solana: solanaPaymentInput.shape.sender.optional(),
        tron: tronPaymentInput.shape.sender.optional(),
      })
      .strict()
      .refine((v) => Object.values(v).some(Boolean)),
  })
  .strict();
type EvmReview = {
  quoteId: string;
  expiresAt: number;
  inputToken: string;
  maxInputMicroUsdc: string;
  sourceWallet: { balanceMicroUsdc: string; nativeBalanceWei: string };
  originSimulation: { status: string };
  originGas: { estimate: { totalWei: string } | null };
};
type Choice = {
  sourceChainId: number;
  mint: string;
  estimatedTotalUsd: number | null;
  eligible: boolean;
  expiresAt: number;
};
export async function multiFundingQuote(
  f: typeof fetch,
  i: z.infer<typeof multiFundingInput>,
  prices: Pricer,
  save: Parameters<typeof quoteSolanaPayment>[3],
  evmQuote: (chainId: 10 | 8453, sender: `0x${string}`) => Promise<EvmReview>,
) {
  const { fundingAddresses: a, ...intent } = i;
  const jobs: Promise<{ sourceChainId: number; review: unknown; choices: Choice[] }>[] = [];
  function add(chain: number, fn: () => Promise<{ review: unknown; choices: Choice[] }>) {
    jobs.push(
      fn()
        .then((r) => ({ ...r, sourceChainId: chain }))
        .catch(() => ({
          sourceChainId: chain,
          review: { status: "quote_unavailable" },
          choices: [],
        })),
    );
  }
  const expiresAt = Math.floor(Date.now() / 1000) + 60;
  if (a.evm)
    for (const chain of [10, 8453] as const)
      add(chain, async () => {
        const sender = a.evm!;
        destinationIntent.parse({ ...intent, sender });
        const q = await evmQuote(chain, sender),
          gas = q.originGas.estimate;
        const eligible =
          q.originSimulation.status === "succeeded" &&
          !!gas &&
          BigInt(gas.totalWei) <= BigInt(q.sourceWallet.nativeBalanceWei) &&
          BigInt(q.maxInputMicroUsdc) <= BigInt(q.sourceWallet.balanceMicroUsdc);
        const [usd, fee] = await Promise.all([
          prices.usd(chain, q.inputToken, q.maxInputMicroUsdc),
          gas ? prices.usd(chain, NATIVE_TOKEN, gas.totalWei) : null,
        ]);
        return {
          review: q,
          choices: [
            {
              sourceChainId: chain,
              mint: q.inputToken,
              estimatedTotalUsd: usd !== null && fee !== null ? usd + fee : null,
              eligible,
              expiresAt: Math.min(expiresAt, q.expiresAt),
            },
          ],
        };
      });
  if (a.bitcoin)
    add(BITCOIN, async () => {
      const q = await quoteBitcoinPayment(f, {
        ...intent,
        sourceChainId: BITCOIN,
        sender: a.bitcoin!,
      });
      const mint = NON_EVM[BITCOIN]!.native;
      return {
        review: q,
        choices:
          "totalSpendSats" in q && q.totalSpendSats
            ? [
                {
                  sourceChainId: BITCOIN,
                  mint,
                  estimatedTotalUsd: await prices.usd(BITCOIN, mint, q.totalSpendSats),
                  eligible: q.executionGate !== "unverified_bitcoin_depository",
                  expiresAt: Math.min(expiresAt, q.order.deadline),
                },
              ]
            : [],
      };
    });
  if (a.tron)
    add(TRON, async () => {
      const q = await quoteTronPayment(f, { ...intent, sourceChainId: TRON, sender: a.tron! }),
        mint = NON_EVM[TRON]!.native;
      return {
        review: q,
        choices:
          "estimatedTotalWithoutStakedResourcesSun" in q &&
          q.estimatedTotalWithoutStakedResourcesSun
            ? [
                {
                  sourceChainId: TRON,
                  mint,
                  estimatedTotalUsd: await prices.usd(
                    TRON,
                    mint,
                    q.estimatedTotalWithoutStakedResourcesSun,
                  ),
                  eligible: q.status === "quoted",
                  expiresAt: Math.min(expiresAt, q.order.deadline),
                },
              ]
            : [],
      };
    });
  if (a.solana)
    add(SOLANA, async () => {
      const q = await quoteSolanaPayment(
        f,
        { ...intent, sourceChainId: SOLANA, sender: a.solana! },
        prices,
        save,
      );
      return {
        review: q,
        choices: q.routes.flatMap((r) =>
          "sourceSimulation" in r && r.sourceSimulation?.status === "simulated"
            ? [
                {
                  sourceChainId: SOLANA,
                  mint: r.mint,
                  estimatedTotalUsd: r.estimatedTotalUsd,
                  eligible: true,
                  expiresAt: Math.min(expiresAt, r.order.deadline),
                },
              ]
            : [],
        ),
      };
    });
  const sources = await Promise.all(jobs);
  const choices = sources
    .flatMap((s) => s.choices)
    .filter((c) => c.eligible && c.expiresAt > Date.now() / 1000);
  const priced = choices
    .filter(
      (c) =>
        c.estimatedTotalUsd !== null &&
        Number.isFinite(c.estimatedTotalUsd) &&
        c.estimatedTotalUsd > 0,
    )
    .sort((a, b) => a.estimatedTotalUsd! - b.estimatedTotalUsd!);
  const recommended =
    choices.length === 1 ? choices[0] : priced.length === choices.length ? priced[0] : null;
  return {
    ...intent,
    execution: "quote_only",
    sources,
    recommended: recommended ?? null,
    comparisonScope: "verified_funded_quotes",
    expiresAt: Math.min(expiresAt, ...choices.map((c) => c.expiresAt)),
  };
}
