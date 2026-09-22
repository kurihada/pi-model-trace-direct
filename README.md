# pi-model-trace-direct

Attribute the model actually serving a provider, using **raw API calls**: a probe carries no
Pi system prompt, no `AGENTS.md`, no skills, no conversation history.

ModelTrace identifies a model by its numeric-generation bias. Each probe asks for ~300 integers
between 1 and 355 and scores the answer against a bundled fingerprint bank. It is the practical
answer to "did this endpoint really give me the model I paid for".

## Why a separate package

The existing `@indexyz/pi-model-trace` runs its probes as `pi -p --no-session --no-tools` child
processes. That gives the model a clean *conversation*, but it still carries Pi's whole system
prompt. The bank behind both packages was collected over bare API calls, so a harness prompt shifts
the output distribution away from every stored centroid — and a model sitting right in front of you
gets attributed to its nearest neighbour instead.

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
| `--raw` (default) | none | the honest measurement; matches the bank's collection environment |
| `--pi` | Pi's current prompt | what the harness costs you |
| `--both` | both, same challenges | the delta between them |

## The delta is the point

`--both` runs the *same* challenges through both modes and reports the comparison:

```text
| | bare API | with Pi's prompt |
| top model | gpt-5.6-sol (78.3%) | claude-opus-5 (54.1%) |

Conclusion: the two modes disagree. Same challenges, same model — only the system
prompt changed. Trust the bare-API answer; the bank was collected that way.
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

The bundled bank holds **24 models across 6 families** — 8 GPT, 9 Claude, 3 Kimi, 2 Grok, 1 Gemini,
1 GLM. Upstream's own repository is still on an older 13-model, 2-family bank.

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

The probabilities are **closed-set**: relative to the bundled candidates only. A model that is not
in the bank still gets attributed to its nearest neighbour, and nothing in the output will say so.
Read a confident 49% as "closer to this candidate than to the others", not as "this is the model".

Two further caveats worth holding onto:

- A sample that lands between centroids produces an unstable ranking. If `--both` flips the verdict,
  the sample is ambiguous — do not treat either number as a conclusion.
- Raw similarity and final ranking can disagree. The weighted Hellinger score drives the
  probabilities, so a candidate with a lower `distribution similarity` can still rank first.

## Credits

The scoring algorithm, challenge generator and fingerprint bank are an MIT-licensed TypeScript port
of [xqy2006/ModelTrace](https://github.com/xqy2006/ModelTrace) (Copyright © 2026 xqy2006), which in
turn credits [hanlinwenyuan/hlwy-ai-checker](https://github.com/hanlinwenyuan/hlwy-ai-checker) for
first applying language-model numeric bias to third-party channel checking.

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
