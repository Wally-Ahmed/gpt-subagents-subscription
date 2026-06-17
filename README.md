# gpt-subagents-subscription

An **unofficial** MCP server that exposes GPT "subagent" tools backed by your **ChatGPT subscription**
(via "Sign in with ChatGPT" OAuth) instead of a pay-per-use API key. Sibling to
[`gpt-subagents-api`](https://github.com/Wally-Ahmed/gpt-subagents-api) (which uses the official API key), and
it ships the same **orchestration patterns** system.

> ## ⚠️ Read this first
> This project talks to **undocumented** OpenAI endpoints (`auth.openai.com` + `chatgpt.com/backend-api/codex`)
> — the same ones Codex CLI's "Sign in with ChatGPT" uses — and reuses Codex's public OAuth `client_id`.
> - **Not affiliated with or endorsed by OpenAI.**
> - It **may violate OpenAI's Terms of Service** and could get your account **rate-limited or banned**.
> - The endpoints are unpublished and **can change or break at any time**.
> - **Use entirely at your own risk.** The official, stable path is an API key — see `gpt-subagents-api`.

---

## Tools

| Tool | What it does |
|------|--------------|
| `ask_gpt` | Ask a GPT model via your ChatGPT subscription. **You pick `model` and write `instructions` (the system prompt) every call — both required, no defaults.** Any valid model id is accepted; known suggestions: `gpt-5.4` (general), `gpt-5.4-mini` (faster/cheaper), `gpt-5.5` (deepest reasoning). Optional `reasoning_effort` (low/medium/high). |
| `check_usage` | Remaining ChatGPT/Codex subscription quota |
| `list_patterns` / `get_pattern` | Orchestration patterns for driving the model well (see below) |

> ⚠️ These models can be **confidently wrong**. Treat output as a *hypothesis* and verify against real
> files, docs, and tests — the orchestration patterns exist largely to make that automatic.

---

## Orchestration patterns

Patterns are reusable playbooks (Markdown in [`patterns/`](./patterns)) that describe *how* to drive
the expert tools — splitting work, bundling context, calling the expert, **verifying its output
against ground truth**, and aggregating. They're exposed via `list_patterns` (catalog) and
`get_pattern("<name>")` (full text), read from disk **at call time** (no rebuild to add one), and the
server's `instructions` nudge the agent to consult them before non-trivial expert work.

| name | what it does |
|------|--------------|
| [`two-layer-cross-model-expert`](./patterns/two-layer-cross-model-expert.md) | Wrap the GPT expert in verifying Claude subagents so the orchestrator only ever sees parallel, context-cheap, ground-truth-checked conclusions. |

A rendered diagram lives at [`patterns/html/two-layer-cross-model-expert.html`](./patterns/html/two-layer-cross-model-expert.html). See [`patterns/README.md`](./patterns/README.md) to add your own.

---

## Setup

Requires Node 18+ and an active ChatGPT subscription.

```bash
npm install
npm run build
npm run login     # prints a sign-in URL to open; sign in with ChatGPT (one-time)
```

`npm run login` runs an OAuth flow on `http://localhost:1455/auth/callback` and stores tokens at
`~/.gpt-subagents-subscription/auth.json` (mode `0600`, **never** committed). Run
`npm run login -- --logout` to clear them.

### Register with Claude Code

```bash
claude mcp add gpt-subagents-subscription -- node /absolute/path/to/gpt-subagents-subscription/dist/server.js
```

---

## How it works

1. `npm run login` → PKCE OAuth against `auth.openai.com` → tokens stored locally.
2. The MCP server reads and auto-refreshes those tokens.
3. Tool calls POST to `chatgpt.com/backend-api/codex/responses` with `Authorization: Bearer` +
   `ChatGPT-Account-Id`, using the Responses API schema.

---

## Security

- Tokens live outside the repo (`~/.gpt-subagents-subscription/`) and are gitignored everywhere.
- No credentials are committed; `.env.example` holds only optional model overrides.
- This project **never reads your existing `~/.codex/auth.json`** — it mints its own tokens.
- Local agent/editor state (`.mempalace/`, `.claude/`, `CLAUDE.local.md`, IDE folders) is gitignored.

---

## Credits / prior art

Reverse-engineering of the ChatGPT subscription flow is documented by the community, e.g.
[EvanZhouDev/openai-oauth](https://github.com/EvanZhouDev/openai-oauth) and various write-ups.

## License

ISC
