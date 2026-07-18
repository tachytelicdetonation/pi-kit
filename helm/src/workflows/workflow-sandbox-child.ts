import vm from "node:vm";

interface SandboxInit {
  type: "init";
  nonce: string;
  body: string;
  filename: string;
  args: unknown;
  cwd: string;
  compatibilityMode: boolean;
  initialPhase?: string;
  budgetTotal: number | null;
  budgetSpent: number;
}

interface BridgeResponse {
  type: "response";
  nonce: string;
  id: number;
  ok: boolean;
  value?: unknown;
  error?: {
    message: string;
    name?: string;
    code?: string;
    recoverable?: boolean;
    agentLabel?: string;
    resetHint?: string;
  };
  budgetSpent?: number;
}

const DETERMINISM_PRELUDE = [
  '"use strict";',
  'Math.random = () => { throw new Error("Math.random() is unavailable in a workflow (it breaks resume); pass randomness via args or vary by index"); };',
  "{",
  "  const RealDate = Date;",
  '  const fail = (w) => { throw new Error(w + " is unavailable in a workflow (it breaks resume); pass a timestamp via args"); };',
  "  const SafeDate = function (...a) {",
  '    if (!new.target) fail("Date()");',
  '    if (a.length === 0) fail("new Date()");',
  "    return Reflect.construct(RealDate, a, SafeDate);",
  "  };",
  "  SafeDate.UTC = RealDate.UTC;",
  "  SafeDate.parse = RealDate.parse;",
  '  SafeDate.now = () => fail("Date.now()");',
  "  SafeDate.prototype = RealDate.prototype;",
  "  globalThis.Date = SafeDate;",
  "}",
].join("\n");

let nextRequestId = 1;
let activeNonce: string | undefined;
let spent = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

process.on("message", (message: SandboxInit | BridgeResponse) => {
  if (message.type === "response") {
    if (!activeNonce || message.nonce !== activeNonce) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (typeof message.budgetSpent === "number") spent = Math.max(spent, message.budgetSpent);
    if (message.ok) request.resolve(message.value);
    else request.reject(remoteError(message.error));
    return;
  }
  if (message.type === "init" && !activeNonce) void execute(message);
});

async function execute(init: SandboxInit): Promise<void> {
  activeNonce = init.nonce;
  spent = init.budgetSpent;
  let currentPhase = init.initialPhase;

  const request = <T>(method: string, args: unknown[]): Promise<T> => {
    const id = nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      process.send?.({ type: "request", nonce: init.nonce, id, method, args });
    });
  };
  const notify = (method: string, args: unknown[]): void => {
    process.send?.({ type: "notification", nonce: init.nonce, method, args });
  };

  const agent = (prompt: string, options: Record<string, unknown> = {}) =>
    request("agent", [
      prompt,
      options.phase === undefined && currentPhase ? { ...options, phase: currentPhase } : options,
    ]);
  const parallel = async (thunks: Array<() => Promise<unknown>>) => {
    if (!Array.isArray(thunks) || thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
    }
    return Promise.all(
      thunks.map(async (thunk, index) => {
        try {
          return await thunk();
        } catch (error) {
          if (isNonRecoverable(error)) throw error;
          log(`parallel[${index}] failed: ${errorMessage(error)}`);
          return null;
        }
      }),
    );
  };
  const pipeline = async (
    items: unknown[],
    ...stages: Array<(previous: unknown, original: unknown, index: number) => unknown>
  ) => {
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (stages.some((stage) => typeof stage !== "function")) throw new TypeError("pipeline() stages must be functions");
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        try {
          for (const stage of stages) value = await stage(value, item, index);
          return value;
        } catch (error) {
          if (isNonRecoverable(error)) throw error;
          log(`pipeline[${index}] failed: ${errorMessage(error)}`);
          return null;
        }
      }),
    );
  };
  const phase = (title: string, options?: { budget?: number }) => {
    currentPhase = String(title);
    notify("phase", [currentPhase, options]);
  };
  const log = (message: unknown) => notify("log", [String(message)]);
  const workflow = (nameOrScript: string, childArgs?: unknown) => request("workflow", [nameOrScript, childArgs]);
  const checkpoint = (promptText: string, options?: unknown) => request("checkpoint", [promptText, options]);
  const budget = Object.freeze({
    total: init.budgetTotal,
    spent: () => spent,
    remaining: () => (init.budgetTotal == null ? Infinity : Math.max(0, init.budgetTotal - spent)),
  });

  // Run-global confidence signals, tallied here and shipped with the result so the
  // host can show whether the answer was cross-checked. Deterministic: on resume the
  // body re-executes over journaled agent results and re-tallies identically.
  const quality = {
    verify: { checks: 0, confirmed: 0, votes: 0 },
    judge: { panels: 0, candidates: 0, bestScore: 0 },
    completeness: { runs: 0, incomplete: 0, gaps: 0 },
  };

  const verify = async (
    item: unknown,
    options: { reviewers?: number; threshold?: number; lens?: string | string[] } = {},
  ) => {
    const reviewers = Math.max(1, options.reviewers ?? 2);
    const threshold = options.threshold ?? 0.5;
    const lenses = options.lens ? (Array.isArray(options.lens) ? options.lens : [options.lens]) : [];
    const claim = typeof item === "string" ? item : JSON.stringify(item);
    const schema = {
      type: "object",
      properties: { real: { type: "boolean" }, reason: { type: "string" } },
      required: ["real"],
    };
    const votes = (
      await parallel(
        Array.from(
          { length: reviewers },
          (_, index) => () =>
            agent(
              `Adversarially review whether the following is REAL/correct. Try to refute it; default to real=false if unsure.${lenses.length ? ` Focus lens: ${lenses[index % lenses.length]}.` : ""}\n\n${claim}`,
              { label: `verify ${index + 1}`, schema },
            ),
        ),
      )
    ).filter(Boolean) as Array<{ real?: boolean; reason?: string }>;
    const realCount = votes.filter((vote) => vote.real).length;
    const real = votes.length > 0 && realCount / votes.length >= threshold;
    quality.verify.checks++;
    quality.verify.votes += votes.length;
    if (real) quality.verify.confirmed++;
    return { real, realCount, total: votes.length, votes };
  };

  const judgePanel = async (attempts: unknown[], options: { judges?: number; rubric?: string } = {}) => {
    const judges = Math.max(1, options.judges ?? 3);
    const rubric = options.rubric ?? "overall quality and correctness";
    const schema = {
      type: "object",
      properties: { score: { type: "number" }, reason: { type: "string" } },
      required: ["score"],
    };
    const scored = (
      await parallel(
        attempts.map((attempt, attemptIndex) => async () => {
          const text = typeof attempt === "string" ? attempt : JSON.stringify(attempt);
          const judgments = (
            await parallel(
              Array.from(
                { length: judges },
                (_, judgeIndex) => () =>
                  agent(
                    `Score this candidate from 0 to 1 on: ${rubric}. Reply with the score.\n\nCandidate:\n${text}`,
                    {
                      label: `judge ${attemptIndex + 1}.${judgeIndex + 1}`,
                      schema,
                    },
                  ),
              ),
            )
          ).filter(Boolean) as Array<{ score?: number }>;
          const score = judgments.length
            ? judgments.reduce((sum, judgment) => sum + (Number(judgment.score) || 0), 0) / judgments.length
            : 0;
          return { index: attemptIndex, attempt, score, judgments };
        }),
      )
    ).filter(Boolean) as Array<{ index: number; attempt: unknown; score: number; judgments: unknown[] }>;
    let best = scored[0];
    for (const candidate of scored.slice(1)) {
      if (candidate.score > best.score || (candidate.score === best.score && candidate.index < best.index))
        best = candidate;
    }
    quality.judge.panels++;
    quality.judge.candidates += scored.length;
    if (best && typeof best.score === "number") quality.judge.bestScore = Math.max(quality.judge.bestScore, best.score);
    return best;
  };

  const loopUntilDry = async (options: {
    round: (roundIndex: number) => Promise<unknown[]> | unknown[];
    key?: (item: unknown) => string;
    consecutiveEmpty?: number;
    maxRounds?: number;
  }) => {
    if (!options || typeof options.round !== "function") throw new TypeError("loopUntilDry requires { round }");
    const key = options.key ?? ((value: unknown) => JSON.stringify(value));
    const seen = new Set<string>();
    const all: unknown[] = [];
    const requiredDry = Math.max(1, options.consecutiveEmpty ?? 2);
    let dry = 0;
    for (let round = 0; round < (options.maxRounds ?? 50) && dry < requiredDry; round++) {
      let items: unknown[];
      try {
        items = (await options.round(round)) ?? [];
      } catch (error) {
        const code = (error as { code?: string } | undefined)?.code;
        if (code === "TOKEN_BUDGET_EXHAUSTED" || code === "AGENT_LIMIT_EXCEEDED") break;
        throw error;
      }
      const fresh = items.filter((value) => value != null && !seen.has(key(value)));
      if (!fresh.length) {
        dry++;
        continue;
      }
      dry = 0;
      for (const value of fresh) {
        seen.add(key(value));
        all.push(value);
      }
    }
    return all;
  };
  const completenessCheck = async (taskArgs: unknown, results: unknown) => {
    const result = (await agent(
      `Given the task and the results gathered so far, list what is still MISSING (modalities not covered, claims unverified, gaps). Be specific and concise.\n\nTask:\n${JSON.stringify(taskArgs)}\n\nResults so far:\n${JSON.stringify(results).slice(0, 4000)}`,
      {
        label: "completeness critic",
        schema: {
          type: "object",
          properties: { complete: { type: "boolean" }, missing: { type: "array", items: { type: "string" } } },
          required: ["complete"],
        },
      },
    )) as { complete?: boolean; missing?: unknown[] } | null;
    quality.completeness.runs++;
    if (result && result.complete === false) {
      quality.completeness.incomplete++;
      quality.completeness.gaps += Array.isArray(result.missing) ? result.missing.length : 0;
    }
    return result;
  };
  const retry = async (
    thunk: (attempt: number) => Promise<unknown> | unknown,
    options: { attempts?: number; until?: (result: unknown) => boolean } = {},
  ) => {
    let last: unknown;
    for (let attempt = 0; attempt < Math.max(1, options.attempts ?? 3); attempt++) {
      last = await thunk(attempt);
      if (!options.until || options.until(last)) return last;
    }
    return last;
  };
  const gate = async (
    thunk: (feedback: string | undefined, attempt: number) => Promise<unknown> | unknown,
    validator: (result: unknown) => Promise<{ ok: boolean; feedback?: string }> | { ok: boolean; feedback?: string },
    options: { attempts?: number } = {},
  ) => {
    const attempts = Math.max(1, options.attempts ?? 3);
    let feedback: string | undefined;
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      last = await thunk(feedback, attempt);
      const verdict = await validator(last);
      if (verdict?.ok) return { ok: true, value: last, attempts: attempt + 1 };
      feedback = verdict?.feedback;
    }
    return { ok: false, value: last, attempts };
  };

  const consoleBridge = Object.freeze({
    log: (...values: unknown[]) => log(values.map(String).join(" ")),
    info: (...values: unknown[]) => log(values.map(String).join(" ")),
    warn: (...values: unknown[]) => log(`[warn] ${values.map(String).join(" ")}`),
    error: (...values: unknown[]) => log(`[error] ${values.map(String).join(" ")}`),
  });
  const piExtensions = Object.freeze({
    workflow,
    verify,
    judgePanel,
    loopUntilDry,
    completenessCheck,
    retry,
    gate,
    checkpoint,
    log,
    budget,
    cwd: init.cwd,
    console: consoleBridge,
  });
  const compatibleGlobals: Record<string, unknown> = {
    agent,
    parallel,
    pipeline,
    phase,
    args: init.args,
    pi: piExtensions,
  };
  if (!init.compatibilityMode) {
    Object.assign(compatibleGlobals, {
      workflow,
      verify,
      judgePanel,
      loopUntilDry,
      completenessCheck,
      retry,
      gate,
      checkpoint,
      log,
      cwd: init.cwd,
      process: Object.freeze({ cwd: () => init.cwd }),
      budget,
      console: consoleBridge,
    });
  }
  const context = vm.createContext(compatibleGlobals, { codeGeneration: { strings: false, wasm: false } });

  try {
    const wrapped = `${DETERMINISM_PRELUDE}\n(async () => {\n${init.body}\n})()`;
    const result = await new vm.Script(wrapped, { filename: init.filename }).runInContext(context);
    process.send?.({ type: "result", nonce: init.nonce, ok: true, value: result, quality });
  } catch (error) {
    process.send?.({ type: "result", nonce: init.nonce, ok: false, error: serializeError(error) });
  } finally {
    for (const request of pending.values()) request.reject(new Error("Workflow sandbox stopped"));
    pending.clear();
  }
}

function isNonRecoverable(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { recoverable?: boolean }).recoverable === false);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function remoteError(value: BridgeResponse["error"]): Error {
  const error = new Error(value?.message ?? "Workflow bridge request failed");
  error.name = value?.name ?? "Error";
  Object.assign(error, {
    code: value?.code,
    recoverable: value?.recoverable,
    agentLabel: value?.agentLabel,
    resetHint: value?.resetHint,
  });
  return error;
}

function serializeError(error: unknown): {
  message: string;
  name?: string;
  code?: string;
  recoverable?: boolean;
  agentLabel?: string;
  resetHint?: string;
} {
  if (!(error instanceof Error)) return { message: String(error) };
  const value = error as Error & { code?: string; recoverable?: boolean; agentLabel?: string; resetHint?: string };
  return {
    message: value.message,
    name: value.name,
    code: value.code,
    recoverable: value.recoverable,
    agentLabel: value.agentLabel,
    resetHint: value.resetHint,
  };
}
