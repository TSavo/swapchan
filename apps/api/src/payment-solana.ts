import { base58 } from "@scure/base";
import { acrossRoute, EvmAddress, SOLANA } from "@swapchan/shared";
import { z } from "zod";
import { getJson } from "./providers/types.js";

const native = "11111111111111111111111111111111";
const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const units = z.string().regex(/^\d+$/);
const owner = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  .refine((v) => {
    try {
      return base58.decode(v).length === 32;
    } catch {
      return false;
    }
  });
export const solanaPaymentInput = z
  .object({
    chainId: z.literal(10),
    sourceChainId: z.literal(SOLANA),
    sender: owner,
    recipient: EvmAddress,
    amountMicroUsdc: z.string().regex(/^[1-9]\d{0,37}$/),
  })
  .strict();
const asset = z.object({
  amount: units,
  minimumAmount: units.optional(),
  currency: z.object({
    address: z.string(),
    chainId: z.number().int(),
    decimals: z.number().int(),
  }),
});
export async function quoteSolanaPayment(
  f: typeof fetch,
  intent: z.infer<typeof solanaPaymentInput>,
) {
  const rpcUrl =
    process.env.SOLANA_RPC_URL ||
    process.env.RPC_URL_792703809 ||
    "https://api.mainnet-beta.solana.com";
  const post = (url: string, body: unknown) =>
    getJson(f, url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  const rpc = (method: string, params: unknown[]) =>
    post(rpcUrl, { jsonrpc: "2.0", id: 1, method, params });
  const [sol, tokens] = await Promise.all([
    rpc("getBalance", [intent.sender, { commitment: "confirmed" }]).then((r) =>
      BigInt(
        z.object({ result: z.object({ value: z.number().int().nonnegative().safe() }) }).parse(r)
          .result.value,
      ),
    ),
    rpc("getTokenAccountsByOwner", [
      intent.sender,
      { mint: usdc },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]).then((r) =>
      z
        .object({
          result: z.object({
            value: z.array(
              z.object({
                account: z.object({
                  data: z.object({
                    parsed: z.object({
                      info: z.object({
                        mint: z.literal(usdc),
                        owner: z.literal(intent.sender),
                        state: z.string(),
                        tokenAmount: z.object({ amount: units }),
                      }),
                    }),
                  }),
                }),
              }),
            ),
          }),
        })
        .parse(r)
        .result.value.reduce((sum, a) => {
          const info = a.account.data.parsed.info;
          return sum + (info.state === "initialized" ? BigInt(info.tokenAmount.amount) : 0n);
        }, 0n),
    ),
  ]);
  const destination = acrossRoute(10).destinationToken;
  const routes = await Promise.all(
    [
      { symbol: "SOL", mint: native, balance: sol, decimals: 9 },
      { symbol: "USDC", mint: usdc, balance: tokens, decimals: 6 },
    ].map(async (holding) => {
      const source = {
        symbol: holding.symbol,
        mint: holding.mint,
        balanceUnits: String(holding.balance),
        decimals: holding.decimals,
      };
      if (!holding.balance) return { ...source, status: "empty" };
      try {
        const result = await post("https://api.relay.link/quote/v2", {
          user: intent.sender,
          recipient: intent.recipient,
          originChainId: SOLANA,
          destinationChainId: 10,
          originCurrency: holding.mint,
          destinationCurrency: destination,
          tradeType: "EXACT_OUTPUT",
          amount: intent.amountMicroUsdc,
        });
        const { details } = z
          .object({
            details: z.object({
              sender: z.literal(intent.sender),
              recipient: EvmAddress,
              currencyIn: asset,
              currencyOut: asset,
            }),
          })
          .parse(result);
        const input = details.currencyIn,
          out = details.currencyOut;
        if (
          details.recipient.toLowerCase() !== intent.recipient.toLowerCase() ||
          input.currency.chainId !== SOLANA ||
          input.currency.address !== holding.mint ||
          input.currency.decimals !== holding.decimals ||
          !BigInt(input.amount) ||
          out.currency.chainId !== 10 ||
          out.currency.address.toLowerCase() !== destination.toLowerCase() ||
          out.currency.decimals !== 6 ||
          out.amount !== intent.amountMicroUsdc ||
          out.minimumAmount !== out.amount
        )
          throw Error("Relay terms differ from intent");
        return {
          ...source,
          status: BigInt(input.amount) <= holding.balance ? "quoted" : "insufficient_balance",
          quotedInputUnits: input.amount,
          exactPayoutMicroUsdc: out.amount,
        };
      } catch {
        return { ...source, status: "quote_unavailable" };
      }
    }),
  );
  return {
    ...intent,
    provider: "relay",
    execution: "quote_only",
    atomic: false,
    sourceNetworkFees: "unverified",
    routes,
  };
}
