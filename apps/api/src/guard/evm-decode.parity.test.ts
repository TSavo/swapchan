import {
  getAddress,
  type Hex,
  parseAbi,
  toHex,
  decodeFunctionData as vDec,
  decodeAbiParameters as vDecParams,
  encodeFunctionData as vEnc,
  encodeAbiParameters as vEncParams,
} from "viem";
import { describe, expect, it } from "vitest";
import { decodeAbiParameters, decodeFunctionData } from "../blocktools.js";
import { ABIS } from "./evm.js";

// Byte-for-byte decision parity: blocktools evmAbiDecode (via the drop-in wrappers) reproduces viem's
// decodeFunctionData / decodeAbiParameters on the exact ABIs the EVM guard decodes. viem encodes each call,
// then both decoders run and their decoded values must be deep-equal — the guard reads these fields to
// accept/reject, so equal values mean an unchanged decision.
let seed = 0xc0ffee11;
const rnd = () => {
  seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
  return seed / 2 ** 32;
};
const ri = (n: number) => Math.floor(rnd() * n);
const bytes = (n: number) => toHex(Uint8Array.from({ length: n }, () => ri(256)));
type P = { type: string; name?: string; components?: readonly P[] };
const genVal = (p: P): unknown => {
  const arr = /^(.*)\[(\d*)\]$/.exec(p.type);
  if (arr)
    return Array.from({ length: arr[2] ? Number(arr[2]) : 1 + ri(3) }, () =>
      genVal({ ...p, type: arr[1]! }),
    );
  if (p.type === "tuple")
    return Object.fromEntries((p.components ?? []).map((c) => [c.name, genVal(c)]));
  const m = /^(u?)int(\d+)$/.exec(p.type);
  if (m) {
    const bits = BigInt(m[2]!);
    const max = m[1] ? 2n ** bits - 1n : 2n ** (bits - 1n) - 1n;
    const min = m[1] ? 0n : -(2n ** (bits - 1n));
    const edge = ri(3);
    if (edge === 0) return max;
    if (edge === 1) return min;
    return min + (BigInt(bytes(Number(bits) / 8)) % (max - min + 1n));
  }
  if (p.type === "address") return getAddress(bytes(20));
  if (p.type === "bool") return ri(2) === 1;
  if (p.type === "bytes") return bytes(ri(70));
  if (p.type === "string") return ["", "héllo ✓", "a".repeat(ri(40)), '"q"\\'][ri(4)];
  const n = /^bytes(\d+)$/.exec(p.type);
  if (n) return bytes(Number(n![1]));
  throw new Error(`unhandled type ${p.type}`);
};

describe("EVM guard call decoding parity: blocktools vs viem", () => {
  it("decodeFunctionData matches viem on every function of every router ABI (50 random calls each)", () => {
    let fns = 0;
    for (const abi of Object.values(ABIS)) {
      for (const item of abi as readonly P[]) {
        if ((item as { type: string }).type !== "function") continue;
        const inputs = (item as { inputs?: readonly P[] }).inputs ?? [];
        for (let i = 0; i < 50; i++) {
          const args = inputs.map(genVal);
          const data = vEnc({
            abi: abi as never,
            functionName: (item as { name: string }).name,
            args,
          } as never) as Hex;
          const v = vDec({ abi: abi as never, data });
          const b = decodeFunctionData({ abi, data });
          expect(b.functionName).toBe(v.functionName);
          expect(b.args).toEqual(v.args);
        }
        fns++;
      }
    }
    expect(fns).toBeGreaterThan(25);
  });

  it("decodeAbiParameters matches viem on the LI.FI BridgeData tuple (200 random)", () => {
    const BRIDGE = [
      {
        type: "tuple",
        components: [
          { type: "bytes32", name: "transactionId" },
          { type: "string", name: "bridge" },
          { type: "string", name: "integrator" },
          { type: "address", name: "referrer" },
          { type: "address", name: "sendingAssetId" },
          { type: "address", name: "receiver" },
          { type: "uint256", name: "minAmount" },
          { type: "uint256", name: "destinationChainId" },
          { type: "bool", name: "hasSourceSwaps" },
          { type: "bool", name: "hasDestinationCall" },
        ],
      },
    ] as const;
    for (let i = 0; i < 200; i++) {
      const val = genVal(BRIDGE[0] as P);
      const data = vEncParams(BRIDGE as never, [val] as never) as Hex;
      expect(decodeAbiParameters(BRIDGE as never, data)).toEqual(vDecParams(BRIDGE as never, data));
    }
  });

  it("decodeFunctionData matches viem for erc20 approve (incl. maxUint256 and 0)", () => {
    const abi = parseAbi(["function approve(address spender,uint256 amount)"]);
    for (const amount of [0n, 1n, 1000000000n, 2n ** 256n - 1n]) {
      const data = vEnc({
        abi,
        functionName: "approve",
        args: ["0xeb0eC7a28E4B6B175806E21D9D3afE45792C5c7B", amount],
      }) as Hex;
      expect(decodeFunctionData({ abi, data }).args).toEqual(vDec({ abi, data }).args);
    }
  });

  it("accepts trailing bytes after the last ABI word, like viem (blocktools allow_trailing)", () => {
    const abi = parseAbi(["function approve(address spender,uint256 amount)"]);
    const data = vEnc({
      abi,
      functionName: "approve",
      args: ["0xeb0eC7a28E4B6B175806E21D9D3afE45792C5c7B", 2n ** 128n],
    }) as Hex;
    for (const suffix of ["00", "deadbeef", "ab".repeat(32), "cd".repeat(45)]) {
      const d = `${data}${suffix}` as Hex;
      expect(decodeFunctionData({ abi, data: d }).args).toEqual(vDec({ abi, data: d }).args);
    }
    const T = [{ type: "uint256" }, { type: "address" }] as const;
    const enc = vEncParams(T, [7n, "0xeb0eC7a28E4B6B175806E21D9D3afE45792C5c7B"]);
    const d = `${enc}${"11".repeat(40)}` as Hex;
    expect(decodeAbiParameters(T as never, d)).toEqual(vDecParams(T, d));
  });

  it("throws (like viem) on calldata that matches no ABI function", () => {
    expect(() => decodeFunctionData({ abi: ABIS.oneinch, data: "0xdeadbeef" })).toThrow();
  });
});
