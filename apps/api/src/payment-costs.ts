export type FundingQuote = {
  quoteId: string;
  execution: string;
  atomicOrigin?: { estimatedFeeWei: string } | null;
  maxInputMicroUsdc: string;
  inputMicroUsdc: string;
  sourceWallet: { balanceMicroUsdc: string; nativeBalanceWei: string };
  originGas: { estimate: { totalWei: string } | null; atomicEstimateWei?: string | null };
};
export function recommendedPaymentStage(
  q: Pick<FundingQuote, "execution" | "atomicOrigin" | "originGas">,
) {
  if (q.execution === "quote_only") return null;
  const batch = q.atomicOrigin?.estimatedFeeWei;
  const split = q.originGas.estimate?.totalWei;
  if (
    batch &&
    (!split || q.execution === "unsigned_atomic_origin" || BigInt(batch) < BigInt(split))
  )
    return "atomic_origin";
  return "initial";
}
/** Compare fees and exact payout in integer USDC units, preserving both native costs on the quote. */
export function comparePaymentCosts<T extends FundingQuote>(
  quotes: T[],
  microUsdcPerEth: bigint | null,
) {
  const scale = 10n ** 18n;
  function fee(q: T) {
    const split = q.originGas.estimate?.totalWei;
    const stage = recommendedPaymentStage(q);
    if (stage === "atomic_origin") return q.atomicOrigin!.estimatedFeeWei;
    if (stage === "initial") return split ?? null;
    const batch = q.atomicOrigin?.estimatedFeeWei ?? q.originGas.atomicEstimateWei;
    if (
      batch &&
      (!split || q.execution === "unsigned_atomic_origin" || BigInt(batch) < BigInt(split))
    )
      return batch;
    return split ?? null;
  }
  const costNumerator = (q: T, rate: bigint) =>
    BigInt(q.maxInputMicroUsdc) * scale + BigInt(fee(q)!) * rate;
  const rows = quotes.map((q) => {
    const fundingFeeWei = fee(q);
    const total =
      microUsdcPerEth && fundingFeeWei
        ? (costNumerator(q, microUsdcPerEth) + scale - 1n) / scale
        : null;
    const tokenGap = BigInt(q.inputMicroUsdc) - BigInt(q.sourceWallet.balanceMicroUsdc);
    const gasGap =
      fundingFeeWei === null
        ? null
        : BigInt(fundingFeeWei) - BigInt(q.sourceWallet.nativeBalanceWei);
    return {
      ...q,
      recommendedStage: recommendedPaymentStage(q),
      fundingFeeWei,
      fundingShortfall: {
        microUsdc: String(tokenGap > 0n ? tokenGap : 0n),
        estimatedWei: gasGap === null ? null : String(gasGap > 0n ? gasGap : 0n),
      },
      estimatedTotalMicroUsdc: total?.toString() ?? null,
    };
  });
  const eligible = rows.filter((q) => q.execution !== "quote_only" && q.fundingFeeWei);
  const preferred =
    eligible.length === 1
      ? eligible[0]
      : eligible.find((q) =>
          eligible.every((other) => {
            if (microUsdcPerEth)
              return costNumerator(q, microUsdcPerEth) <= costNumerator(other, microUsdcPerEth);
            return (
              BigInt(q.maxInputMicroUsdc) <= BigInt(other.maxInputMicroUsdc) &&
              BigInt(q.fundingFeeWei!) <= BigInt(other.fundingFeeWei!)
            );
          }),
        );
  return {
    routes: rows,
    recommendedQuoteId: preferred?.quoteId ?? null,
    gasConversionMicroUsdcPerEth: microUsdcPerEth?.toString() ?? null,
  };
}
