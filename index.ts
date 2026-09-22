/**
 * ModelTrace — raw-API model attribution for Pi.
 *
 * Three modes, same challenges, same scoring, one difference:
 *
 *   raw    (default)  the model receives ONLY the numeric challenge
 *   --pi              the model additionally receives Pi's full system prompt
 *   --both            runs raw and --pi over the SAME challenges and reports the delta
 *
 * The delta is the point. The bundled ModelTrace bank was collected over bare API
 * calls, so a harness system prompt shifts the output distribution away from every
 * stored centroid and can misattribute a model that is right in front of you.
 *
 * For the "probe inside a real Pi session" case there is
 * npm:@indexyz/pi-model-trace (`/model-trace`), which spawns `pi -p` children.
 * This package deliberately does not: `ctx.modelRegistry.streamSimple()` takes a
 * context we build ourselves, so we control the system prompt exactly.
 *
 * Ported algorithm, challenge generator and fingerprint bank:
 * https://github.com/xqy2006/ModelTrace (MIT, Copyright (c) 2026 xqy2006).
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { generateChallenges, type Challenge } from "./challenges.ts";
import { analyzeGlobalOutputs, type AnalysisResult, type FingerprintBank } from "./fingerprint.ts";

const BANK_URL = new URL("./data/unified_bank.json", import.meta.url);
const MESSAGE_TYPE = "model-trace-api";
const PROBE_COUNT = 3;
/** ~300 integers per answer; 4096 leaves room for markup and a short preamble. */
const MAX_TOKENS = 4096;
/**
 * Hard deadline per probe. Without it a stalled endpoint hangs the TUI forever,
 * and the command handler has no other way out: `ctx.signal` is documented as
 * usually undefined in extension commands, so Esc is not reliably available.
 */
const PROBE_TIMEOUT_MINUTES = 5;
const PROBE_TIMEOUT_MS = PROBE_TIMEOUT_MINUTES * 60 * 1000;
/**
 * Bound on waiting for an idle session. Short on purpose: this is best-effort
 * deconfliction, so waiting past a minute buys nothing and an unbounded wait
 * here would permanently lock the command out via the `running` guard.
 */
const WAIT_IDLE_TIMEOUT_MS = 60 * 1000;

type ProbeModel = NonNullable<ExtensionCommandContext["model"]>;
type Mode = "raw" | "pi" | "both";

let bankPromise: Promise<FingerprintBank> | undefined;
function loadBank(): Promise<FingerprintBank> {
  bankPromise ??= readFile(fileURLToPath(BANK_URL), "utf8").then(
    (raw) => JSON.parse(raw) as FingerprintBank,
  );
  return bankPromise;
}

/**
 * Bound the wait at OUR layer, not the provider's.
 *
 * Passing `signal` is only best-effort: a provider may ignore the abort, and a
 * provider that aborts the socket without ending the event stream leaves
 * `for await` pending forever. That wedges the whole TUI, since the command
 * handler has no other way out (`ctx.signal` is undefined in extension
 * commands, so Esc cannot help). Racing a plain timer is the only guarantee.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, what = "请求"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    const span = ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.max(1, Math.round(ms / 1000))} 秒`;
    timer = setTimeout(() => reject(new Error(`${what}超过 ${span}未返回，已放弃`)), ms);
  });
  // Promise.race subscribes to both, so the orphaned request cannot surface as
  // an unhandled rejection when it eventually settles.
  return Promise.race([work, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * One challenge, one request. `systemPrompt` is the ONLY difference between raw
 * mode and --pi mode, which is what makes the comparison meaningful.
 */
async function probe(
  ctx: ExtensionCommandContext,
  model: ProbeModel,
  challenge: Challenge,
  systemPrompt: string | undefined,
): Promise<string> {
  const timestamp = Date.now();
  const messages = [
    ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt, timestamp }] : []),
    { role: "user" as const, content: challenge.prompt, timestamp },
  ];

  const deadline = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline;

  const collect = async (): Promise<string> => {
    // No `as never` here on purpose: let tsc check the shape against the real
    // TranscriptContext signature, so a provider-layer change breaks the build
    // instead of silently sending a malformed payload.
    const stream = ctx.modelRegistry.streamSimple(model, { messages }, {
      maxTokens: MAX_TOKENS,
      signal,
    });

    let text = "";
    for await (const event of stream) {
      if (event.type === "text_delta") text += event.delta;
      else if (event.type === "error") {
        throw new Error(event.error?.errorMessage ?? "provider error");
      }
    }
    if (!text.trim()) {
      const final = await stream.result();
      text = final.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
    }
    return text.trim();
  };

  return withDeadline(collect(), PROBE_TIMEOUT_MS, "探针 ");
}

interface RunResult {
  mode: Mode;
  analysis?: AnalysisResult;
  counts: number[];
  expected: number[];
  failure?: string;
}

/** Run every challenge once; a single transport failure does not sink the run. */
async function runMode(
  ctx: ExtensionCommandContext,
  model: ProbeModel,
  challenges: Challenge[],
  mode: Mode,
  onProbeDone?: () => void,
): Promise<RunResult> {
  const systemPrompt = mode === "raw" ? undefined : ctx.getSystemPrompt();
  const outputs: string[] = [];
  let failure: string | undefined;

  const settled = await Promise.allSettled(
    challenges.map(async (challenge) => {
      try {
        return await probe(ctx, model, challenge, systemPrompt);
      } finally {
        // fires on success and failure alike, so the counter never stalls
        onProbeDone?.();
      }
    }),
  );
  for (const [index, item] of settled.entries()) {
    if (item.status === "fulfilled") outputs.push(item.value);
    else failure ??= `${challenges[index].id}: ${item.reason?.message ?? item.reason}`;
  }

  const counts = settled.map((item) => (item.status === "fulfilled" ? item.value.length : 0));
  const expected = challenges.map((challenge) => challenge.expected_count);
  if (!outputs.length) return { mode, counts, expected, failure };

  try {
    const analysis = analyzeGlobalOutputs(
      outputs.map((text, index) => ({ text, expected_count: expected[index] })),
      await loadBank(),
    );
    return { mode, analysis, counts, expected, failure };
  } catch (error) {
    return { mode, counts, expected, failure: error instanceof Error ? error.message : String(error) };
  }
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function modeLabel(mode: Mode): string {
  return mode === "raw" ? "裸 API（无系统提示词）" : "带 Pi 系统提示词";
}

function formatHeadline(result: RunResult): string {
  const analysis = result.analysis;
  if (!analysis) return `失败: ${result.failure ?? "无可用回答"}`;
  return `**${analysis.prediction_name}** (${percent(analysis.probability)}) · 家族 **${analysis.family_prediction_name}** (${percent(analysis.family_probability)})`;
}

export function formatSingle(result: RunResult, label: string): string[] {
  const lines: string[] = [];
  lines.push(`**归因结果**: ${formatHeadline(result)}`);
  const analysis = result.analysis;
  if (!analysis) {
    lines.push("");
    lines.push(`> ${result.failure}`);
    return lines;
  }
  lines.push("");
  lines.push("### 家族概率");
  for (const family of analysis.family_probabilities) {
    lines.push(`- ${family.display_name}: ${percent(family.probability)}`);
  }
  lines.push("");
  lines.push(`### 候选模型 Top ${Math.min(6, analysis.results.length)}`);
  for (const item of analysis.results.slice(0, 6)) {
    lines.push(
      `- ${item.display_name}: ${percent(item.probability)} (家族内 ${percent(item.conditional_probability)}, 分布相似度 ${item.profile_similarity.toFixed(3)})`,
    );
  }
  lines.push("");
  lines.push("### 探针");
  for (const [index, diagnostic] of analysis.diagnostics.entries()) {
    const status = diagnostic.accepted
      ? `${diagnostic.parsed_numbers} 个数字 (要求 ≥${diagnostic.minimum_numbers})`
      : `无效: 仅 ${diagnostic.parsed_numbers} 个数字 (要求 ≥${diagnostic.minimum_numbers})`;
    lines.push(`- probe #${index + 1}: ${status}`);
  }
  if (result.failure) lines.push(`- 传输失败: ${result.failure}`);
  lines.push("");
  lines.push(
    `有效回答 ${analysis.used_outputs}/${result.expected.length} · 校准 β=${analysis.calibration.beta.toFixed(2)} (CV 准确率 ${percent(analysis.calibration.cv_accuracy)})`,
  );
  void label;
  return lines;
}

/** The whole reason this package exists: how far did Pi's prompt move the answer? */
export function formatComparison(raw: RunResult, pi: RunResult): string[] {
  const lines: string[] = [];
  lines.push("### 模式对比");
  lines.push("");
  lines.push("| | 裸 API | 带 Pi 提示词 |");
  lines.push("|---|---|---|");
  lines.push(`| 首位模型 | ${formatHeadline(raw)} | ${formatHeadline(pi)} |`);

  const top = (result: RunResult) => result.analysis?.results ?? [];
  const modelNames = new Set(
    [...top(raw), ...top(pi)].slice(0, 5).map((item) => item.display_name),
  );
  for (const name of modelNames) {
    const find = (result: RunResult) =>
      top(result).find((item) => item.display_name === name)?.probability;
    const rawValue = find(raw);
    const piValue = find(pi);
    lines.push(
      `| ${name} | ${rawValue === undefined ? "—" : percent(rawValue)} | ${piValue === undefined ? "—" : percent(piValue)} |`,
    );
  }
  lines.push("");

  const rawTop = raw.analysis?.prediction_name;
  const piTop = pi.analysis?.prediction_name;
  if (!rawTop || !piTop) {
    lines.push("> 有一侧没有拿到有效回答，无法比较。");
  } else if (rawTop === piTop) {
    lines.push(`**结论**: 两种模式都判为 \`${rawTop}\` —— Pi 的提示词没有改变判定。`);
  } else {
    lines.push(
      `**结论**: ⚠️ 判定不一致。同一组题、同一个模型，只因加了 Pi 的系统提示词就从 \`${rawTop}\` 变成了 \`${piTop}\`。` +
        "以裸 API 的结果为准 —— 指纹库是裸调用采出来的。",
    );
  }
  return lines;
}

function resolveTarget(
  query: string,
  ctx: ExtensionCommandContext,
): { model: ProbeModel; label: string } | { error: string } {
  const trimmed = query.trim();
  if (!trimmed) {
    if (!ctx.model) return { error: "没有选中模型。用法: /model-trace-api [provider/model] [--pi|--both]" };
    return { model: ctx.model, label: `${ctx.model.provider}/${ctx.model.id}` };
  }
  let match = trimmed.includes("/")
    ? ctx.modelRegistry.find(trimmed.slice(0, trimmed.indexOf("/")), trimmed.slice(trimmed.indexOf("/") + 1))
    : undefined;
  if (!match) {
    const candidates = ctx.modelRegistry.getAvailable().filter((model) => model.id === trimmed);
    if (candidates.length === 1) match = candidates[0];
    if (candidates.length > 1) {
      return {
        error: `模型名 "${trimmed}" 有歧义: ${candidates.map((m) => `${m.provider}/${m.id}`).join(", ")}`,
      };
    }
  }
  if (!match) return { error: `未知模型 "${trimmed}"。用法: /model-trace-api [provider/model] [--pi|--both]` };
  return { model: match, label: `${match.provider}/${match.id}` };
}

export function parseArgs(input: string): { mode?: Mode; query: string } | { error: string } {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  let mode: Mode | undefined;
  const rest: string[] = [];
  for (const token of tokens) {
    if (token === "--pi") mode = "pi";
    else if (token === "--both") mode = "both";
    else if (token === "--raw") mode = "raw";
    else if (token.startsWith("--")) return { error: `未知参数 ${token}。支持 --raw / --pi / --both` };
    else rest.push(token);
  }
  return { ...(mode ? { mode } : {}), query: rest.join(" ") };
}

const MODE_OPTIONS: Array<{ label: string; mode: Mode }> = [
  { label: "裸 API — 不带系统提示词（与指纹库采集环境一致）", mode: "raw" },
  { label: "带 Pi 系统提示词", mode: "pi" },
  { label: "两种都跑，对比偏移", mode: "both" },
];

/**
 * Build the model picker list: the current session model pinned first, then the
 * session's scoped models (what `/model` shows), falling back to the whole
 * catalogue when no scoping is configured.
 */
export function buildModelOptions(
  current: string | undefined,
  scoped: readonly string[],
  available: readonly string[],
): string[] {
  const options: string[] = [];
  if (current) options.push(`${current} — 当前对话模型`);
  const pool = scoped.length ? scoped : available;
  const seen = new Set(current ? [current] : []);
  for (const id of pool) {
    if (seen.has(id)) continue;
    seen.add(id);
    options.push(id);
  }
  return options;
}

/** Strip the display suffix back to `provider/model`. */
function optionToModelId(option: string): string {
  return option.replace(/\s+—\s+.*$/, "");
}

/** Finished probes across every mode, for the progress notification. */
function progressTotal(modes: readonly Mode[], progress: Record<string, number>): number {
  return modes.reduce((sum, mode) => sum + (progress[mode] ?? 0), 0);
}

export default function piModelTraceApi(pi: ExtensionAPI) {
  let running = false;

  pi.registerCommand("model-trace-api", {
    description:
      "Attribute a model via RAW API calls (no Pi system prompt), optionally comparing against the Pi-prompt run",
    handler: async (args, ctx) => {
      if (running) {
        ctx.ui.notify("已经有一个 /model-trace-api 在跑了", "warning");
        return;
      }
      const parsed = parseArgs(args);
      if ("error" in parsed) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }

      // Anything the caller did not pin down is asked for, so a bare
      // `/model-trace-api` is two pickers and one Enter in the common case.
      let mode = parsed.mode;
      let query = parsed.query;
      if (ctx.hasUI && (!mode || !query)) {
        if (!mode) {
          const choice = await ctx.ui.select(
            "ModelTrace: 测哪种模式？",
            MODE_OPTIONS.map((option) => option.label),
          );
          if (!choice) return;
          mode = MODE_OPTIONS.find((option) => option.label === choice)?.mode;
          if (!mode) return;
        }
        if (!query) {
          const currentLabel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
          const options = buildModelOptions(
            currentLabel,
            ctx.scopedModels.map((entry) => `${entry.model.provider}/${entry.model.id}`),
            ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`),
          );
          if (!options.length) {
            ctx.ui.notify("没有可用模型", "error");
            return;
          }
          const choice = await ctx.ui.select("ModelTrace: 测哪个模型？", options);
          if (!choice) return;
          query = optionToModelId(choice);
        }
      }
      mode ??= "raw";

      const target = resolveTarget(query, ctx);
      if ("error" in target) {
        ctx.ui.notify(target.error, "error");
        return;
      }

      const { model, label } = target;
      const modes: Mode[] = mode === "both" ? ["raw", "pi"] : [mode];
      const total = modes.length * PROBE_COUNT;
      running = true;
      const startedAt = Date.now();

      // The work runs detached on purpose. A blocked command handler freezes the
      // TUI, so nothing the extension reports can render while it waits — the
      // timer, the counters and even Esc cancellation are all dead weight. Only
      // returning immediately keeps the session usable and progress visible.
      //
      // Defensive on every UI call: this now outlives the handler, and a session
      // switch mid-run leaves the captured ctx stale (docs: "captured old pi /
      // old command ctx session-bound objects are stale after replacement").
      const safeNotify = (message: string, type: "info" | "warning" | "error" = "info") => {
        try {
          ctx.ui.notify(message, type);
        } catch {
          // session replaced mid-run; the transcript result still lands below
        }
      };

      const progress: Record<string, number> = Object.fromEntries(modes.map((m) => [m, 0]));
      let ticker: ReturnType<typeof setInterval> | undefined;

      const run = async (): Promise<void> => {
        try {
          // Best-effort deconfliction with an in-flight turn, NOT a requirement:
          // the session can still start a turn mid-run. Bounded because an
          // unbounded hang here would leave `running` true forever and lock the
          // command out with "already in progress" on every later call.
          await withDeadline(ctx.waitForIdle(), WAIT_IDLE_TIMEOUT_MS, "等待空闲 ").catch(() => {});
          const challenges = generateChallenges(PROBE_COUNT);
          safeNotify(
            `ModelTrace: ${label} · ${modes.length} 种模式 · ${total} 次请求并发，预计 1-2 分钟…`,
          );

          const statusLine = () => {
            const seconds = Math.round((Date.now() - startedAt) / 1000);
            const parts = modes.map((m) => `${m} ${progress[m]}/${PROBE_COUNT}`);
            return `model-trace-api: ${label} · ${parts.join(" · ")} · ${seconds}s`;
          };
          const setStatusOnly = () => {
            try {
              ctx.ui.setStatus(MESSAGE_TYPE, statusLine());
            } catch {
              // stale ctx
            }
          };
          // notify is the channel that provably renders, so the count rides on it
          // too rather than relying on the footer alone.
          const refresh = () => {
            setStatusOnly();
            const elapsed = Math.round((Date.now() - startedAt) / 1000);
            safeNotify(`ModelTrace ${progressTotal(modes, progress)}/${total} 完成 · ${elapsed}s`);
          };

          setStatusOnly();
          ticker = setInterval(setStatusOnly, 1000);

          const results = await Promise.all(
            modes.map((m) =>
              runMode(ctx, model, challenges, m, () => {
                progress[m] += 1;
                refresh();
              }),
            ),
          );

          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
          const lines: string[] = ["## ModelTrace 归因（裸 API）", ""];
          lines.push(`**待测模型**: \`${label}\``);
          lines.push(`**模式**: ${modes.map(modeLabel).join(" vs ")} · **用时 ${elapsed}s**`);
          lines.push("");
          for (const result of results) {
            if (modes.length > 1) {
              lines.push(`#### ${modeLabel(result.mode)}`);
              lines.push("");
            }
            lines.push(...formatSingle(result, label));
            lines.push("");
          }
          if (results.length === 2) {
            const [raw, piResult] = results;
            lines.push(...formatComparison(raw, piResult));
            lines.push("");
          }
          lines.push(
            "> 结果为指纹库内的闭集概率，仅供参考。未收录模型会被归到最相似的现有候选。",
          );

          pi.sendMessage(
            {
              customType: MESSAGE_TYPE,
              content: lines.join("\n"),
              display: true,
              details: { model: label, mode, elapsedSeconds: Number(elapsed) },
            },
            {},
          );
          const okCount = results.filter((result) => result.analysis).length;
          safeNotify(
            okCount
              ? `ModelTrace 完成，用时 ${elapsed}s`
              : `ModelTrace 失败：没有拿到任何可用回答，用时 ${elapsed}s`,
            okCount ? "info" : "error",
          );
        } catch (error) {
          safeNotify(
            `ModelTrace 失败: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        } finally {
          if (ticker) clearInterval(ticker);
          running = false;
          try {
            ctx.ui.setStatus(MESSAGE_TYPE, undefined);
          } catch {
            // stale ctx
          }
        }
      };

      void run();
      safeNotify(`ModelTrace 已开始（${label}），可以继续对话`);
    },
  });
}
