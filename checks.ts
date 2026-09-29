/**
 * Self-check for the branchy bits. Run: node --experimental-strip-types checks.ts
 * No framework, no fixtures — this only has to fail when the logic breaks.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { chunkDigest, validateBank, verifyChunk } from "./bank.ts";
import { byProbabilityDesc, DIMENSION, parseNumbers, type FingerprintBank } from "./fingerprint.ts";
import {
  capAnswer,
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
  ["example/a — current conversation model", "example/b"],
);
// scoped list wins over the full catalogue
assert.deepEqual(buildModelOptions(undefined, ["example/b"], ["other/z"]), ["example/b"]);
// no scoping configured -> fall back to everything available
assert.deepEqual(buildModelOptions(undefined, [], ["other/z"]), ["other/z"]);
// a current model outside the scoped set is still offered
assert.deepEqual(buildModelOptions("elsewhere/q", ["example/b"], []), [
  "elsewhere/q — current conversation model",
  "example/b",
]);
assert.deepEqual(buildModelOptions("example/a", [], []), ["example/a — current conversation model"]);

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
assert.match(agreed, /did not change the verdict/, "same top model reports agreement");

const disagreed = formatComparison(fake("raw", "gpt-5.6-sol", 0.8), fake("pi", "claude-opus-5", 0.6)).join("\n");
assert.match(disagreed, /the two modes disagree/, "different top model reports the shift");
assert.match(disagreed, /gpt-5\.6-sol/);
assert.match(disagreed, /claude-opus-5/);

const broken = formatComparison(
  { mode: "raw", counts: [], expected: [300], failure: "spawn failed" },
  fake("pi", "claude-opus-5", 0.6),
).join("\n");
assert.match(broken, /nothing to compare/, "a failed side does not fabricate a comparison");

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
  /did not return within .* giving up/,
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
// and every later /model-trace-direct reports "already in progress".
await assert.rejects(
  () => withDeadline(new Promise<void>(() => {}), 25, "Idle wait "),
  /Idle wait did not return within .* giving up/,
  "the idle wait is bounded, so the running guard cannot wedge",
);

// --- all-probes-failed report path -----------------------------------------
// The "model never returns" case has to produce a readable report, not a blank
// one: every probe timing out leaves no analysis at all.
const allFailed: RunResultArg = {
  mode: "raw",
  counts: [0, 0, 0],
  expected: [300, 300, 300],
  failure: "Probe did not return within 5 min, giving up",
};
const failedReport = formatSingle(allFailed, "example/codex/gpt-5.6-sol").join("\n");
assert.match(failedReport, /Failed: Probe did not return within 5 min/, "reason reaches the headline");
assert.match(failedReport, /^> Probe did not return within 5 min/m, "reason is repeated in the detail block");
assert.doesNotMatch(failedReport, /Family probabilities/, "no fabricated probabilities when nothing succeeded");

// --- runtime bank source ----------------------------------------------------
// The bank is fetched, so the checksum and the shape checks are the only thing
// between a broken download and a wrong attribution. All offline.
const payload = Buffer.from("payload");
const payloadDigest = createHash("sha256").update(payload).digest("hex").slice(0, 16);
const chunkName = `unified_bank.json.${payloadDigest}.0.zst`;
assert.equal(chunkDigest(chunkName), payloadDigest, "digest is read out of the chunk name");
assert.throws(() => chunkDigest("unified_bank.json.zst"), /malformed/, "a name without a digest is rejected");
verifyChunk(chunkName, Buffer.from("payload"));
assert.throws(
  () => verifyChunk(chunkName, Buffer.from("payloaX")),
  /failed its checksum/,
  "one flipped byte is caught",
);

// SAFETY: the fixture is deliberately partial and deliberately not a real
// FingerprintBank — validateBank only reads the fields built right here, so
// the cast hides nothing the checks below depend on.
const synthetic = () => {
  const counts = Array(DIMENSION).fill(1) as number[];
  const row = (width: number) => Array(width).fill(0) as number[];
  return {
    schema: "robust-number-fingerprint-bank",
    models: [
      { id: "a", display_name: "A", counts },
      { id: "b", display_name: "B", counts },
    ],
    robust: {
      model_order: ["a", "b"],
      hellinger: { centroids: [row(DIMENSION), row(DIMENSION)] },
      ordered_blocks: {
        centroids: [row(74), row(74)],
        environment_centroids: [[row(74), row(74)]],
      },
    },
    calibration: { 1: { beta: 1 }, 2: { beta: 1 }, 3: { beta: 1 } },
  } as unknown as FingerprintBank;
};
assert.equal(validateBank(synthetic()).models.length, 2, "a bank with the right shape passes");
assert.throws(() => validateBank({ ...synthetic(), models: [] }), /no models/, "an empty bank is rejected");
assert.throws(
  () => validateBank({ ...synthetic(), calibration: {} } as FingerprintBank),
  /missing the 1-answer calibration/,
  "an uncalibrated bank is rejected",
);
const truncated = synthetic();
truncated.robust.hellinger.centroids[1].pop();
assert.throws(() => validateBank(truncated), /hellinger\.centroids is not 2x355/, "a short centroid row is rejected");
const shuffled = synthetic();
shuffled.robust.model_order = ["b", "a"];
assert.throws(() => validateBank(shuffled), /out of step at index 0/, "a reordered bank is rejected");

// --- family order -----------------------------------------------------------
// The report is read top-down: the winning family has to be the first line.
assert.deepEqual(
  [{ probability: 0.1 }, { probability: 0.9 }, { probability: 0.4 }].sort(byProbabilityDesc),
  [{ probability: 0.9 }, { probability: 0.4 }, { probability: 0.1 }],
  "families are listed by descending probability, not bank order",
);

// --- answer cap -------------------------------------------------------------
// A probe that stops reasoning writes past the requested count (measured
// 324-4101 integers for a 295-integer request, finish_reason "stop"), and the
// bank was built on answers that stop at the count. The reader must cut it.
const overshoot = Array.from({ length: 900 }, (_, index) => String((index % 355) + 1)).join(", ");
const capped = capAnswer(overshoot, 300);
assert.equal(capped?.split(", ").length, 300, "a 900-integer answer is cut to the 300 requested");
assert.equal(parseNumbers(capped ?? "").length, 300, "the capped text re-parses as exactly 300 integers");
assert.equal(capAnswer("10, 20, 30", 300), undefined, "a short answer keeps reading");
// the last digits of a stream may still grow: "3" can still become "355"
assert.equal(
  capAnswer("10, 20, 30, 40, 5", 4),
  "10, 20, 30, 40",
  "a half-arrived number is not part of the answer",
);
assert.equal(capAnswer("10, 20, 30, 40, 5", 5), undefined, "a half-arrived number cannot satisfy the count");

console.log("checks.ts: all assertions passed");
