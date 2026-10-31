/**
 * find_money for many wallets at once: paste a list of public addresses (any chains, ENS/.sol/Basenames,
 * mixed), get a job id, poll progress, and finish with an aggregated total, a ranked list across all
 * wallets, a summary the agent can relay verbatim and one "recover and swap all" plan.
 * Read-only: it only calls findMoney per address. Never accepts or stores secrets.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BadRequest } from "./onchain.js";

type Money = Record<string, unknown> & {
  address?: string;
  name?: string;
  totalEstUsd?: number;
  atRiskUsd?: number;
  portfolioUsd?: number | null;
  items?: Item[];
  swapAll?: { url?: string; shortUrl?: string };
  errors?: string[];
};
type Item = Record<string, unknown> & {
  title: string;
  estUsd: number | null;
  estimateKind: string;
  category: string;
  action?: string;
  swapUrl?: string;
  shortUrl?: string;
  steps?: { label?: string; url?: string; shortUrl?: string; kind?: string }[];
};
export type FindOne = (input: string) => Promise<Money>;
type Status = "queued" | "running" | "done";
interface Job {
  id: string;
  createdAt: number;
  status: Status;
  inputs: { input: string; kind: string; label?: string }[];
  results: Record<
    string,
    { status: "pending" | "running" | "done" | "error"; result?: Money; error?: string }
  >;
}
const JOBS = new Map<string, Job>();
const TTL = 6 * 3600_000;
const MAX = 500;

const SECRET_HINT =
  /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b|^(?:0x)?[0-9a-f]{64}$|^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$|^xprv/i;

/** Classify one token. Returns null for junk. EVM addresses are scanned on every EVM chain by find_money. */
export function classify(s: string): string | null {
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return "evm (all EVM chains)";
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(s)) return "tron";
  if (/^(bc1[0-9a-z]{25,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(s)) return "bitcoin";
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.(eth|sol)$/i.test(s))
    return s.toLowerCase().endsWith(".sol") ? "sns (solana)" : "ens/basename (all EVM chains)";
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return "solana";
  return null;
}

type AddrIn = string | { address: string; label?: string | undefined };

/**
 * Accepts pasted text, a list of strings, or a list of {address, label}. In text, any non-address words on
 * the same line as exactly one address become that address's label ("MetaMask #3: 0xabc…", "0xabc… ledger m/44'/60'/2'/0/0").
 */
export function parseAddresses(input: string | AddrIn[]) {
  const objs = Array.isArray(input) ? input.filter((x) => typeof x === "object") : [];
  const raw = Array.isArray(input)
    ? input.filter((x): x is string => typeof x === "string").join("\n")
    : input;
  const checkText = Array.isArray(input)
    ? input.map((x) => (typeof x === "string" ? x : x.address)).join("\n")
    : input;
  if (SECRET_HINT.test(checkText.trim()))
    throw new BadRequest(
      "That looks like a recovery phrase or private key. Never paste those anywhere: SwapChan only needs PUBLIC addresses. Derive addresses locally with recovery_guide.",
    );
  const seen = new Set<string>();
  const out: { input: string; kind: string; label?: string }[] = [];
  const ignored: string[] = [];
  const clean = (x: string) => x.trim().replace(/^["'`(<]+|["'`)>.,;:]+$/g, "");
  const add = (t: string, k: string, label?: string) => {
    const key = k.startsWith("evm") ? t.toLowerCase() : t;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ input: t, kind: k, ...(label ? { label: label.slice(0, 80) } : {}) });
  };
  for (const o of objs) {
    const t = clean(o.address);
    const k = classify(t);
    if (k) add(t, k, o.label?.trim() || undefined);
    else ignored.push(o.address);
  }
  for (const line of raw.split(/\r?\n/)) {
    const toks = line
      .split(/[\s,;|\t]+/)
      .map(clean)
      .filter(Boolean);
    const hits = toks.map((t) => [t, classify(t)] as const).filter(([, k]) => k);
    if (hits.length === 1) {
      const label = line
        .replace(hits[0]![0], " ")
        .replace(/[\s,;|:=\-–—]+/g, " ")
        .trim();
      add(hits[0]![0], hits[0]![1]!, label || undefined);
    } else
      for (const t of toks) {
        const k = classify(t);
        if (k) add(t, k);
        else ignored.push(t);
      }
  }
  if (!out.length)
    throw new BadRequest(
      "no public addresses found (EVM 0x…, ENS/.base.eth, .sol, Solana, Tron T…, Bitcoin)",
    );
  if (out.length > MAX) throw new BadRequest(`max ${MAX} addresses per batch`);
  return { addresses: out, ignored };
}

// ---- durable job store ($SWAPCHAN_DATA_DIR/batches.db). Jobs survive restarts; unfinished ones resume. ----
let DB: DatabaseSync | null = null;
function save(job: Job) {
  DB?.prepare(
    "INSERT OR REPLACE INTO batches (id, created_at, status, inputs, results) VALUES (?, ?, ?, ?, ?)",
  ).run(job.id, job.createdAt, job.status, JSON.stringify(job.inputs), JSON.stringify(job.results));
}
/** Open the store, load jobs younger than TTL and resume any that were interrupted. */
export function initBatchStore(file: string | null, find: FindOne) {
  if (!file) return 0;
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  DB = new DatabaseSync(file);
  DB.exec(`CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
    status TEXT NOT NULL, inputs TEXT NOT NULL, results TEXT NOT NULL)`);
  DB.prepare("DELETE FROM batches WHERE created_at < ?").run(Date.now() - TTL);
  let resumed = 0;
  for (const r of DB.prepare("SELECT * FROM batches").all() as Record<string, string | number>[]) {
    const job: Job = {
      id: String(r.id),
      createdAt: Number(r.created_at),
      status: r.status as Status,
      inputs: JSON.parse(String(r.inputs)),
      results: JSON.parse(String(r.results)),
    };
    JOBS.set(job.id, job);
    if (job.status !== "done") {
      for (const v of Object.values(job.results)) if (v.status === "running") v.status = "pending";
      run(find, job);
      resumed++;
    }
  }
  return resumed;
}

function gc() {
  const now = Date.now();
  for (const [k, j] of JOBS) if (now - j.createdAt > TTL) JOBS.delete(k);
  DB?.prepare("DELETE FROM batches WHERE created_at < ?").run(now - TTL);
}

function run(find: FindOne, job: Job, concurrency = 4) {
  job.status = "running";
  save(job);
  const queue = job.inputs.filter((a) => job.results[a.input]?.status === "pending");
  const worker = async () => {
    for (let a = queue.shift(); a; a = queue.shift()) {
      const slot = job.results[a.input]!;
      slot.status = "running";
      try {
        slot.result = await find(a.input);
        slot.status = "done";
      } catch (e) {
        slot.status = "error";
        slot.error = (e as Error).message.slice(0, 200);
      }
      save(job);
    }
  };
  void Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker),
  ).then(() => {
    job.status = "done";
    save(job);
  });
}

export function startBatch(find: FindOne, input: string | AddrIn[], concurrency = 4) {
  gc();
  const { addresses, ignored } = parseAddresses(input);
  const job: Job = {
    id: randomUUID(),
    createdAt: Date.now(),
    status: "running",
    inputs: addresses,
    results: Object.fromEntries(addresses.map((a) => [a.input, { status: "pending" as const }])),
  };
  JOBS.set(job.id, job);
  run(find, job, concurrency);
  return { ignored, ...view(job) };
}

export class BatchRateLimited extends Error {}

/**
 * Per-client address budget for POST /money/batch: at most `maxAddrs` addresses per `windowMs` from one client key
 * (fixed window). A batch that would exceed the budget is refused whole and charges nothing.
 */
export function batchIpLimiter(maxAddrs = 500, windowMs = 3600_000, now: () => number = Date.now) {
  const windows = new Map<string, { start: number; used: number }>();
  return (
    who: string,
    n: number,
  ): { ok: true } | { ok: false; retryAfter: number; max: number } => {
    const t = now();
    for (const [k, v] of windows) if (t - v.start >= windowMs) windows.delete(k);
    const w = windows.get(who) ?? { start: t, used: 0 };
    if (w.used + n > maxAddrs)
      return { ok: false, retryAfter: Math.ceil((w.start + windowMs - t) / 1000), max: maxAddrs };
    w.used += n;
    windows.set(who, w);
    return { ok: true };
  };
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const r2 = (n: number) => Math.round(n * 100) / 100;

export function view(job: Job) {
  const seen = new Map<string, string>();
  const entries = job.inputs.map((a) => {
    const e = { ...a, ...job.results[a.input]! } as typeof a &
      Job["results"][string] & { duplicateOf?: string };
    const key = e.result?.address?.toLowerCase();
    if (key) {
      const first = seen.get(key);
      if (first) e.duplicateOf = first;
      else seen.set(key, a.input);
    }
    return e;
  });
  const unique = entries.filter((e) => !e.duplicateOf);
  const done = entries.filter((e) => e.status === "done" || e.status === "error").length;
  const progress = {
    done,
    total: entries.length,
    percent: Math.round((done / entries.length) * 100),
  };
  const wallets = entries.map((e) => ({
    input: e.input,
    ...(e.label ? { label: e.label } : {}),
    kind: e.kind,
    status: e.status,
    ...(e.result
      ? {
          address: e.result.address,
          totalEstUsd: e.result.totalEstUsd ?? 0,
          atRiskUsd: e.result.atRiskUsd ?? 0,
          opportunities: e.result.items?.length ?? 0,
          ...(Array.isArray(e.result.owedNotClaimableNow) && e.result.owedNotClaimableNow.length
            ? { owedNotClaimableNow: e.result.owedNotClaimableNow }
            : {}),
          ...(e.result.swapAll ? { swapAll: e.result.swapAll } : {}),
        }
      : {}),
    ...(e.error ? { error: e.error } : {}),
    ...(e.duplicateOf
      ? { duplicateOf: e.duplicateOf, note: "same wallet as another input; counted once" }
      : {}),
  }));
  const items = unique
    .flatMap((e) =>
      (e.result?.items ?? []).map((i) => ({
        wallet: e.result?.name ?? e.result?.address ?? e.input,
        ...(e.label ? { walletLabel: e.label } : {}),
        ...i,
      })),
    )
    .sort((a, b) => (b.estUsd ?? 0) - (a.estUsd ?? 0))
    .map((i, n) => ({ ...i, rank: n + 1 }));
  const money = items.filter((i) => i.estimateKind !== "protected");
  const totalEstUsd = r2(money.reduce((s, i) => s + (i.estUsd ?? 0), 0));
  const atRiskUsd = r2(
    items.filter((i) => i.estimateKind === "protected").reduce((s, i) => s + (i.estUsd ?? 0), 0),
  );
  const exact = r2(
    money.filter((i) => i.estimateKind === "exact").reduce((s, i) => s + (i.estUsd ?? 0), 0),
  );
  const finished = job.status === "done";
  const link = (u?: string, s?: string) =>
    [s ? `short: ${s}` : null, u ? `full: ${u}` : null].filter(Boolean).join(" | ");
  const plan = {
    title: "Recover and swap all",
    rules:
      "Before EVERY signature: verify_tx on the exact unsigned tx, show the human the plain-English summary, get an explicit yes for THAT tx, sign in their own wallet, broadcast_tx, tx_status. Never batch approvals the human has not seen.",
    phase1_recover: money
      .filter((i) => i.steps?.[0]?.kind === "recover")
      .map((i) => ({ wallet: i.wallet, title: i.title, estUsd: i.estUsd, step: i.steps![0] })),
    phase2_protect: items
      .filter((i) => i.estimateKind === "protected")
      .map((i) => ({
        wallet: i.wallet,
        title: i.title,
        estUsd: i.estUsd,
        action: i.action,
        url: i.shortUrl ?? i.swapUrl,
      })),
    phase3_swap: wallets
      .filter((w) => w.swapAll && !w.duplicateOf)
      .map((w) => ({ wallet: w.address ?? w.input, ...w.swapAll })),
  };
  const lines = [
    finished
      ? `I scanned ${unique.length} wallet${unique.length > 1 ? "s" : ""} and found ${usd(exact)} exact, on-chain${totalEstUsd > exact ? ` plus about ${usd(r2(totalEstUsd - exact))} in estimates (yields/savings, not money sitting there)` : ""}${atRiskUsd ? `, plus ${usd(atRiskUsd)} exposed to risky approvals/tokens to protect` : ""}.`
      : `Scanning ${progress.done}/${progress.total} wallets so far: about ${usd(totalEstUsd)} found.`,
    ...money
      .slice(0, 10)
      .map(
        (i) =>
          `${i.rank}. ${i.title} — ${i.estUsd == null ? "?" : usd(i.estUsd)} (${i.estimateKind}) on ${i.wallet}. ${link(i.steps?.[0]?.url ?? i.swapUrl, i.steps?.[0]?.shortUrl ?? i.shortUrl)}`,
      ),
    money.length > 10 ? `…and ${money.length - 10} more.` : "",
    plan.phase3_swap.length
      ? `Swap everything to USDC afterwards: ${plan.phase3_swap.map((s) => link(s.url, s.shortUrl)).join(" ; ")}`
      : "",
    ...wallets.flatMap((w) =>
      (
        (w as { owedNotClaimableNow?: { protocol: string; owed: string | null; reason: string }[] })
          .owedNotClaimableNow ?? []
      ).map(
        (l) =>
          `Owed but not claimable now on ${w.address ?? w.input}: ${l.protocol}${l.owed ? ` ${l.owed}` : ""} (${l.reason}). Not counted above.`,
      ),
    ),
    "Nothing moves without you: I'll verify each transaction and show you exactly what it does before your own wallet signs it. SwapChan never holds keys.",
  ].filter(Boolean);
  return {
    jobId: job.id,
    status: job.status,
    progress,
    ...(finished ? {} : { pollAfterSeconds: 15, poll: "call find_money_status with jobId" }),
    totalEstUsd,
    exactUsd: exact,
    atRiskUsd,
    wallets,
    items,
    plan,
    summary: lines.join("\n"),
    summaryHint: "Relay `summary` to the user verbatim; it contains both short and full links.",
  };
}

export function batchStatus(id: string) {
  const j = JOBS.get(id);
  if (!j) throw new BadRequest("unknown or expired jobId (jobs live 6h and survive restarts)");
  return view(j);
}
