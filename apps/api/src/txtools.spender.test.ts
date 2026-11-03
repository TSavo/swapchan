import { encodeFunctionData, maxUint256, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { calldataChecks, checkExpectedSpender, verdictOf } from "./txtools.js";

const ME = "0xeb0eC7a28E4B6B175806E21D9D3afE45792C5c7B";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ROUTER = "0x111111125421cA6dc452d289314280a0f8842A65";
const DRAINER = "0x000000000000000000000000000000000000dEaD";
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const abi = parseAbi([
  "function approve(address,uint256)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function setApprovalForAll(address,bool)",
  "function multicall(bytes[] data)",
]);
const approve = (s: `0x${string}`, n: bigint) =>
  encodeFunctionData({ abi, functionName: "approve", args: [s, n] });
const run = (data: `0x${string}`, exp: Record<string, string>, to = USDC) =>
  calldataChecks({ from: ME, to, data, value: 0n }, exp).findings;

describe("expected.spender / expected.amount", () => {
  it("exact-balance approval to a drainer: caution without spender, danger with it", () => {
    expect(verdictOf(run(approve(DRAINER, 1234n), {}))).toBe("caution");
    const f = run(approve(DRAINER, 1234n), { spender: ROUTER });
    expect(verdictOf(f)).toBe("danger");
    expect(f.some((x) => x.check === "spender-not-expected")).toBe(true);
  });
  it("passes the spender check for the expected spender (any case)", () => {
    const f = run(approve(ROUTER, 1234n), { spender: ROUTER.toLowerCase(), amount: "1234" });
    expect(
      f.some((x) => x.check === "spender-not-expected" || x.check === "amount-not-expected"),
    ).toBe(false);
  });
  it("amount mismatch is danger", () => {
    const f = run(approve(ROUTER, 1235n), { spender: ROUTER, amount: "1234" });
    expect(f.some((x) => x.check === "amount-not-expected")).toBe(true);
    expect(verdictOf(f)).toBe("danger");
  });
  it("lookalike spender is critical", () => {
    const look = "0x1111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2a65";
    const f = run(approve(look, 1n), { spender: ROUTER });
    expect(f.find((x) => x.check === "spender-not-expected")?.severity).toBe("critical");
  });
  it("Permit2 approve and setApprovalForAll are checked", () => {
    const p2 = encodeFunctionData({ abi, functionName: "approve", args: [USDC, DRAINER, 5n, 0] });
    expect(
      run(p2, { spender: ROUTER }, PERMIT2).some((x) => x.check === "spender-not-expected"),
    ).toBe(true);
    const all = encodeFunctionData({
      abi,
      functionName: "setApprovalForAll",
      args: [DRAINER, true],
    });
    expect(run(all, { spender: ROUTER }).some((x) => x.check === "spender-not-expected")).toBe(
      true,
    );
  });
  it("multicall batch fails closed", () => {
    const mc = encodeFunctionData({
      abi,
      functionName: "multicall",
      args: [[approve(ROUTER, maxUint256)]],
    });
    expect(
      run(mc, { spender: ROUTER }).find((x) => x.check === "spender-unchecked")?.severity,
    ).toBe("high");
  });
  it("input validation", () => {
    expect(() => checkExpectedSpender(1, { spender: "0x12" })).toThrow(/bad_expected_spender/);
    expect(() => checkExpectedSpender(1, { spender: ROUTER, amount: "1.5" })).toThrow(
      /bad_expected_amount/,
    );
    expect(() => checkExpectedSpender(1, { amount: "5" })).toThrow(/expected_amount_needs_spender/);
    expect(() => checkExpectedSpender(792703809, { spender: ROUTER } as never)).toThrow(/evm_only/);
    expect(() => checkExpectedSpender(1, { spender: ROUTER, amount: "5" })).not.toThrow();
  });
});
