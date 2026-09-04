# Measurements

Numbers that back a decision but are too bulky for [decisions.md](decisions.md), and too costly to re-derive from scratch. Each entry states what was measured, how, and what it settled. **Not a changelog** — a measurement lands here only when a later reader would otherwise have to re-run it.

## Method (shared)

The data source is the local transcript corpus: `~/.claude/projects/**/subagents/*.jsonl` plus each session's own `<session-id>.jsonl`. Per assistant entry, `message.usage` carries `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation.ephemeral_{5m,1h}_input_tokens`, and `output_tokens`; `message.diagnostics.cache_miss_reason` carries `{type, cache_missed_input_tokens}`. Spawn metadata is the sibling `*.meta.json` (`agentType`, `customAgentType`, `taskKind`).

Two gotchas that will corrupt any re-run:

- **Dedupe by `message.id`.** One API request is logged once per content block, so a naive line count multiplies usage by 2–3x.
- **Cost weights, in base-input-equivalents:** 5-minute cache write **1.25x**, 1-hour cache write **2x**, cache read **0.1x** (and a read refreshes the TTL), output **5x** on Opus. Per [prompt-caching pricing](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

## 2026-08-17 — `name:` at spawn drops the plugin agent definition

**Question.** Why did `hyper-plan-loop` burn the 5-hour limit far faster than a linear session?

**Cross-tab over 434 subagent transcripts.** Agent definition resolved → `skill_listing` 0 in **165/165**. Teammate with the definition lost → `skill_listing > 0` in **62/62**, and the count equalled the round count exactly. Zero overlap.

**Single-session A/B**, same agent, same prompt, Claude Code 2.1.233: `hyperclaude:planner` + `name:"probe-plugin"` → `skill_listing` 1 (47 skills), `deferred_tools` 56. Same spawn without `name:` → **both 0**, and a second round via `SendMessage` to the returned `agentId` showed an empty `cache_miss_reason`.

**Cost shape.** Each round re-attached the listing, invalidating the message-level cache while `cache_read` stayed pinned at the system+tools floor (13,818 tokens). Observed re-write ladders: 131k→228k over 8 rounds, 161k→512k over 9. Per-request weight: teammate 56k vs one-shot subagent 13k (**4.1x**).

**Ruled out by direct test:** the model (one-shot fable had the best cache ratio in the corpus), `tools:` array-vs-comma frontmatter syntax, and Claude Code version (2.1.226 shows both outcomes).

**Settled:** upstream bug, not a design flaw in agent teams — see [decisions.md](decisions.md) and anthropics/claude-code #78234 / #81746. Fixed in v1.12.0.

## 2026-08-17 — `ENABLE_PROMPT_CACHING_1H` is net negative here

**Question.** Subagents cache at a 5-minute TTL while the main thread gets an hour. Should we override it?

**Mechanism.** Claude Code selects the TTL from a `querySource` allowlist — default `["repl_main_thread*", "sdk", "auto_mode", "memdir_relevance"]`, which no subagent source matches. `ENABLE_PROMPT_CACHING_1H` overrides it for every source; `FORCE_PROMPT_CACHING_5M` forces the other way; and `isUsingOverage` forces 5m regardless, which is why cache behaviour degrades further past a usage limit.

**Simulation over 480 subagent transcripts.** Expiry-driven re-writes were re-scored as reads, every other write re-scored at the 1h rate:

| bucket | files | A: today (5m) | B: 1h | B/A |
|---|---|---|---|---|
| named, span ≤5min | 14 | 1.30M | 1.81M | 1.39 |
| named, span >5min | 55 | 104.33M | 126.21M | 1.21 |
| one-shot, span ≤5min | 244 | 35.76M | 44.82M | 1.25 |
| one-shot, span >5min | 167 | 96.51M | 108.85M | 1.13 |
| **total** | **480** | **237.90M** | **281.69M** | **1.184** |

**Break-even.** Saving 1.15x per token moved write→read against paying 0.75x extra on every remaining write, expiry-driven tokens must be **39%** of all write tokens. Strict classification puts them at 12.7%, the loosest at 16.8%, and counting *every* write after a 5–60min gap at 18.8% — so the verdict does not turn on the classification.

**Settled:** do not set it. Every bucket loses, including the multi-round loop agents the override was meant to help.

## 2026-08-17 — a cache keepalive is not worth building

**Question.** If the TTL cannot be changed, can a periodic refresh keep the agent's cache warm across a Codex review?

**Mechanism is available.** The timer objection was wrong: a backgrounded `sleep N; echo PING` returns its output to the lead as a task notification, giving an alarm with no scheduler in skill prose. Verified directly.

**Value, over 105 observed expiry boundaries.** A read refreshes the TTL at 0.1x, so bridging a gap costs one refresh per ~4 minutes of it. Gap distribution: 66 at 5–10min, 20 at 10–30min, 3 at 30–60min, **16 over 60min**.

| refresh cap | boundaries bridged | budget spent but still expired | net |
|---|---|---|---|
| 1 | 43 | 62 | +2.7% |
| 2 | 77 | 28 | +4.8% |
| **3** | 84 | 21 | **+5.2%** |
| 5 | 86 | 19 | +5.1% |
| unbounded | 105 | 0 | **−18.2%** |

Unbounded is catastrophic because bridging a >60min gap needs 15+ refreshes, each reading the full live context.

**Settled:** the optimum is ~5% of subagent weight — roughly **1% of session weight**, since subagents were 22% of the measured session — and 21 of 105 boundaries still spend the budget and expire, because gap length is unknowable when the refresh is scheduled. Not built.

## 2026-08-18 — post-release dogfood confirms the transport

**Question.** Does the v1.12.0 transport behave as designed on a real run?

**Subject.** `project-wander`, a `hyper-plan-loop` run: 26 requests, 25 minutes, 4 Codex review rounds converging `Send back for fixes` → `Ship after fixes`.

**Definition resolved.** Spawn metadata carried `agentType: "hyperclaude:planner"` — the namespaced type, no `name:`. **`skill_listing` 0, `deferred_tools_delta` 0** across the whole run.

**Round boundaries behave differently in kind, not degree.** Under the old teammate transport `cache_read` sat at the 13,818-token system+tools floor at every boundary and the whole conversation was re-written. Here, sub-5-minute boundaries kept `cache_read` at **89k–132k** and re-wrote only an 8–24k delta — the conversation prefix survives. One boundary of the eight exceeded the TTL (354s): `cache_read` collapsed to 5,192 and 80k was re-written, exactly the accepted 5-minute-TTL exposure.

**Caveat.** Whole-run `write:read` was 1:7.6, the top of the old teammate range rather than clearly outside it — a 25-minute single run is dominated by its initial write. The per-boundary `cache_read` figures are the signal, not the run-level ratio.

## 2026-09-02 — four bridge timeouts, four healthy runs killed

**Source differs from the shared Method above.** Not the Claude transcript corpus but codex's own rollout logs: `~/.codex/sessions/<YYYY/MM/DD>/rollout-*-<codex-thread-id>.jsonl`, located via the `codex-thread-id` in the failed artifact's frontmatter. Event timestamps are what establish stall length and time-of-death.

Four artifacts in a consumer repo carried `# (codex failed)` + `timed-out=true`:

| artifact | rollout evidence | what the 600s kill interrupted |
|---|---|---|
| `docs-reviews/…-architecture.md` (04:58) | 113 events; 424s stall from 05:01:13 → **recovered** → 05:08:44 reasoning → 05:09:02 `agent_message` | the finished review body mid-print, truncated at `### Verdict` |
| `docs-reviews/…-architecture.md` (05:17) | 33 events; 604s stall from 05:18:10 → response at 05:28:14 with `last_token_usage` | 37s before the response landed |
| `research/…-cancel-workflow.md` | 203 events; longest normal gap 73s; 4 `spawn_agent`, nesting depth 10; 3.88M tokens | report writing, just after sub-agent results were collected |
| `research/…-child-python-workflow.md` | 290 events; **zero gaps over 60s**; 4 `spawn_agent`; 6.50M tokens | same |

**4/4 killed work that would have completed. Zero genuinely wedged.**

Three gotchas that will corrupt a re-run:

- **Artifact mtime is not run duration.** `child.kill()` hit only the npm Node wrapper; a surviving descendant held the stdout pipe, so `close` — and the artifact write — lagged the deadline by up to six minutes, with an exit signature of `status=0, signal=null`. Measure from the rollout's first and last event instead.
- **`codex_core::tools::router: error=timeout_ms must be at least 10000` in stderr is not the cause.** It is the router rejecting a `wait_agent{"timeout_ms":1000}` argument below its floor; the model corrects to a valid value within ~3s and continues. Sub-agents share the parent's stderr, so such a line can appear with no matching event in the parent rollout.
- **Judging an idle threshold by normal event spacing is the trap.** The largest healthy gap was 73s, which suggests idle-240s is safe; the two real stalls were 424s and 604s and both self-recovered, so that threshold kills exactly the runs a reaper is supposed to spare.

## 2026-09-04 — the planner's 1h bucket holds, and the loop was never the cost

**Sources differ from the shared Method above.** Three, one per cost centre: the lead session's own `<session-id>.jsonl`; the planner's `claude -p` transcript, which lands in the *same* `~/.claude/projects/<cwd>/` directory under its bridge-minted session id; and the Codex artifacts' own `codex-*-tokens` frontmatter. The middle one is the useful discovery — **the planner needs no added usage recording**, because a headless `claude -p` run writes a normal transcript with full `message.usage`, so `parseClaudeJson()` discarding the envelope's `usage` costs nothing.

**Subject.** A consumer repo, one `hyper-plan-loop` run: 7 Codex review rounds, planner span 53m50s, 42 deduped planner calls, 381 deduped lead calls.

**All six round boundaries hit the cache.** `cache_read` on the first call after each resume, against the prior round's ending cumulative prefix:

| gap | 8m57s | 5m57s | 4m24s | 4m34s | 3m06s | 2m39s |
|---|---|---|---|---|---|---|
| `cache_read` at resume | 203,074 | 251,335 | 280,252 | 313,590 | 325,705 | 346,560 |
| prior cumulative | 203,106 | 251,367 | 280,284 | 313,622 | 325,737 | 346,592 |

Every one is within 32 tokens of a total hit. All 355,402 written tokens landed in `ephemeral_1h`; `ephemeral_5m` was 0 on all 42 calls.

**What the bucket is actually worth — smaller than it looks on a fast loop.** Only **2 of the 6** gaps exceed five minutes, so the 5-minute counterfactual re-creates 454,409 tokens at 1.25x (568,011) where the 1h run read them at 0.1x (45,441), while paying a 266,551 premium writing everything at 2x instead of 1.25x. Net **−256,019 base-input units, ~10% of planner spend**. Had all six boundaries exceeded five minutes — the profile of the 469s and 1393s boundaries in the 2026-08-17 entry — the same run saves **1,712,042, ~68%**. The worst case, a loop whose every boundary lands inside five minutes, is the 2x write premium alone: 266,551, under 2% of the run's Claude-side total.

**Three suspected cost drivers, all exonerated.** *Plan re-reads:* the lead never read the plan file in full — 6 partial touches, 2,956 chars — and took each round's findings from the backgrounded bridge's captured stdout, 19,074 chars for all 7 rounds. **~6,300 tokens for the entire loop.** *Plan size:* 44,691 bytes, mid-pack; the immediately preceding series converged in 4 rounds on a **larger** 49,177-byte plan while spending *more* uncached per round (342k vs 225k). *Round count:* findings went 9→5→4→3→2→1→0, monotonic, no oscillation; rounds 5–7 together were 3.6% of the series' uncached spend and round 6 still caught a real race.

**Where it did go.** In base-input-equivalents the lead session is 12.84M against the planner's 2.52M, and 81% of the lead is `cache_read` — 381 turns against a context that grew to 518k and compacted exactly once, at the very end. Two `hyper-code-review` passes and a `hyper-research` ran ahead of the loop in the same uncompacted 4h50m context: **408,905 paid input and 72.8M `cache_read` before the loop's first call**, against the loop's own 55,538. Codex is separately priced: 17.9M input at 91.2% cached, **1,574,163 uncached**, one round (a transport-verification round) carrying 18% of that alone. Second-largest planner line item is self-inflicted: 4 full-file `Write` calls totalling 144,001 chars, ~25% of planner output, where `Edit` would have done.

**Gotcha for a re-run.** The lead transcript is being appended to while you read it; snapshot the file first or two passes will disagree.
