import { acrossRoute } from "@swapchan/shared";
import { encodeEventTopics, encodeFunctionData, erc20Abi, toHex } from "viem";
import { expect, it } from "vitest";
import { comparePaymentCosts } from "./payment-costs.js";
import { directReceipt, quoteDirect } from "./payment-direct.js";

const i = {
  chainId: 11155420,
  sender: "0x0000000000000000000000000000000000000001",
  recipient: "0x0000000000000000000000000000000000000002",
  amountMicroUsdc: "1",
} as const;
const token = acrossRoute(i.chainId).destinationToken;
const transactionHash = toHex(123, { size: 32 }),
  blockHash = toHex(456, { size: 32 });
const data = encodeFunctionData({
  abi: erc20Abi,
  functionName: "transfer",
  args: [i.recipient, 1n],
});
it("requires the exact destination transfer, funded ETH and successful simulation", async () => {
  for (const [native, returned, expected] of [
    ["0x10000", 1, "unsigned_origin_steps"],
    ["0x0", 1, "quote_only"],
    ["0x10000", 0, "quote_only"],
  ] as const) {
    const { quote, tx } = await quoteDirect(i, async (method, p) => {
      if (method === "eth_blockNumber") return "0x3";
      if (method === "eth_call") return toHex(2, { size: 32 });
      if (method === "eth_getBalance") return native;
      if (method === "eth_getCode") return "0x";
      if (method === "eth_simulateV1") {
        expect(p[0]).toMatchObject({
          blockStateCalls: [{ calls: [{ to: token, from: i.sender, value: "0x0", data }] }],
        });
        return [
          {
            calls: [{ status: "0x1", returnData: toHex(returned, { size: 32 }), gasUsed: "0x10" }],
          },
        ];
      }
      if (["eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_getTransactionCount"].includes(method))
        return "0x1";
      throw Error(method);
    });
    expect(quote.execution).toBe(expected);
    expect(tx.data).toBe(data);
    expect(quote.sourceWallet.requiredApprovalMicroUsdc).toBe("0");
  }
});
it.each(["settled", "awaiting_finality", "bad_event", "wrong_calldata"])(
  "independently reconciles direct receipts (%s)",
  async (kind) => {
    const promise = directReceipt({ ...i, transactionHash }, async (method, p) => {
      if (method === "eth_getBlockByNumber")
        return p[0] === "finalized"
          ? { number: kind === "awaiting_finality" ? "0x1" : "0x3" }
          : { hash: blockHash };
      if (method === "eth_getTransactionByHash")
        return { input: kind === "wrong_calldata" ? "0x" : data, value: "0x0", blockHash };
      return {
        status: "0x1",
        from: i.sender,
        to: token,
        blockHash,
        transactionHash,
        blockNumber: "0x2",
        logs: [
          {
            address: token,
            topics: encodeEventTopics({
              abi: erc20Abi,
              eventName: "Transfer",
              args: { from: i.sender, to: i.recipient },
            }),
            data: toHex(kind === "bad_event" ? 2 : 1, { size: 32 }),
          },
        ],
      };
    });
    if (kind.startsWith("bad") || kind === "wrong_calldata")
      await expect(promise).rejects.toThrow();
    else await expect(promise).resolves.toMatchObject({ status: kind, paidMicroUsdc: "1" });
  },
);
it("includes origin gas in ranking and leaves a price-dependent choice open without a rate", () => {
  const row = (id: string, usdc: string, wei: string) => ({
    quoteId: id,
    execution: "unsigned_origin_steps",
    maxInputMicroUsdc: usdc,
    originGas: { estimate: { totalWei: wei } },
  });
  const rows = [
    row("direct", "1000000", "1000000000000000"),
    row("bridge", "1003000", "1000000000000"),
  ];
  expect(comparePaymentCosts(rows, null).recommendedQuoteId).toBe(null);
  const priced = comparePaymentCosts(rows, 2000000000n);
  expect(priced.recommendedQuoteId).toBe("bridge");
  expect(priced.routes.map((r) => r.estimatedTotalMicroUsdc)).toEqual(["3000000", "1005000"]);
  expect(
    comparePaymentCosts([{ ...rows[0]!, execution: "quote_only" }, rows[1]!], null)
      .recommendedQuoteId,
  ).toBe("bridge");
});
