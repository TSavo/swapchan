/**
 * verify_tx, broadcast_tx, tx_status and signing_guide.
 * Trustless: SwapChan never holds keys and cannot alter a signed tx. verify_tx reads chain state and simulates;
 * broadcast_tx only relays bytes the user's wallet already signed.
 */

import { BROADCAST_COUNT, broadcastSummary, NATIVE_TOKEN, SOLANA, TRON } from "@swapchan/shared";
import {
  decodeFunctionData,
  formatEther,
  type Hex,
  isAddress,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerialized,
} from "viem";
import { fullAddress } from "./addrDisplay.js";
import { type BtSolTx, blocktools, btKeccak256, btSolDecodeTx } from "./blocktools.js";
import { recoveryGuide, type Situation } from "./keyrecovery.js";
import { allowlistedSpenders, confirmMorphoVault, lendingChecks } from "./lending.js";
import {
  BadRequest,
  chainName,
  EXPLORER,
  evmClient,
  json,
  listed,
  SITE,
  solRpc,
} from "./onchain.js";
import { verifyRecovery } from "./recover.js";

type F = typeof fetch;
export const BITCOIN = 8253038;
export type Severity = "critical" | "high" | "warn" | "info";
export interface Finding {
  severity: Severity;
  check: string;
  message: string;
}
export interface Expected {
  to?: string;
  recipient?: string;
  maxValue?: string;
  minOut?: string;
  quotedOut?: string;
  /** Token whose simulated receipt is checked against minOut (default: the largest receipt). */
  outToken?: string;
  /** EVM only: every approval in the tx (approve, increaseAllowance, permit, Permit2 approve, setApprovalForAll) must name this spender. */
  spender?: string;
  /** EVM only, needs spender: the approval amount must equal this (decimal base units). */
  amount?: string;
}

const MAX_HALF = 2n ** 255n;
const DANGER = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function increaseAllowance(address spender, uint256 added)",
  "function setApprovalForAll(address operator, bool approved)",
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function safeTransferFrom(address from, address to, uint256 id)",
  "function transferOwnership(address newOwner)",
  "function renounceOwnership()",
  "function upgradeTo(address impl)",
  "function upgradeToAndCall(address impl, bytes data)",
  "function changeAdmin(address admin)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures)",
  "function multicall(bytes[] data)",
  "function multicall(uint256 deadline, bytes[] data)",
]);
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
// legacy OpenZeppelin (zos) slot, used by e.g. USDC
const ZOS_IMPL = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const lc = (s?: string) => (s ?? "").toLowerCase();
/** Full address (EIP-55 for EVM), never shortened: lookalike addresses copy the ends. */
const short = fullAddress;
/** Address poisoning: same first 4 and last 4 chars, different address. */
export const lookalike = (a: string, b: string) =>
  lc(a) !== lc(b) && lc(a).slice(2, 6) === lc(b).slice(2, 6) && lc(a).slice(-4) === lc(b).slice(-4);

/** Pure calldata checks (no network). */
export function calldataChecks(
  tx: { from?: string; to: string; data: Hex; value: bigint },
  exp: Expected = {},
): { findings: Finding[]; call?: string } {
  const out: Finding[] = [];
  const add = (severity: Severity, check: string, message: string) =>
    out.push({ severity, check, message });
  const from = lc(tx.from);
  if (exp.to && lc(exp.to) !== lc(tx.to))
    add(
      lookalike(exp.to, tx.to) ? "critical" : "high",
      "target",
      lookalike(exp.to, tx.to)
        ? `Target ${tx.to} LOOKS LIKE the expected ${exp.to} but is a different address (address poisoning).`
        : `Target ${tx.to} is not the expected contract ${exp.to}.`,
    );
  if (exp.maxValue && tx.value > BigInt(exp.maxValue))
    add("high", "value", `Sends ${formatEther(tx.value)} native, above your cap.`);
  let call: string | undefined;
  if (tx.data && tx.data !== "0x") {
    try {
      const d = decodeFunctionData({ abi: DANGER, data: tx.data });
      const a = (d.args ?? []) as readonly unknown[];
      call = d.functionName;
      const arg = (i: number) => String(a[i]);
      switch (d.functionName) {
        case "approve":
          if (lc(tx.to) === PERMIT2 && a.length === 4)
            add(
              (a[2] as bigint) >= 2n ** 159n ? "high" : "warn",
              "permit2",
              `Permit2 allowance for ${arg(1)} on token ${arg(0)}.`,
            );
          else if ((a[1] as bigint) >= MAX_HALF)
            add(
              "high",
              "unlimited-approval",
              `UNLIMITED approval to ${arg(0)}: it can take all of this token, now or later. Prefer the exact amount and revoke after.`,
            );
          else
            add(
              "warn",
              "approval",
              `Approves ${arg(0)} to spend ${arg(1)} units. Revoke after use.`,
            );
          break;
        case "increaseAllowance":
          add(
            (a[1] as bigint) >= MAX_HALF ? "high" : "warn",
            "approval",
            `Raises allowance for ${arg(0)}.`,
          );
          break;
        case "setApprovalForAll":
          if (a[1] === true)
            add(
              "high",
              "approval-for-all",
              `Gives ${arg(0)} control of EVERY NFT in this collection. Classic drainer pattern.`,
            );
          break;
        case "transfer":
          add(
            exp.recipient && lc(arg(0)) !== lc(exp.recipient) ? "high" : "info",
            "recipient",
            `Sends tokens to ${arg(0)}.`,
          );
          if (exp.recipient && lookalike(arg(0), exp.recipient))
            add(
              "critical",
              "address-poisoning",
              `Recipient ${arg(0)} is a lookalike of ${exp.recipient}.`,
            );
          break;
        case "transferFrom":
        case "safeTransferFrom":
          add(
            from && lc(arg(0)) === from && (!exp.recipient || lc(arg(1)) !== lc(exp.recipient))
              ? "warn"
              : "info",
            "recipient",
            `Moves assets from ${short(arg(0))} to ${arg(1)}.`,
          );
          break;
        case "transferOwnership":
        case "renounceOwnership":
        case "changeAdmin":
          add("critical", "ownership", `${d.functionName}: hands over control of the contract.`);
          break;
        case "upgradeTo":
        case "upgradeToAndCall":
          add("critical", "proxy-upgrade", `Upgrades the contract's code to ${arg(0)}.`);
          break;
        case "permit":
          add(
            (a[2] as bigint) >= MAX_HALF ? "high" : "warn",
            "permit",
            `Signature-based approval to ${arg(1)}.`,
          );
          break;
        case "execTransaction":
          if (Number(a[3]) === 1)
            add(
              "critical",
              "delegatecall",
              `Safe tx uses DELEGATECALL into ${arg(0)}: that code runs as your Safe and can do anything.`,
            );
          else
            add(
              "info",
              "safe",
              `Safe tx calling ${arg(0)} with ${formatEther(a[1] as bigint)} native.`,
            );
          break;
        case "multicall":
          add("warn", "multicall", "Batches several calls; decode and check each inner call.");
          break;
      }
    } catch {
      call = tx.data.slice(0, 10);
    }
  }
  if (exp.spender || exp.amount) {
    // Fail closed: the spender is what matters (an exact-balance approval to a drainer is not "unlimited").
    let ap: { spender: string; amount?: bigint } | undefined;
    if (call && tx.data && tx.data !== "0x") {
      try {
        const d = decodeFunctionData({ abi: DANGER, data: tx.data });
        const a = (d.args ?? []) as readonly unknown[];
        if (d.functionName === "approve" && lc(tx.to) === PERMIT2 && a.length === 4)
          ap = { spender: String(a[1]), amount: a[2] as bigint };
        else if (d.functionName === "approve" || d.functionName === "increaseAllowance")
          ap = { spender: String(a[0]), amount: a[1] as bigint };
        else if (d.functionName === "permit") ap = { spender: String(a[1]), amount: a[2] as bigint };
        else if (d.functionName === "setApprovalForAll" && a[1] === true) ap = { spender: String(a[0]) };
        else if (d.functionName === "multicall" || d.functionName === "execTransaction")
          add(
            "high",
            "spender-unchecked",
            `expected spender/amount given, but this is a ${d.functionName} batch whose inner calls are not decoded here, so it cannot be shown to hold.`,
          );
      } catch {
        /* undecodable: handled below */
      }
    }
    if (ap) {
      if (exp.spender && lc(ap.spender) !== lc(exp.spender))
        add(
          lookalike(ap.spender, exp.spender) ? "critical" : "high",
          "spender-not-expected",
          lookalike(ap.spender, exp.spender)
            ? `Approval spender ${ap.spender} LOOKS LIKE the expected ${exp.spender} but is a different address (address poisoning).`
            : `Approval spender ${ap.spender} is not the expected spender ${exp.spender}. Do not sign.`,
        );
      if (exp.amount !== undefined) {
        if (ap.amount === undefined)
          add("high", "amount-not-expected", `setApprovalForAll has no amount; expected ${exp.amount}.`);
        else if (ap.amount !== BigInt(exp.amount))
          add(
            "high",
            "amount-not-expected",
            `Approval amount ${ap.amount} is not the expected ${exp.amount}.`,
          );
      }
    } else if (!out.some((f) => f.check === "spender-unchecked"))
      add(
        "info",
        "spender",
        "expected spender/amount given; this tx makes no approval (approve, increaseAllowance, permit, Permit2, setApprovalForAll).",
      );
  }
  if (
    tx.from &&
    verifyRecovery({ to: tx.to, data: tx.data, value: tx.value.toString() }, tx.from).verified
  )
    add("info", "recovery", "Standard owner-only withdraw/claim: funds can only go to you.");
  if (exp.minOut && exp.quotedOut && BigInt(exp.minOut) * 100n < BigInt(exp.quotedOut) * 95n)
    add(
      "high",
      "min-out",
      "minOut is more than 5% below an independent quote: slippage/sandwich risk.",
    );
  return { findings: out, ...(call ? { call } : {}) };
}

const NO_PAYOUT = new Set(["approve", "increaseAllowance", "setApprovalForAll", "permit"]);
/**
 * expected.recipient / expected.minOut checked against the simulated outcome, fail closed:
 * if they were given and cannot be shown to hold, the finding is high.
 */
export function outcomeChecks(
  exp: Expected,
  call: string | undefined,
  data: Hex,
  simulated: boolean,
  received: Map<string, bigint>,
  /** The call books a position for the signer (repay, supplyCollateral) instead of paying a token back. */
  position = false,
): Finding[] {
  const out: Finding[] = [];
  if (!exp.recipient && !exp.minOut) return out;
  if (call && NO_PAYOUT.has(call)) return out;
  if (!simulated) {
    out.push({
      severity: "high",
      check: "outcome-unverified",
      message:
        "expected.recipient / minOut could not be checked: the tx was not simulated (pass `from`, or the node lacks eth_simulateV1, or it reverts).",
    });
    return out;
  }
  const who = exp.recipient ?? "the sender";
  if (exp.recipient && received.size === 0 && !position) {
    const inData = data.toLowerCase().includes(lc(exp.recipient).slice(2));
    out.push({
      severity: inData ? "warn" : "high",
      check: "recipient",
      message: inData
        ? `Nothing reaches ${exp.recipient} on this chain in the simulation; the address is in the calldata (cross-chain delivery?). Confirm on the destination.`
        : `The simulation pays nothing to the expected recipient ${exp.recipient}.`,
    });
  }
  if (exp.minOut) {
    const min = BigInt(exp.minOut);
    const got = exp.outToken
      ? (received.get(lc(exp.outToken)) ?? 0n)
      : [...received.values()].reduce((m, x) => (x > m ? x : m), 0n);
    if (
      got < min &&
      !(exp.recipient && received.size === 0 && out.some((f) => f.severity === "warn"))
    )
      out.push({
        severity: "high",
        check: "min-out",
        message: `Simulated receipt for ${who} is ${got}, below expected.minOut ${min}.`,
      });
  }
  return out;
}

export const verdictOf = (fs: Finding[]) =>
  fs.some((f) => f.severity === "critical" || f.severity === "high")
    ? "danger"
    : fs.some((f) => f.severity === "warn")
      ? "caution"
      : "ok";
const lead = (v: string) =>
  v === "ok"
    ? "Looks safe"
    : v === "caution"
      ? "Check before signing"
      : "DO NOT SIGN without understanding this";
const SIGNOFF =
  "Show this summary to the human and get an explicit yes for THIS transaction before their wallet signs it.";
const TRUST = "SwapChan never signs and never holds keys or funds. This is read-only analysis.";

async function verifiedSource(f: F, env: NodeJS.ProcessEnv, chainId: number, addr: string) {
  if (!env.ETHERSCAN_API_KEY) return null;
  const r = await json<{
    result?: {
      ContractName?: string;
      SourceCode?: string;
      Proxy?: string;
      Implementation?: string;
    }[];
  }>(
    f,
    `https://api.etherscan.io/v2/api?chainid=${chainId}&module=contract&action=getsourcecode&address=${addr}&apikey=${env.ETHERSCAN_API_KEY}`,
  ).catch(() => null);
  const x = r?.result?.[0];
  return x && typeof x === "object"
    ? {
        verified: !!x.SourceCode,
        name: x.ContractName || null,
        proxy: x.Proxy === "1",
        implementation: x.Implementation || null,
      }
    : null;
}

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// WETH9 Deposit(address indexed dst, uint256 wad) / Withdrawal(address indexed src, uint256 wad).
const WETH_DEPOSIT = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";
const WETH_WITHDRAWAL = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";
/**
 * Canonical wrapped-native contract per chain: Deposit/Withdrawal are only read from THIS emitter
 * (anyone can emit a fake Deposit(you) from a junk contract). Source: Uniswap sdk-core WETH9 map
 * (src/entities/weth9.ts). Chains not listed (e.g. Linea, Scroll) are unsupported: a wrap there is
 * judged on Transfer logs alone.
 */
export const WRAPPED_NATIVE: Record<number, string> = {
  1: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  10: "0x4200000000000000000000000000000000000006",
  8453: "0x4200000000000000000000000000000000000006",
  42161: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
  56: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  137: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
  43114: "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7",
};
export async function verifyEvm(
  f: F,
  env: NodeJS.ProcessEnv,
  chainId: number,
  tx: { from?: string; to: string; data?: string; value?: string; authorizationList?: unknown[] },
  exp: Expected = {},
) {
  if (!isAddress(tx.to)) throw new BadRequest("to must be an address");
  const data = (tx.data ?? "0x") as Hex;
  const value = BigInt(tx.value ?? "0");
  const c = evmClient(chainId, env);
  const { findings, call } = calldataChecks(
    { ...(tx.from ? { from: tx.from } : {}), to: tx.to, data, value },
    exp,
  );
  const add = (severity: Severity, check: string, message: string) =>
    findings.push({ severity, check, message });
  // Lending / yield protocols (Morpho, Aave, Pendle, Merkl): beneficiary must be you, target must
  // be allowlisted or factory-confirmed; see lending.ts.
  const lend = await lendingChecks(
    c as never,
    chainId,
    { from: tx.from, to: tx.to, data },
    f as never,
  );
  findings.push(...lend.findings);
  if (call === "approve" && lc(tx.to) !== PERMIT2) {
    const i = findings.findIndex((x) => x.check === "approval" && x.severity === "warn");
    const spender = lc(`0x${data.slice(34, 74)}`);
    if (
      i >= 0 &&
      (allowlistedSpenders(chainId).has(spender) ||
        (await confirmMorphoVault(c as never, chainId, spender)))
    )
      findings[i] = {
        severity: "info",
        check: "approval",
        message: `Exact approval to ${spender}, a known lending contract on this chain. Revoke after use.`,
      };
  }
  if (tx.authorizationList?.length)
    add(
      "critical",
      "eip7702",
      "EIP-7702 delegation: your account would run another contract's code. Only sign for a wallet you trust.",
    );
  const [code, impl, src] = await Promise.all([
    c.getCode({ address: tx.to as Hex }).catch(() => undefined),
    Promise.all(
      [EIP1967_IMPL as Hex, ZOS_IMPL as Hex].map((slot) =>
        c.getStorageAt({ address: tx.to as Hex, slot }).catch(() => undefined),
      ),
    ).then((xs) => xs.find((x) => x && BigInt(x) !== 0n)),
    verifiedSource(f, env, chainId, tx.to),
  ]);
  const isContract = !!code && code !== "0x";
  if (!isContract && data !== "0x")
    add("high", "target", `${tx.to} has no code, but the tx carries calldata.`);
  if (code?.startsWith("0xef0100"))
    add("warn", "eip7702", "Target is an EIP-7702 delegated account.");
  if (impl && BigInt(impl) !== 0n)
    add(
      "warn",
      "proxy",
      `Upgradeable proxy (implementation 0x${impl.slice(-40)}): its code can change after you check it.`,
    );
  if (src && isContract && !src.verified)
    add("warn", "verified-source", "Contract source is NOT verified on the explorer.");
  let simulation: Record<string, unknown> = { method: "none" };
  // What the expected recipient (default: the sender) receives in the simulation.
  const received = new Map<string, bigint>();
  let simulated = false;
  if (tx.from) {
    try {
      const r = (await c.request({
        method: "eth_simulateV1" as never,
        params: [
          {
            blockStateCalls: [
              { calls: [{ from: tx.from, to: tx.to, data, value: `0x${value.toString(16)}` }] },
            ],
            traceTransfers: true,
            validation: false,
          },
          "latest",
        ] as never,
      })) as {
        calls: {
          status: string;
          logs: { address: string; topics: string[]; data: string }[];
          error?: { message: string };
        }[];
      }[];
      const cl = r[0]!.calls[0]!;
      const me = lc(tx.from);
      const rcpt = lc(exp.recipient || tx.from);
      // Bundles: a share token you receive counts only if Morpho's factory confirms the vault.
      if (lend.needsSimulation)
        for (const t of [
          ...new Set(
            cl.logs
              .filter(
                (l) =>
                  l.topics[0] === TRANSFER &&
                  l.topics.length === 3 &&
                  lc(`0x${l.topics[2]!.slice(26)}`) === me,
              )
              .map((l) => lc(l.address)),
          ),
        ].slice(0, 4))
          if (await confirmMorphoVault(c as never, chainId, t)) lend.credit.add(t);
      const changes = new Map<string, bigint>();
      // Anyone can emit Transfer(attacker -> you) from a junk contract. Only receipts of native, the
      // expected outToken, or a SwapChan-listed token count as value received; an unknown-token
      // "gain" must not cancel a loss or satisfy expected.recipient.
      const known = new Set(listed(chainId).map((t) => lc(t.address)));
      const counts = (tok: string) =>
        tok === NATIVE_TOKEN ||
        (!!exp.outToken && lc(tok) === lc(exp.outToken)) ||
        known.has(lc(tok)) ||
        lend.credit.has(lc(tok));
      for (const l of cl.logs)
        if (
          (l.topics[0] === TRANSFER && l.topics.length === 3) ||
          ((l.topics[0] === WETH_DEPOSIT || l.topics[0] === WETH_WITHDRAWAL) &&
            l.topics.length === 2 &&
            lc(l.address) === WRAPPED_NATIVE[chainId])
        ) {
          // WETH9 deposit/withdraw emit Deposit(dst)/Withdrawal(src), not Transfer: read them as a
          // mint to dst / burn from src so a wrap is not mistaken for "you lose assets".
          const ZERO = "0x0000000000000000000000000000000000000000";
          const [fr, to] =
            l.topics[0] === TRANSFER
              ? [`0x${l.topics[1]!.slice(26)}`, `0x${l.topics[2]!.slice(26)}`]
              : l.topics[0] === WETH_DEPOSIT
                ? [ZERO, `0x${l.topics[1]!.slice(26)}`]
                : [`0x${l.topics[1]!.slice(26)}`, ZERO];
          const amt = BigInt(l.data === "0x" ? 0 : l.data);
          const tok =
            lc(l.address) === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
              ? NATIVE_TOKEN
              : l.address;
          if (fr === me) changes.set(tok, (changes.get(tok) ?? 0n) - amt);
          if (to === me) changes.set(tok, (changes.get(tok) ?? 0n) + amt);
          // A send to yourself is a receipt when you are the expected recipient (self-send).
          if (to === rcpt && (fr !== rcpt || rcpt === me) && counts(tok))
            received.set(lc(tok), (received.get(lc(tok)) ?? 0n) + amt);
        }
      simulated = cl.status === "0x1";
      const diff = [...changes].map(([token, delta]) => ({ token, delta: delta.toString() }));
      simulation = {
        method: "eth_simulateV1",
        success: cl.status === "0x1",
        ...(cl.error ? { error: cl.error.message } : {}),
        balanceChanges: diff,
      };
      if (cl.status !== "0x1")
        add("high", "simulation", `Simulation reverts: ${cl.error?.message ?? "unknown"}`);
      const lose = diff.some((d) => BigInt(d.delta) < 0n);
      const gain = diff.some((d) => BigInt(d.delta) > 0n && counts(d.token));
      const stray = lend.spend
        ? diff.filter(
            (d) =>
              BigInt(d.delta) < 0n &&
              d.token !== NATIVE_TOKEN &&
              (!lend.spend!.has(lc(d.token)) ||
                (lend.spendMax?.has(lc(d.token)) &&
                  -BigInt(d.delta) > (lend.spendMax.get(lc(d.token)) ?? 0n))),
          )
        : [];
      if (stray.length)
        add(
          "high",
          "lending-spend",
          `This ${lend.decoded?.fn ?? "call"} also takes ${stray.map((d) => d.token).join(", ")}, beyond the tokens and amounts it declares.`,
        );
      if (lose && !gain && !lend.position && !findings.some((x) => x.check === "recipient"))
        add("high", "balance-diff", "You lose assets and receive nothing back in the simulation.");
    } catch {
      try {
        await c.call({ account: tx.from as Hex, to: tx.to as Hex, data, value });
        simulation = {
          method: "eth_call",
          success: true,
          note: "node lacks eth_simulateV1; no balance diff",
        };
      } catch (e) {
        simulation = {
          method: "eth_call",
          success: false,
          error: (e as Error).message.split("\n")[0],
        };
        add("high", "simulation", `Simulation reverts: ${simulation.error}`);
      }
    }
  } else add("info", "simulation", "Pass `from` to simulate and diff balance changes.");
  if (lend.needsSimulation && !simulated)
    add(
      "high",
      "lending-bundle",
      "This bundle could not be simulated, so its steps cannot be checked.",
    );
  findings.push(...outcomeChecks(exp, call, data, simulated, received, lend.position));
  const verdict = verdictOf(findings);
  const ex = EXPLORER[chainId];
  const top = findings.filter((x) => x.severity !== "info").map((x) => x.message);
  return {
    chainId,
    chain: chainName(chainId),
    verdict,
    summary: `${lead(verdict)}: calls ${call ?? "nothing (plain transfer)"} on ${src?.name || short(tx.to)} (${chainName(chainId)}), sending ${formatEther(value)} native.${top.length ? ` ${top.join(" ")}` : ""}`,
    target: {
      address: tx.to,
      isContract,
      verifiedSource: src,
      explorer: ex ? `${ex}/address/${tx.to}#code` : null,
    },
    decoded: call ?? null,
    findings,
    simulation,
    humanSignOff: SIGNOFF,
    trust: TRUST,
  };
}

// ---------- Solana: wire decoder (blocktools wasm; fails closed, no TS fallback) ----------
export function decodeSolana(b64: string) {
  if (!blocktools()) throw new Error("blocktools unavailable");
  let d: BtSolTx;
  try {
    d = btSolDecodeTx(Buffer.from(b64, "base64").toString("hex"));
  } catch (e) {
    throw new BadRequest(
      `cannot decode Solana tx (${String((e as Error)?.message ?? e).slice(0, 60)})`,
    );
  }
  return {
    signed: d.signatures.some((s) => s.status !== "unsigned"),
    versioned: d.version !== "legacy",
    signers: d.accounts.slice(0, d.num_required_signatures).map((a) => a.pubkey),
    feePayer: d.fee_payer,
    programs: [...new Set(d.instructions.map((i) => i.program))],
  };
}
const SOL_KNOWN: Record<string, string> = {
  "11111111111111111111111111111111": "System",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token",
  ComputeBudget111111111111111111111111111111: "Compute Budget",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUJoi5QNyVTaV4: "Jupiter v6",
  Stake11111111111111111111111111111111111111: "Stake",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpool",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM",
};
export async function verifySolana(f: F, env: NodeJS.ProcessEnv, b64: string, exp: Expected = {}) {
  const d = decodeSolana(b64);
  const findings: Finding[] = [];
  for (const p of d.programs)
    if (!SOL_KNOWN[p])
      findings.push({
        severity: "warn",
        check: "program-allowlist",
        message: `Unknown program ${p}: check it on an explorer before signing.`,
      });
  if (d.programs.some((p) => p.startsWith("Tokenkeg") || p.startsWith("Tokenz")))
    findings.push({
      severity: "info",
      check: "token-program",
      message:
        "Touches token accounts: confirm destination owners are you or the intended recipient (SetAuthority/Approve are drainer patterns).",
    });
  if (exp.recipient && d.feePayer && lookalike(d.feePayer, exp.recipient))
    findings.push({
      severity: "critical",
      check: "address-poisoning",
      message: "Fee payer looks like, but is not, the expected wallet.",
    });
  const sim = await solRpc<{ value: { err: unknown; logs?: string[]; unitsConsumed?: number } }>(
    f,
    env,
    "simulateTransaction",
    [b64, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: !d.signed }],
  ).catch((e) => ({
    value: { err: (e as Error).message } as {
      err: unknown;
      logs?: string[];
      unitsConsumed?: number;
    },
  }));
  if (sim.value.err)
    findings.push({
      severity: "high",
      check: "simulation",
      message: `Simulation fails: ${JSON.stringify(sim.value.err)}`,
    });
  const verdict = verdictOf(findings);
  return {
    chainId: SOLANA,
    chain: "Solana",
    verdict,
    summary: `${lead(verdict)}: Solana tx using ${d.programs.map((p) => SOL_KNOWN[p] ?? short(p)).join(", ")}, fee payer ${short(d.feePayer ?? "")}.`,
    feePayer: d.feePayer,
    signers: d.signers,
    programs: d.programs.map((p) => ({ id: p, name: SOL_KNOWN[p] ?? null })),
    simulation: {
      method: "simulateTransaction",
      success: !sim.value.err,
      err: sim.value.err ?? null,
      unitsConsumed: sim.value.unitsConsumed ?? null,
      logs: (sim.value.logs ?? []).slice(-12),
    },
    findings,
    ...(d.versioned
      ? { note: "v0 tx: accounts from address lookup tables are not expanded." }
      : {}),
    humanSignOff: SIGNOFF,
    trust: TRUST,
  };
}

// ---------- Tron ----------
type TronTx = {
  txID?: string;
  raw_data?: { contract?: { type: string; parameter: { value: Record<string, unknown> } }[] };
  signature?: string[];
};
export function verifyTron(tx: TronTx, exp: Expected = {}) {
  const findings: Finding[] = [];
  const cs = tx.raw_data?.contract ?? [];
  if (!cs.length) throw new BadRequest("tron tx needs raw_data.contract");
  for (const c of cs) {
    const v = c.parameter.value;
    if (c.type === "TriggerSmartContract" && typeof v.data === "string")
      findings.push(
        ...calldataChecks({
          to: `0x${String(v.contract_address).slice(-40)}`,
          data: `0x${v.data}` as Hex,
          value: BigInt(Number(v.call_value ?? 0)),
        }).findings,
      );
    else if (c.type === "TransferContract")
      findings.push({
        severity: exp.recipient && lc(String(v.to_address)) !== lc(exp.recipient) ? "high" : "info",
        check: "recipient",
        message: `Sends ${Number(v.amount) / 1e6} TRX to ${String(v.to_address)}.`,
      });
    else if (c.type === "AccountPermissionUpdateContract")
      findings.push({
        severity: "critical",
        check: "permissions",
        message: "AccountPermissionUpdate: changes who controls the account. Classic Tron drainer.",
      });
    else findings.push({ severity: "info", check: "type", message: c.type });
  }
  const verdict = verdictOf(findings);
  return {
    chainId: TRON,
    chain: "Tron",
    verdict,
    summary: `${lead(verdict)}: Tron ${cs.map((c) => c.type).join(", ")}.`,
    contracts: cs.map((c) => c.type),
    findings,
    humanSignOff: SIGNOFF,
    trust: TRUST,
  };
}

/** expected.spender / expected.amount: EVM only; bad input is refused rather than ignored. */
export function checkExpectedSpender(chainId: number, exp: Expected) {
  const { spender, amount } = exp as { spender?: unknown; amount?: unknown };
  if (spender === undefined && amount === undefined) return;
  if (chainId === SOLANA || chainId === TRON || chainId === BITCOIN)
    throw new BadRequest("expected_spender_evm_only: expected.spender/amount are checked on EVM chains only");
  if (spender !== undefined && (typeof spender !== "string" || !isAddress(spender, { strict: false })))
    throw new BadRequest("bad_expected_spender: expected.spender must be a 0x EVM address");
  if (amount !== undefined) {
    if (typeof amount !== "string" || !/^[0-9]{1,78}$/.test(amount))
      throw new BadRequest("bad_expected_amount: expected.amount must be a decimal string of base units");
    if (spender === undefined)
      throw new BadRequest("expected_amount_needs_spender: give expected.spender with expected.amount");
  }
}

export async function verifyTx(
  f: F,
  env: NodeJS.ProcessEnv,
  chainId: number,
  tx: unknown,
  exp: Expected = {},
) {
  checkExpectedSpender(chainId, exp);
  if (chainId === SOLANA) return verifySolana(f, env, String(tx), exp);
  if (chainId === TRON)
    return verifyTron((typeof tx === "string" ? JSON.parse(tx) : tx) as TronTx, exp);
  if (chainId === BITCOIN)
    throw new BadRequest("verify_tx does not decode Bitcoin yet; review the PSBT in your wallet");
  return verifyEvm(f, env, chainId, tx as never, exp);
}

// ---------- broadcast ----------
const isHex = (s: string) => /^(0x)?[0-9a-fA-F]+$/.test(s);
export async function broadcastTx(
  f: F,
  env: NodeJS.ProcessEnv,
  b: { chainId: number; tx: string | Record<string, unknown>; private?: boolean; strict?: boolean },
) {
  const { chainId } = b;
  const blocked = (verify: { verdict: string }) =>
    b.strict && verify.verdict === "danger"
      ? { broadcast: false, reason: "strict: verify_tx verdict is danger", verify }
      : null;
  if (chainId === SOLANA) {
    const raw = String(b.tx);
    const v = await verifySolana(f, env, raw);
    const stop = blocked(v);
    if (stop) return stop;
    try {
      const sig = await solRpc<string>(f, env, "sendTransaction", [raw, { encoding: "base64" }]);
      return {
        broadcast: true,
        hash: sig,
        statusUrl: `https://api.swapchan.com/onchain/tx-status?chainId=${SOLANA}&hash=${sig}`,
        explorer: `https://solscan.io/tx/${sig}`,
        verify: v,
      };
    } catch (e) {
      return {
        broadcast: false,
        reason: `node rejected: ${(e as Error).message.slice(0, 300)}`,
        verify: v,
      };
    }
  }
  if (chainId === TRON) {
    const t = (typeof b.tx === "string" ? JSON.parse(b.tx) : b.tx) as TronTx;
    const v = verifyTron(t);
    const stop = blocked(v);
    if (stop) return stop;
    const r = await json<{ result?: boolean; txid?: string; code?: string; message?: string }>(
      f,
      "https://api.trongrid.io/wallet/broadcasttransaction",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(t),
      },
    );
    if (!r.result)
      return {
        broadcast: false,
        reason:
          `node rejected: ${r.code ?? ""} ${r.message ? Buffer.from(r.message, "hex").toString() : ""}`.trim(),
        verify: v,
      };
    return {
      broadcast: true,
      hash: r.txid ?? t.txID,
      explorer: `https://tronscan.org/#/transaction/${r.txid ?? t.txID}`,
      verify: v,
    };
  }
  if (chainId === BITCOIN) {
    const raw = String(b.tx);
    if (!isHex(raw)) throw new BadRequest("bitcoin tx must be raw hex");
    if (/^70736274ff/i.test(raw))
      throw new BadRequest("that is a PSBT; finalize it in your wallet and send the raw tx hex");
    if (b.strict)
      return {
        broadcast: false,
        reason:
          "strict: verify_tx cannot decode Bitcoin transactions, so strict mode refuses; send without strict to relay it unchanged",
      };
    const r = await f("https://mempool.space/api/tx", {
      method: "POST",
      body: raw,
      signal: AbortSignal.timeout(15_000),
    });
    const text = (await r.text()).trim();
    if (!r.ok) return { broadcast: false, reason: `node rejected: ${text.slice(0, 300)}` };
    return {
      broadcast: true,
      hash: text,
      explorer: `https://mempool.space/tx/${text}`,
      note: "Bitcoin txs are relayed as-is; no decoding.",
    };
  }
  const raw = String(b.tx) as TransactionSerialized;
  if (!raw.startsWith("0x") || !isHex(raw))
    throw new BadRequest("EVM tx must be signed raw hex (0x…)");
  let p: ReturnType<typeof parseTransaction>;
  try {
    p = parseTransaction(raw);
  } catch (e) {
    throw new BadRequest(`not a valid signed EVM tx: ${(e as Error).message.split("\n")[0]}`);
  }
  if (p.chainId !== undefined && p.chainId !== chainId)
    throw new BadRequest(`signed for chain ${p.chainId}, not ${chainId}`);
  if (!p.r || !p.s) throw new BadRequest("tx is not signed");
  const from = await recoverTransactionAddress({ serializedTransaction: raw as never });
  const hash = btKeccak256(raw);
  const v = p.to
    ? await verifyEvm(f, env, chainId, {
        from,
        to: p.to,
        data: p.data ?? "0x",
        value: (p.value ?? 0n).toString(),
        ...("authorizationList" in p && p.authorizationList
          ? { authorizationList: p.authorizationList as unknown[] }
          : {}),
      })
    : null;
  if (b.strict && v?.verdict === "danger")
    return {
      broadcast: false,
      reason: "strict: verify_tx verdict is danger",
      hash,
      from,
      verify: v,
    };
  const priv = !!b.private && chainId === 1;
  let sent: string;
  try {
    if (priv) {
      const r = await json<{ result?: string; error?: { message: string } }>(
        f,
        "https://rpc.flashbots.net/fast",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_sendRawTransaction",
            params: [raw],
          }),
        },
      );
      if (r.error || !r.result) throw new Error(r.error?.message ?? "no result");
      sent = r.result;
    } else sent = await evmClient(chainId, env).sendRawTransaction({ serializedTransaction: raw });
  } catch (e) {
    const err = e as Error & { details?: string };
    return {
      broadcast: false,
      reason: `node rejected: ${err.details || err.message.split("\n")[0]}`,
      hash,
      from,
      via: priv ? "Flashbots Protect" : "public RPC",
      verify: v,
    };
  }
  const ex = EXPLORER[chainId];
  return {
    broadcast: true,
    hash: sent,
    from,
    via: priv ? "Flashbots Protect (private)" : "public RPC",
    statusUrl: `https://api.swapchan.com/onchain/tx-status?chainId=${chainId}&hash=${sent}`,
    explorer: ex ? `${ex}/tx/${sent}` : null,
    verify: v,
  };
}

export async function txStatus(f: F, env: NodeJS.ProcessEnv, chainId: number, hash: string) {
  if (chainId === SOLANA) {
    const r = await solRpc<{ value: ({ confirmationStatus?: string; err: unknown } | null)[] }>(
      f,
      env,
      "getSignatureStatuses",
      [[hash], { searchTransactionHistory: true }],
    );
    const s = r.value[0];
    return {
      chainId,
      hash,
      status: !s ? "not-found" : s.err ? "failed" : (s.confirmationStatus ?? "pending"),
    };
  }
  if (chainId === BITCOIN) {
    const s = await json<{ confirmed: boolean; block_height?: number }>(
      f,
      `https://mempool.space/api/tx/${hash}/status`,
    ).catch(() => null);
    return {
      chainId,
      hash,
      status: !s ? "not-found" : s.confirmed ? "confirmed" : "pending",
      block: s?.block_height ?? null,
    };
  }
  if (chainId === TRON) {
    const s = await json<{ receipt?: { result?: string }; blockNumber?: number }>(
      f,
      "https://api.trongrid.io/wallet/gettransactioninfobyid",
      {
        method: "POST",
        body: JSON.stringify({ value: hash }),
      },
    ).catch(() => null);
    return {
      chainId,
      hash,
      status: !s?.blockNumber
        ? "pending-or-not-found"
        : s.receipt?.result && s.receipt.result !== "SUCCESS"
          ? "failed"
          : "confirmed",
      block: s?.blockNumber ?? null,
    };
  }
  const c = evmClient(chainId, env);
  const r = await c.getTransactionReceipt({ hash: hash as Hex }).catch(() => null);
  if (r)
    return {
      chainId,
      hash,
      status: r.status === "success" ? "confirmed" : "failed",
      block: Number(r.blockNumber),
      gasUsed: r.gasUsed.toString(),
    };
  const t = await c.getTransaction({ hash: hash as Hex }).catch(() => null);
  return { chainId, hash, status: t ? "pending" : "not-found" };
}

// ---------- signing_guide: always ships with the verification guide ----------
export const VERIFY_GUIDE = [
  {
    step: "Decode",
    do: "Decode the calldata against the contract's verified ABI (explorer #code). Unknown selector: stop and ask.",
  },
  {
    step: "Right contract",
    do: "The target must be the contract you expect: compare to an allowlist or the protocol's docs, check it is verified and not freshly deployed, and not a lookalike (same first/last characters, different middle = address poisoning).",
  },
  {
    step: "Right recipient",
    do: "Every recipient / receiver / to argument must be the user, or the person they named. Check for lookalikes.",
  },
  {
    step: "Right price",
    do: "Compare minOut to an independent quote (e.g. SwapChan get_quote). More than a few % below means slippage/sandwich risk.",
  },
  {
    step: "Simulate",
    do: "EVM: eth_simulateV1 with traceTransfers, or eth_call / a Tenderly-style simulator. Solana: simulateTransaction. Diff the user's balance changes: losing assets for nothing back means stop.",
  },
  {
    step: "Red flags",
    do: "Unlimited approve / increaseAllowance, permit and Permit2 signatures, setApprovalForAll(true), Safe DELEGATECALL, upgradeTo, transferOwnership / changeAdmin, EIP-7702 authorizations, unexpected native value. Solana: unknown programs, SetAuthority / Approve on token accounts, accounts not owned by the expected program. Tron: AccountPermissionUpdate, unlimited TRC-20 approve.",
  },
  {
    step: "Explain",
    do: "Write a plain-language summary (what it calls, what leaves, what arrives, the risks) and show it to the human.",
  },
  {
    step: "Human sign-off",
    do: "Get an explicit yes for THIS transaction, every time. Then the human's own wallet signs it.",
  },
];
export function signingGuide(
  chain: "evm" | "solana" | "tron" = "evm",
  situation: Situation | string = "full",
) {
  const keyRecovery = recoveryGuide(situation);
  return {
    principle: `Signing starts with 'do you have the key?'. Step 1 recover the key LOCALLY (never in chat). Step 2 verify_tx. Step 3 human signs EVERY tx in their own wallet. Step 4 broadcast_tx (relays already-signed txs on ${BROADCAST_COUNT} chains; any other chain is broadcast from the user's own wallet). SwapChan never holds keys or funds.`,
    steps: [
      {
        n: 1,
        name: "Key recovery (do you have the key?)",
        summary:
          "If the user cannot already sign, recover the key offline on their machine with blocktools. Only PUBLIC addresses leave the box. Full playbook is in `keyRecovery` below (pass situation= to get one branch). From a phrase, derive MANY addresses: 20 per path (50+ for heavy users) on every wallet path, plus passphrase candidates (keyRecovery.gapPolicy), and send them all, labeled, to find_money_batch.",
        tool: "recovery_guide / signing_guide",
      },
      {
        n: 2,
        name: "Verify",
        summary:
          "Run verify_tx on every unsigned tx. It returns a verdict, findings, a simulation and a plain-language summary.",
        tool: "verify_tx",
      },
      {
        n: 3,
        name: "Human sign-off and sign locally",
        summary:
          "Show the verify_tx summary. Get an explicit yes for THIS transaction. The human signs in their own wallet (hardware preferred). The agent does not hold the key.",
        tool: "user wallet",
      },
      {
        n: 4,
        name: "Broadcast",
        summary: `Optional relay of the already-signed bytes, unchanged. broadcast_tx can send to ${broadcastSummary()}. Any other chain: broadcast from the coin's own wallet. Private via Flashbots Protect on Ethereum. Cannot alter a signed tx.`,
        tool: "broadcast_tx then tx_status",
      },
    ],
    keyRecovery,
    verificationGuide: VERIFY_GUIDE,
    verifyTool:
      "Run verify_tx on every unsigned tx before showing it to the human. It returns a verdict, findings, a simulation and a plain-language summary.",
    loop: [
      "recovery_guide (if needed) -> PUBLIC addresses only (gap limit 20 per path, 50+ heavy users, all paths, passphrase candidates)",
      "find_money_batch with all of them (up to 500 labeled addresses per batch)",
      "find_money or get_quote: unsigned tx",
      "verify_tx: verdict + plain-language summary",
      "the human reviews the summary and signs in their own wallet",
      `broadcast_tx (optional; ${BROADCAST_COUNT} chains, others via the user's own wallet; private via Flashbots Protect on Ethereum): hash`,
      "tx_status: confirmed",
    ],
    custody: [
      {
        option:
          "The user's own wallet (MetaMask, Rabby, Phantom, TronLink) via WalletConnect or a deep link",
        recommended: true,
        note: "The human signs each tx. Best default.",
      },
      {
        option: "Hardware wallet (Ledger, Trezor)",
        recommended: true,
        note: "The human confirms each tx on the device.",
      },
      {
        option: "Embedded / MPC wallets (Turnkey, Privy, Lit, Coinbase CDP / AgentKit)",
        recommended: false,
        note: "Configure per-transaction human approval in their policy engine.",
      },
      {
        option: "Local encrypted keystore",
        recommended: false,
        note: "Developers only, unlocked by the human per tx. Never put a raw key in a prompt, a model-visible env, or logs.",
      },
    ],
    advanced: {
      warning:
        "Advanced, not recommended by default. Autonomous signing means a bug, prompt injection or poisoned data can move money with no human in the loop.",
      ifYouMust:
        "Use an ERC-4337 smart account or EIP-7702 session key scoped to specific contracts and selectors, small per-tx and daily caps, short expiry, exact-amount approvals revoked after use, and still run verify_tx before each send. Keep the main funds where the agent cannot reach them.",
    },
    snippet:
      chain === "solana"
        ? `const v = await mcp.call("verify_tx", { chainId: "solana", tx: base64UnsignedTx });\nif (!(await askHuman(v.summary, v.findings))) return; // explicit yes, every tx\nconst signed = await wallet.signTransaction(tx); // the human's wallet\nawait mcp.call("broadcast_tx", { chainId: "solana", tx: signed });`
        : chain === "tron"
          ? `const v = await mcp.call("verify_tx", { chainId: "tron", tx: unsignedTx });\nif (!(await askHuman(v.summary, v.findings))) return; // explicit yes, every tx\nconst signed = await tronLink.tronWeb.trx.sign(unsignedTx);\nawait mcp.call("broadcast_tx", { chainId: "tron", tx: signed });`
          : `const v = await mcp.call("verify_tx", { chainId: 1, tx: { from, to, data, value }, expected: { to: ROUTER, recipient: from } });\nif (v.verdict === "danger") return stop(v.summary);\nif (!(await askHuman(v.summary, v.findings))) return; // explicit yes, every tx\nawait walletClient.sendTransaction({ to, data, value }); // the human's wallet signs`,
    trust:
      "SwapChan never signs, never holds keys or funds, and cannot move money. Key recovery runs offline on the user's machine; only public addresses are sent here.",
    page: `${SITE}/agents/secure-signing`,
    recoverPages: {
      hub: `${SITE}/recover`,
      seedPhrase: `${SITE}/recover/seed-phrase`,
      keystore: `${SITE}/recover/keystore`,
      ethereumPresale: `${SITE}/recover/ethereum-presale-wallet-2015`,
    },
  };
}
