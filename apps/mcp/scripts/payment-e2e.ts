import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

const client = new Client({ name: "payment-acceptance", version: "1" });
const url = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
const headers = process.env.MCP_KEY ? { "x-api-key": process.env.MCP_KEY } : undefined;
const sender = "0x3428335FE86220c496773fE59D653d80DE8bf1Ea";
const recipient = "0xa11F5DA00D9a0E9b809E94c4cAe1efa36E8ff50b";
const intent = { sender, recipient, amountMicroUsdc: "1" };
const units = z.string().regex(/^\d+$/);
const routeSchema = z.object({
  quoteId: z.uuid(),
  chainId: z.literal(11155420),
  sourceChainId: z.number(),
  provider: z.string(),
  sender: z.string(),
  recipient: z.string(),
  amountMicroUsdc: z.literal("1"),
  sourceWallet: z.object({ balanceMicroUsdc: units, nativeBalanceWei: units }),
  fundingShortfall: z.object({ microUsdc: units, estimatedWei: units.nullable() }),
  execution: z.string(),
});

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = z.object({ text: z.string() }).parse(result.content[0]);
  assert.ok(!result.isError, content.text);
  return JSON.parse(content.text) as unknown;
}

await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
try {
  for (const tool of ["pay", "quote_payment"]) {
    const args = tool === "pay" ? { chainId: 11155420, intent } : { chainId: 11155420, ...intent };
    const comparison = z
      .object({
        routes: z.array(routeSchema),
        recommendedQuoteId: z.uuid().nullable(),
      })
      .parse(await call(tool, args));
    assert.deepEqual(comparison.routes.map((r) => [r.sourceChainId, r.provider]).sort(), [
      [11155420, "direct_transfer"],
      [84532, "across"],
    ]);
    for (const route of comparison.routes) {
      assert.equal(route.sender.toLowerCase(), sender.toLowerCase());
      assert.equal(route.recipient.toLowerCase(), recipient.toLowerCase());
    }
    if (comparison.recommendedQuoteId)
      assert.ok(
        comparison.routes.some(
          (r) => r.quoteId === comparison.recommendedQuoteId && r.execution !== "quote_only",
        ),
      );
    console.log(tool, JSON.stringify(comparison));
  }
  const historicalWallet = "0x46e25D3756e1Be06c3B477170c3A4DBA6528C7A9";
  const fillHash = "0x571281c0903a9ca3e66d07cfdf72686bdd9273716cf86c0fd5cbfdb741a2533c";
  const receipt = z
    .object({
      status: z.literal("settled"),
      depositId: z.literal("6488685"),
      spentMicroUsdc: z.literal("13442407"),
      paidMicroUsdc: z.literal("13440834"),
      fillHash: z.literal(fillHash),
      originFinalized: z.literal(true),
      destinationFinalized: z.literal(true),
    })
    .parse(
      await call("payment_status", {
        crossChain: {
          sender: historicalWallet,
          recipient: historicalWallet,
          sourceChainId: 8453,
          chainId: 10,
          amountMicroUsdc: "13440834",
          maxInputMicroUsdc: "13442407",
          originHash: "0x9716551a4041048abc84522e31660888fc65e7e44bd12db24b0818ba94bc22a7",
          fillHash,
        },
      }),
    );
  console.log("payment_status", JSON.stringify(receipt));
  const directHash = "0x73c067802b2b58184f1fdef6d86c780d5b6d52e51021f67f4f9a4141031886f0";
  const direct = z
    .object({
      status: z.literal("settled"),
      transactionHash: z.literal(directHash),
      paidMicroUsdc: z.literal("1494646"),
      fees: z.object({
        executionWei: z.literal("57691280687"),
        l1DataWei: z.literal("2713792278"),
      }),
    })
    .parse(
      await call("payment_status", {
        direct: {
          chainId: 10,
          sender: "0xa72b99b0c32b59050d5cedb3f3e6c8605e350c83",
          recipient: "0xc8fa2a53394ecf73488aedbf308312dd3ea18032",
          amountMicroUsdc: "1494646",
          transactionHash: directHash,
        },
      }),
    );
  console.log("payment_status", JSON.stringify(direct));
  const testDeposit = z
    .object({
      depositId: z.literal("1003766"),
      originFinalized: z.literal(true),
      spentMicroUsdc: z.literal("185"),
      approval: z.object({
        approvedMicroUsdc: z.literal("185"),
        finalized: z.literal(true),
        fees: z.object({ executionWei: z.literal("332478000000"), l1DataWei: z.literal("92") }),
      }),
      depositExecutionFeeWei: z.literal("438582000000"),
      depositL1DataFeeWei: z.literal("182"),
      status: z.enum([
        "awaiting_fill_index",
        "awaiting_verified_fill",
        "fill_deadline_passed",
        "expiry_reported",
        "recovery_reported",
        "awaiting_destination_receipt",
        "awaiting_finality",
        "settled",
      ]),
      providerStatus: z.string().optional(),
      destinationFinalized: z.boolean().optional(),
      paidMicroUsdc: units.optional(),
    })
    .parse(
      await call("payment_status", {
        crossChain: {
          sender: "0x182764751e965C703E2219FC9619326E11376747",
          recipient,
          sourceChainId: 84532,
          chainId: 11155420,
          amountMicroUsdc: "1",
          maxInputMicroUsdc: "185",
          approvalHash: "0x86ea178d4c9affd976cf85f96897aefdf096c1ae9f6ae26dba05bed7420f10f5",
          originHash: "0x00b6d876a2049bac05056b234ce98c0b389b7fef5efdd51a11b039b6a44d3769",
        },
      }),
    );
  if (testDeposit.status === "settled") {
    assert.equal(testDeposit.destinationFinalized, true);
    assert.equal(testDeposit.paidMicroUsdc, "1");
  }
  console.log("payment_status", JSON.stringify(testDeposit));
} finally {
  await client.close();
}
