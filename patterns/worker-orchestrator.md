---
name: worker-orchestrator
title: Worker Orchestrator Pattern
summary: Fan concrete implementation work out to the GPT worker (the ask_gpt tool with a fast model, over MCP) through cheap Sonnet wrapper subagents, so the main loop stays uncluttered and the work runs in parallel — validated by execution (build/tests), not a verification gate.
use_when: Routine, concrete, self-verifying work — code patches, debugging from a stack trace, test writing, repo inspection, mechanical refactors — where correctness is settled by running the result. For reviews/critique/threat-modeling whose output you must trust before acting, use two-layer-cross-model-expert instead.
---

# Worker Orchestrator Pattern

> **What this documents:** a lightweight way to put the **GPT worker (the `ask_gpt` tool with a fast
> model, reached over MCP) to work on concrete implementation tasks** inside an agent loop — by
> wrapping it in cheap Claude subagents that run in parallel. It is the **no-gate sibling** of
> [`two-layer-cross-model-expert`](./two-layer-cross-model-expert.md): use that one when expert output
> is a *claim* you must verify before trusting; use **this** one when the output is a *concrete
> artifact* (a patch, a fix, a test) whose correctness is settled by **running it**.

---

## TL;DR

```
                ORCHESTRATOR (your main agent session)
                         │  splits work into independent units,
                         │  dispatches a bounded wave in parallel
   ┌─────────────────────┼─────────────────────┐
   ▼                     ▼                     ▼
 Wrapper subagent     Wrapper subagent     Wrapper subagent      ← LAYER 1 (Sonnet wrapper)
 (bundle → call →     (bundle → call →     (bundle → call →
  integrate → report)  integrate → report)  integrate → report)
   │                     │                     │
   ▼ MCP call            ▼ MCP call            ▼ MCP call
 ask_gpt (fast model) ask_gpt (fast model) ask_gpt (fast model) ← LAYER 2 (GPT worker)
   │                     │                     │
   └──── Validate by EXECUTION (build / run tests / apply patch) — not a claim-by-claim gate ────┘
```

- **Layer 0 — Orchestrator:** your main session. Splits the work, fans out a bounded wave, merges results.
- **Layer 1 — Wrapper subagent (Sonnet):** assembles a tight input bundle, calls `ask_gpt`, integrates
  the result into a usable artifact, and reports back compactly. **No verification gate.**
- **Layer 2 — GPT worker (over MCP):** `ask_gpt` with a fast model (e.g. `gpt-5.4-mini` or `gpt-5.4`)
  and no/low `reasoning_effort` — concrete code, edits, debugging, tests, repo inspection.

**Validation is by execution, not inspection.** The worker produces artifacts you can run, so you
trust them the way you trust any code: build it, run the tests, apply the patch and see it work. That
empirical check *replaces* the verification gate of the two-layer pattern.

---

## How it maps to gpt-subagents-subscription

| Layer | In this project |
|---|---|
| **Layer 0 — Orchestrator** | Your main Claude Code session. |
| **Layer 1 — Wrapper subagent** | A **Sonnet** Claude subagent per work unit (via the `Task` tool): bundles inputs, calls `ask_gpt`, integrates the output, reports back. |
| **Layer 2 — Worker (over MCP)** | `ask_gpt` with a **fast** model (`gpt-5.4-mini` / `gpt-5.4`) — concrete coding, debugging, tests, repo inspection. (For the verifying *expert* role, use `gpt-5.5` with `reasoning_effort: high` under the two-layer pattern.) |

---

## Why Sonnet for the wrapper

The wrapper choice is **not** limited by context size: everything flowing through it is bounded by the
MCP server's input caps, which sit well under either model's context window — Haiku and Sonnet both fit
comfortably. So choose by the *job* the wrapper does:

- There is **no verification gate** here, so the wrapper isn't doing heavy claim-by-claim reasoning.
- But it still has to **compose a precise task + context bundle** for the worker and **integrate and
  sanity-check** what comes back before handing it up — that is real judgment.
- **Sonnet** is the right floor: materially more reliable at task composition and output integration
  than Haiku, and much cheaper than spending the orchestrator's full model on shuttling inputs.

---

## Why wrap the worker (the point of the pattern)

| Concern | Calling `ask_gpt` directly from the main loop | Wrapping it in Sonnet subagents |
|---|---|---|
| **Context bloat** | Every file / stack trace the worker needs is read into your *main* context | Bundle assembly happens inside each subagent; the main loop sees only the compact result |
| **Parallelism** | Calls are effectively serial | Subagents run concurrently in bounded waves |
| **Cost** | Orchestrator-model tokens spent shuttling raw inputs | A cheap Sonnet wrapper does the shuttling |
| **Durability** | Results live only in the conversation | Each result is written to a durable artifact as it returns |

> The deliberately **absent** row is a verification gate: worker output is validated by execution, not
> trusted as a claim. That is the intentional difference from the two-layer pattern.

---

## The moves

1. **Split** the work into independent units (separate files, separate bugs, separate refactors).
2. **Bundle** — each wrapper gathers a tight, high-signal input set for its unit: the code to change,
   the failing test, the stack trace, the relevant surrounding files.
3. **Call** `ask_gpt` with a precise task + the bundle as context, choosing a fast model that fits the job.
4. **Integrate** — the wrapper turns the worker's output into a usable artifact (applies/normalizes the
   patch, extracts the answer) and does a light sanity check: does it parse, does it address the task.
5. **Validate by execution** — **run it**: build, tests, apply the patch. A failure simply becomes a
   new work unit. This is the "gate," and it is empirical.
6. **Aggregate** — append each unit's result to a durable artifact as it returns.

---

## Operating guidelines

- **Bounded waves (~3 concurrent).** Like the expert pattern — avoids MCP/client timeouts and contention.
- **Validate by running, every time.** The correctness guarantee here is execution. Never merge a
  worker artifact you haven't built/tested.
- **Keep the wrapper cheap (Sonnet).** If a unit turns out to need claim-verification — the output is an
  *assertion about the system* rather than a runnable artifact — switch that unit to
  `two-layer-cross-model-expert` (run `ask_gpt` as `gpt-5.5` with `reasoning_effort: high`).
- **Write results incrementally** to a durable artifact so a mid-wave failure loses nothing.

---

## When to reach for it vs. the expert pattern

| Use **worker-orchestrator** (this) | Use **two-layer-cross-model-expert** |
|---|---|
| Concrete artifacts: patches, fixes, tests, repo inspection | Judgments: reviews, critiques, threat models, design calls |
| Correctness checked by **running it** | Correctness checked by **verifying claims vs ground truth** |
| Cheap **Sonnet** wrapper, **no** gate | Heavier wrapper **+** a verification gate |
| `ask_gpt` with a fast model | `ask_gpt` with `gpt-5.5` + `reasoning_effort: high` |

> **The reusable idea, in one line:** *fan concrete work out to a cheap wrapper around the GPT worker,
> and let execution — not a verification gate — be the thing that decides it's correct.*
