/**
 * Self-check for the branchy bits. Run: node --experimental-strip-types checks.ts
 * No framework, no fixtures — this only has to fail when the logic breaks.
 */

import assert from "node:assert/strict";

import {
  parseArgs,
  buildModelOptions,
  formatComparison,
  formatSingle,
  withDeadline,
} from "./index.ts";

// --- parseArgs -------------------------------------------------------------

// an unspecified mode means "ask", not "raw" — that is what drives the picker
assert.deepEqual(parseArgs(""), { query: "" });
assert.deepEqual(parseArgs("--pi"), { mode: "pi", query: "" });
assert.deepEqual(parseArgs("--both"), { mode: "both", query: "" });
assert.deepEqual(parseArgs("anthropic/claude-opus-5"), {
  query: "anthropic/claude-opus-5",
});
assert.deepEqual(parseArgs("--both openai/gpt-5.6-sol"), {
  mode: "both",
  query: "openai/gpt-5.6-sol",
});
assert.deepEqual(parseArgs("  --pi   openai/gpt-5.6-sol  "), {
  mode: "pi",
  query: "openai/gpt-5.6-sol",
});
// last flag wins, so a stray earlier flag cannot silently change the run
assert.deepEqual(parseArgs("--pi --both"), { mode: "both", query: "" });
assert.ok("error" in parseArgs("--nope"), "unknown flag is rejected");
assert.ok("error" in parseArgs("openai/gpt-5 --bogus"));

// --- buildModelOptions -----------------------------------------------------

// current model is pinned first and never duplicated
assert.deepEqual(
  buildModelOptions("example/a", ["example/a", "example/b"], []),
  ["example/a — 当前对话模型", "example/b"],
);
// scoped list wins over the full catalogue
assert.deepEqual(buildModelOptions(undefined, ["example/b"], ["other/z"]), ["example/b"]);
// no scoping configured -> fall back to everything available
assert.deepEqual(buildModelOptions(undefined, [], ["other/z"]), ["other/z"]);
// a current model outside the scoped set is still offered
assert.deepEqual(buildModelOptions("elsewhere/q", ["example/b"], []), [
  "elsewhere/q — 当前对话模型",
  "example/b",
]);
assert.deepEqual(buildModelOptions("example/a", [], []), ["example/a — 当前对话模型"]);

// --- formatComparison ------------------------------------------------------

type RunResultArg = Parameters<typeof formatComparison>[0];

function fake(
  mode: RunResultArg["mode"],
  prediction: string,
  probability: number,
): RunResultArg {
  return {
    mode,
    counts: [],
    expected: [300, 300, 300],
    analysis: {
      prediction,
      prediction_name: prediction,
      probability,
      used_outputs: 3,
      results: [
        {
          model: prediction,
          display_name: prediction,
          probability,
          profile_similarity: 0.9,
          score: 1,
          family: "gpt",
          family_name: "GPT",
          conditional_probability: 1,
        },
      ],
      diagnostics: [],
      calibration: { queries: "3", beta: 1, cv_accuracy: 0.9 },
      family_prediction: "gpt",
      family_prediction_name: "GPT",
      family_probability: probability,
      family_probabilities: [],
      method: "checks",
    },
  };
}

const agreed = formatComparison(fake("raw", "gpt-5.6-sol", 0.8), fake("pi", "gpt-5.6-sol", 0.5)).join("\n");
assert.match(agreed, /没有改变判定/, "same top model reports agreement");

const disagreed = formatComparison(fake("raw", "gpt-5.6-sol", 0.8), fake("pi", "claude-opus-5", 0.6)).join("\n");
assert.match(disagreed, /判定不一致/, "different top model reports the shift");
assert.match(disagreed, /gpt-5\.6-sol/);
assert.match(disagreed, /claude-opus-5/);

const broken = formatComparison(
  { mode: "raw", counts: [], expected: [300], failure: "spawn failed" },
  fake("pi", "claude-opus-5", 0.6),
).join("\n");
assert.match(broken, /无法比较/, "a failed side does not fabricate a comparison");

// --- probe deadline --------------------------------------------------------
// probe() keys its error message off `deadline.aborted`, so the deadline has to
// actually flip when the timeout fires — otherwise a timeout reports as a
// generic provider error and looks like a model failure.
const deadline = AbortSignal.timeout(20);
assert.equal(deadline.aborted, false, "deadline is not aborted before it fires");
// AbortSignal.timeout uses an UNREF'd timer: it does not keep the event loop
// alive, so without something else pending the process would exit first and the
// await below would hang forever. In probe() the HTTP socket holds the loop, so
// this only bites in tests.
const keepAlive = setTimeout(() => {}, 10_000);
await new Promise<void>((resolve) => {
  deadline.addEventListener("abort", () => resolve(), { once: true });
});
clearTimeout(keepAlive);
assert.equal(deadline.aborted, true, "deadline aborts when the timeout fires");
assert.ok(deadline.reason instanceof Error, "abort reason is an Error (TimeoutError)");

// AbortSignal.any is how ctx.signal cancels a probe; it must follow the first
// abort from either source.
const parent = new AbortController();
const combined = AbortSignal.any([parent.signal, AbortSignal.timeout(60_000)]);
assert.equal(combined.aborted, false);
parent.abort();
assert.equal(combined.aborted, true, "combined signal follows ctx.signal");
assert.equal(combined.reason, parent.signal.reason, "reason comes from whoever fired first");

// --- withDeadline ----------------------------------------------------------
// This is the mechanism that unsticks a wedged TUI, so it has to be asserted
// against a promise that NEVER settles — not against a slow-but-working one.
const never = new Promise<string>(() => {});
const startedAt = Date.now();
await assert.rejects(
  () => withDeadline(never, 30),
  /超过 .*未返回/,
  "a hung probe is released by the deadline",
);
assert.ok(Date.now() - startedAt < 5000, "it is released by the deadline, not later");
assert.equal(await withDeadline(Promise.resolve("ok"), 5000), "ok", "fast work passes through");
await assert.rejects(
  () => withDeadline(Promise.reject(new Error("provider error")), 5000),
  /provider error/,
  "a real failure is reported as itself, not as a timeout",
);
// The waitForIdle guard must release on its own too, or `running` never resets
// and every later /model-trace-api reports "already in progress".
await assert.rejects(
  () => withDeadline(new Promise<void>(() => {}), 25, "等待空闲 "),
  /等待空闲 超过 .*未返回/,
  "the idle wait is bounded, so the running guard cannot wedge",
);

// --- all-probes-failed report path -----------------------------------------
// The "model never returns" case has to produce a readable report, not a blank
// one: every probe timing out leaves no analysis at all.
const allFailed: RunResultArg = {
  mode: "raw",
  counts: [0, 0, 0],
  expected: [300, 300, 300],
  failure: "探针 超过 5 分钟未返回，已放弃",
};
const failedReport = formatSingle(allFailed, "example/codex/gpt-5.6-sol").join("\n");
assert.match(failedReport, /失败: 探针 超过 5 分钟未返回/, "reason reaches the headline");
assert.match(failedReport, /^> 探针 超过 5 分钟未返回/m, "reason is repeated in the detail block");
assert.doesNotMatch(failedReport, /家族概率/, "no fabricated probabilities when nothing succeeded");

console.log("checks.ts: all assertions passed");
