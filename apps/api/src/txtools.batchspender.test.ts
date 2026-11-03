import {
  concatHex,
  encodeFunctionData,
  encodePacked,
  type Hex,
  maxUint256,
  parseAbi,
  size,
} from "viem";
import { describe, expect, it } from "vitest";
import { calldataChecks, decodeMultiSend, MAX_BATCH_DEPTH, verdictOf } from "./txtools.js";

const ME = "0xeb0eC7a28E4B6B175806E21D9D3afE45792C5c7B";
const SAFE = "0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const NFT = "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D";
const ROUTER = "0x111111125421cA6dc452d289314280a0f8842A65";
const DRAINER = "0x000000000000000000000000000000000000dEaD";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const MULTISEND = "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D";
const abi = parseAbi([
  "function approve(address,uint256)",
  "function increaseAllowance(address,uint256)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function setApprovalForAll(address,bool)",
  "function multicall(bytes[] data)",
  "function multicall(uint256 deadline, bytes[] data)",
  "function multicall(bytes32 previousBlockhash, bytes[] data)",
  "function multiSend(bytes transactions)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures)",
  "function swap(uint256)",
]);
const Z = "0x0000000000000000000000000000000000000000";
const approve = (s: Hex, n: bigint) =>
  encodeFunctionData({ abi, functionName: "approve", args: [s, n] });
const mc = (calls: Hex[]) => encodeFunctionData({ abi, functionName: "multicall", args: [calls] });
const entry = (op: number, to: Hex, data: Hex) =>
  encodePacked(
    ["uint8", "address", "uint256", "uint256", "bytes"],
    [op, to, 0n, BigInt(size(data)), data],
  );
const multiSend = (entries: Hex[]) =>
  encodeFunctionData({ abi, functionName: "multiSend", args: [concatHex(entries)] });
const exec = (to: Hex, data: Hex, op: number) =>
  encodeFunctionData({
    abi,
    functionName: "execTransaction",
    args: [to, 0n, data, op, 0n, 0n, 0n, Z, Z, "0x"],
  });
const run = (to: string, data: Hex, exp: Record<string, string>) =>
  calldataChecks({ from: ME, to, data, value: 0n }, exp).findings;
const has = (f: { check: string }[], c: string) => f.some((x) => x.check === c);

describe("expected.spender inside batches", () => {
  it("multicall(bytes[]): good inner approval passes, drainer inner approval is danger", () => {
    const ok = run(
      ROUTER,
      mc([approve(ROUTER, 5n), encodeFunctionData({ abi, functionName: "swap", args: [1n] })]),
      {
        spender: ROUTER,
        amount: "5",
      },
    );
    expect(
      has(ok, "spender-not-expected") ||
        has(ok, "spender-unchecked") ||
        has(ok, "amount-not-expected"),
    ).toBe(false);
    const bad = run(ROUTER, mc([approve(ROUTER, 5n), approve(DRAINER, 5n)]), { spender: ROUTER });
    expect(verdictOf(bad)).toBe("danger");
    expect(bad.find((x) => x.check === "spender-not-expected")?.message).toMatch(/multicall\[1\]/);
  });
  it("multicall(uint256,bytes[]) and multicall(bytes32,bytes[]) are decoded", () => {
    const d1 = encodeFunctionData({
      abi,
      functionName: "multicall",
      args: [1n, [approve(DRAINER, 1n)]],
    });
    const d2 = encodeFunctionData({
      abi,
      functionName: "multicall",
      args: [`0x${"11".repeat(32)}`, [approve(DRAINER, 1n)]],
    });
    for (const d of [d1, d2]) {
      const f = run(ROUTER, d, { spender: ROUTER });
      expect(has(f, "spender-not-expected")).toBe(true);
      expect(has(f, "spender-unchecked")).toBe(false);
    }
  });
  it("amount mismatch inside a multicall is danger", () => {
    const f = run(ROUTER, mc([approve(ROUTER, maxUint256)]), { spender: ROUTER, amount: "5" });
    expect(has(f, "amount-not-expected")).toBe(true);
    expect(verdictOf(f)).toBe("danger");
  });
  it("Safe execTransaction CALL to a token approve is checked", () => {
    const f = run(SAFE, exec(USDC, approve(DRAINER, 1n), 0), { spender: ROUTER });
    expect(has(f, "spender-not-expected")).toBe(true);
    const ok = run(SAFE, exec(USDC, approve(ROUTER, 1n), 0), { spender: ROUTER });
    expect(has(ok, "spender-not-expected") || has(ok, "spender-unchecked")).toBe(false);
  });
  it("Safe DELEGATECALL into MultiSend: every inner approval type is checked", () => {
    const p2 = encodeFunctionData({ abi, functionName: "approve", args: [USDC, DRAINER, 5n, 0] });
    const inc = encodeFunctionData({ abi, functionName: "increaseAllowance", args: [DRAINER, 5n] });
    const pm = encodeFunctionData({
      abi,
      functionName: "permit",
      args: [ME, DRAINER, 5n, 0n, 27, `0x${"00".repeat(32)}`, `0x${"00".repeat(32)}`],
    });
    const all = encodeFunctionData({
      abi,
      functionName: "setApprovalForAll",
      args: [DRAINER, true],
    });
    const ms = multiSend([
      entry(0, USDC, approve(ROUTER, 5n)),
      entry(0, PERMIT2, p2),
      entry(0, USDC, inc),
      entry(0, USDC, pm),
      entry(0, NFT, all),
    ]);
    const f = run(SAFE, exec(MULTISEND, ms, 1), { spender: ROUTER });
    expect(f.filter((x) => x.check === "spender-not-expected")).toHaveLength(4);
    expect(has(f, "spender-unchecked")).toBe(false);
    const good = run(SAFE, exec(MULTISEND, multiSend([entry(0, USDC, approve(ROUTER, 5n))]), 1), {
      spender: ROUTER,
      amount: "5",
    });
    expect(
      has(good, "spender-not-expected") ||
        has(good, "spender-unchecked") ||
        has(good, "amount-not-expected"),
    ).toBe(false);
  });
  it("direct multiSend call is decoded", () => {
    const f = run(MULTISEND, multiSend([entry(0, USDC, approve(DRAINER, 5n))]), {
      spender: ROUTER,
    });
    expect(has(f, "spender-not-expected")).toBe(true);
  });
  it("nested batches are followed: Safe -> MultiSend -> router multicall -> approve", () => {
    const inner = mc([approve(DRAINER, 1n)]);
    const f = run(SAFE, exec(MULTISEND, multiSend([entry(0, ROUTER, inner)]), 1), {
      spender: ROUTER,
    });
    expect(f.find((x) => x.check === "spender-not-expected")?.message).toMatch(
      /execTransaction\.multiSend\[0\]\.multicall\[0\]/,
    );
  });
  it("fail closed: delegatecall to an unknown contract, delegatecall inside MultiSend, malformed payloads, depth", () => {
    const unk = run(SAFE, exec(DRAINER, multiSend([entry(0, USDC, approve(ROUTER, 1n))]), 1), {
      spender: ROUTER,
    });
    expect(has(unk, "spender-unchecked")).toBe(true);
    expect(verdictOf(unk)).toBe("danger");
    const dc = run(SAFE, exec(MULTISEND, multiSend([entry(1, DRAINER, "0x12345678")]), 1), {
      spender: ROUTER,
    });
    expect(has(dc, "spender-unchecked")).toBe(true);
    const notMs = run(SAFE, exec(MULTISEND, approve(ROUTER, 1n), 1), { spender: ROUTER });
    expect(has(notMs, "spender-unchecked")).toBe(true);
    const bad = encodeFunctionData({ abi, functionName: "multiSend", args: ["0x00aabb"] });
    expect(has(run(MULTISEND, bad, { spender: ROUTER }), "spender-unchecked")).toBe(true);
    const trunc = mc([approve(ROUTER, 1n)]).slice(0, 80) as Hex;
    expect(has(run(ROUTER, trunc, { spender: ROUTER }), "spender-unchecked")).toBe(true);
    let deep: Hex = approve(ROUTER, 1n);
    for (let i = 0; i <= MAX_BATCH_DEPTH; i++) deep = mc([deep]);
    const df = run(ROUTER, deep, { spender: ROUTER });
    expect(has(df, "spender-unchecked")).toBe(true);
    expect(verdictOf(df)).toBe("danger");
    let ok: Hex = approve(ROUTER, 1n);
    for (let i = 0; i < MAX_BATCH_DEPTH; i++) ok = mc([ok]);
    expect(has(run(ROUTER, ok, { spender: ROUTER }), "spender-unchecked")).toBe(false);
  });
  it("decodeMultiSend rejects a length past the end and bad operations", () => {
    expect(() => decodeMultiSend(entry(0, USDC, "0x1234").slice(0, -2) as Hex)).toThrow();
    expect(() => decodeMultiSend(entry(2, USDC, "0x") as Hex)).toThrow();
    expect(decodeMultiSend(concatHex([entry(0, USDC, "0x"), entry(0, NFT, "0xab")]))).toHaveLength(
      2,
    );
  });
});
