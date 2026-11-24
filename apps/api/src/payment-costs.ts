export type FundingQuote = {
  quoteId: string;
  execution: string;
  atomicOrigin?: { estimatedFeeWei: string } | null;
  maxInputMicroUsdc: string;
  originGas: { estimate: { totalWei: string } | null };
};
/** Compare fees and exact payout in integer USDC units, preserving both native costs on the quote. */
export function comparePaymentCosts<T extends FundingQuote>(
  quotes: T[],
  microUsdcPerEth: bigint | null,
) {
  const scale = 10n ** 18n;
  function fee(q: T) {
    const split = q.originGas.estimate?.totalWei;
    const batch = q.atomicOrigin?.estimatedFeeWei;
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
    return { ...q, fundingFeeWei, estimatedTotalMicroUsdc: total?.toString() ?? null };
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
