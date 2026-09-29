# pi-model-trace-direct

Attribute the model actually serving a provider, using **raw API calls**: a probe carries no
Pi system prompt, no `AGENTS.md`, no skills, no conversation history.

ModelTrace identifies a model by its numeric-generation bias. Each probe asks for ~300 integers
between 1 and 355 and scores the answer against a fingerprint bank that is fetched from the
reference project on first use. It is the practical answer to "did this endpoint really give me the
model I paid for".

## Why a separate package

The existing `@indexyz/pi-model-trace` runs its probes as `pi -p --no-session --no-tools` child
processes. That gives the model a clean *conversation*, but it still carries Pi's whole system
prompt. The bank is built from 12 prompt environments and projects the average between-environment
offset out of the feature space, so a harness prompt is damped rather than invisible — it can still
pull a model that is right in front of you onto its nearest neighbour.

This package calls `ctx.modelRegistry.streamSimple()` with a context it builds itself, so the system
prompt is exactly what this package decides it is:

```ts
// raw mode — the default
messages = [{ role: "user", content: challenge.prompt }]

// --pi mode — same challenge, plus Pi's prompt
messages = [{ role: "system", content: ctx.getSystemPrompt() },
            { role: "user",   content: challenge.prompt }]
```

Authentication, base URLs and the Anthropic/OpenAI format differences all stay with Pi's provider
layer, so there is **no API key to enter and no HTTP client to trust**. `provider/model` is enough.

## Install

```bash
pi install npm:pi-model-trace-direct
# or, working on the source:
pi install /path/to/pi-model-trace-direct
```

Then quit and relaunch Pi: extensions load at startup and the command list is fixed for the session.
Note that `/reload` does **not** cover a path install — a package installed by path is not in an
auto-discovery directory, so source edits need a restart.

## Commands

```text
/model-trace-direct                 pick mode, then pick model
/model-trace-direct --both          mode given, only the model is asked for
/model-trace-direct openai/gpt-5.6-sol            model given, only the mode is asked for
/model-trace-direct openai/gpt-5.6-sol --both     no pickers, runs straight away
```

The rule is **whatever the arguments pin down is not asked about again**, so the pickers never get
in the way of scripted use. The model list is the session's scoped set — the same list `/model`
shows — with the current conversation model pinned first. With no UI (`pi -p`) the pickers are
skipped and it runs `--raw` against the current model.

| mode | system prompt | when |
| --- | --- | --- |
| `--raw` (default) | none | the honest measurement; the reference challenges were collected this way |
| `--pi` | Pi's current prompt | what the harness costs you |
| `--both` | both, same challenges | the delta between them |

## The delta is the point

`--both` runs the *same* challenges through both modes and reports the comparison:

```text
| | bare API | with Pi's prompt |
| top model | gpt-5.6-sol (78.3%) | claude-opus-5 (54.1%) |

Conclusion: the two modes disagree. Same challenges, same model — only the system
prompt changed. Trust the bare-API answer; that is the environment the reference
challenges were collected in.
```

Same challenge generator, same scoring code, one variable. That is a measurement of the harness
prompt's cost, not noise between two different tools.

## What gets scored

Three probes, each asking for 292–333 first-instinct integers from 1 to 355 inclusive, with tools,
code execution and arithmetic progressions explicitly forbidden. Answers shorter than 55% of the
requested count are discarded.

```text
0.75 × nuisance-projected Hellinger centroid similarity
+ 0.25 × ordered-block digit-sequence feature
```

The bank was built by running each model across 12 prompt environments (clean / system / user
transport, JSON / English / Chinese style, prefixes of 0 to 2048 words) and projecting the average
offset between environments out of the feature space. Model probabilities come from one global
softmax; family probability is the sum over that family's models.

The bank holds **53 models across 12 families and 9 providers** — 10 GPT, 11 Claude, 6 Gemini,
3 Grok, 4 GLM, 6 DeepSeek, 4 MiMo, 2 Qwen, 2 Kimi, 3 Muse, 1 Step, 1 Hunyuan — built from 1948
enrolled responses. The reference data is maintained by
[Ikaleio/lm-detector](https://github.com/Ikaleio/lm-detector) (MIT).

### Where the bank comes from

The bank is **not bundled**: it is fetched from `https://lm.ikale.io/data/` on first use, verified,
and cached at `~/.cache/pi-model-trace-direct/bank.json` (~1 MB compressed, ~3 MB on disk).

Integrity, in order:

1. Every chunk is content-addressed — `unified_bank.json.<sha256(compressed)[:16]>.0.zst` — so the
expected digest comes from the manifest itself and is checked against the bytes actually received.
2. The decompressed payload is parsed and shape-checked (`model_order` alignment, 355-bin
histograms, 355/74-wide centroids, the 1/2/3-answer calibration) before anything is scored.
3. The cache is re-hashed on every load, so a corrupted cache is refetched instead of scored.

| variable | effect |
| --- | --- |
| `PI_MODEL_TRACE_BANK` | path to a local bank file; skips the network entirely |
| `PI_MODEL_TRACE_BANK_SHA256` | pin the exact revision by sha256 of the decompressed bank |

Offline with a warm cache, the last fetched bank is used. Offline with a cold cache, the run fails
with that instruction rather than silently attributing against nothing.

## Behaviour against a slow provider

The command **does not block the session**. Probes run detached and report progress as they land:

```text
ModelTrace started for provider/model — you can keep chatting
ModelTrace 1/3 done · 24s
ModelTrace 2/3 done · 41s
ModelTrace 3/3 done · 58s
ModelTrace finished in 58s
```

This is not a preference. A blocked command handler freezes the TUI: nothing the extension reports
renders, and `Esc` cannot cancel it, because `ctx.signal` is documented as usually undefined in
extension commands. Returning immediately is the only way the session stays usable.

Three independent bounds keep a stalled endpoint from wedging anything:

| bound | value | why |
| --- | --- | --- |
| per probe | 5 min | `Promise.race` against a plain timer. Passing `AbortSignal` is not enough — a provider may ignore it, or abort the socket without ever ending the event stream, leaving `for await` pending forever |
| idle wait | 60 s | best-effort deconfliction with an in-flight turn. Unbounded, it would leave the `running` guard set and lock the command out for the rest of the session |
| whole run | ≈6 min | every probe starts together, so wall time tracks the slowest one, not the sum |

Probes run concurrently: 3 for a single mode, 6 for `--both`. A slow provider makes the run take
longer, not a multiple of it — but it also means all of them hit the same endpoint at once, so a
rate limit shows up as a failed probe rather than a failed run.

## What a result means, and what it does not

The probabilities are **closed-set**: relative to the candidates in the bank only. A model that is not
in the bank still gets attributed to its nearest neighbour, and nothing in the output will say so.
Read a confident 49% as "closer to this candidate than to the others", not as "this is the model".

Two further caveats worth holding onto:

- A sample that lands between centroids produces an unstable ranking. If `--both` flips the verdict,
  the sample is ambiguous — do not treat either number as a conclusion.
- Raw similarity and final ranking can disagree. The weighted Hellinger score drives the
  probabilities, so a candidate with a lower `distribution similarity` can still rank first.

## Credits

The scoring algorithm and challenge generator are an MIT-licensed TypeScript port of
[xqy2006/ModelTrace](https://github.com/xqy2006/ModelTrace) (Copyright © 2026 xqy2006), which in
turn credits [hanlinwenyuan/hlwy-ai-checker](https://github.com/hanlinwenyuan/hlwy-ai-checker) for
first applying language-model numeric bias to third-party channel checking. The fingerprint bank and
the reference data behind it come from [Ikaleio/lm-detector](https://github.com/Ikaleio/lm-detector)
(MIT, Copyright © 2026 Ikaleio).

## Development

```bash
npm install
npm run check     # tsc --noEmit, then checks.ts
```

`checks.ts` is a framework-free self-check — plain assertions, no test runner. It covers argument
parsing, the model-picker list, the comparison text, and the deadline machinery against a promise
that never settles.

Typechecking is the load-bearing step: `@earendil-works/pi-coding-agent` is a non-optional peer
dependency, so `npm ci` installs the host's real types and a host API change breaks this build
instead of failing at runtime.

## License

MIT. See [LICENSE](LICENSE).
