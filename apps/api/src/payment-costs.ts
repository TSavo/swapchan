export type FundingQuote = {
  quoteId: string;
  execution: string;
  maxInputMicroUsdc: string;
  originGas: { estimate: { totalWei: string } | null };
};
/** Compare fees and exact payout in integer USDC units, preserving both native costs on the quote. */
export function comparePaymentCosts<T extends FundingQuote>(
  quotes: T[],
  microUsdcPerEth: bigint | null,
) {
  const scale = 10n ** 18n;
  const costNumerator = (q: T, rate: bigint) =>
    BigInt(q.maxInputMicroUsdc) * scale + BigInt(q.originGas.estimate!.totalWei) * rate;
  const rows = quotes.map((q) => {
    const gas = q.originGas.estimate;
    const total =
      microUsdcPerEth && gas ? (costNumerator(q, microUsdcPerEth) + scale - 1n) / scale : null;
    return { ...q, estimatedTotalMicroUsdc: total?.toString() ?? null };
  });
  const eligible = rows.filter(
    (q) => q.execution === "unsigned_origin_steps" && q.originGas.estimate,
  );
  const preferred =
    eligible.length === 1
      ? eligible[0]
      : eligible.find((q) =>
          eligible.every((other) => {
            if (microUsdcPerEth)
              return costNumerator(q, microUsdcPerEth) <= costNumerator(other, microUsdcPerEth);
            return (
              BigInt(q.maxInputMicroUsdc) <= BigInt(other.maxInputMicroUsdc) &&
              BigInt(q.originGas.estimate!.totalWei) <= BigInt(other.originGas.estimate!.totalWei)
            );
          }),
        );
  return {
    routes: rows,
    recommendedQuoteId: preferred?.quoteId ?? null,
    gasConversionMicroUsdcPerEth: microUsdcPerEth?.toString() ?? null,
  };
}
