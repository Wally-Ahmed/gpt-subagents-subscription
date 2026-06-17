import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { respond, getUsage } from "./client.js";
import { NotAuthenticatedError } from "./tokens.js";
import { listPatterns, getPattern, patternNames } from "./patterns.js";
import { DEFAULT_CODEX_MODEL, DEFAULT_ARCHITECT_MODEL } from "./config.js";

const server = new McpServer(
  { name: "gpt-subagents-subscription", version: "1.0.0" },
  {
    instructions: `
Delegate to GPT "expert" models powered by your ChatGPT subscription (via Sign in with ChatGPT),
not a pay-per-use API key.

- ask_gpt_codex (${DEFAULT_CODEX_MODEL}): routine coding — patches, debugging, tests, repo inspection.
- ask_gpt_architect (${DEFAULT_ARCHITECT_MODEL}, high reasoning): architecture, security/threat
  modeling, review of large/high-risk changes. May be confidently wrong — treat output as a
  hypothesis and verify against real files, docs, and tests.
- check_usage: remaining ChatGPT/Codex subscription quota.

ORCHESTRATION PATTERNS: Before any non-trivial use of these experts (code or security review, design
critique, threat modeling, large-document analysis — anything whose output you would act on), call
list_patterns and apply the most relevant pattern, then read it in full with get_pattern. Patterns
keep expert output parallel, context-cheap, and verified against ground truth.

UNOFFICIAL: this uses undocumented OpenAI endpoints and may break or violate ToS. If a tool reports
"not authenticated", run \`npm run login\` once to sign in.
    `.trim(),
  }
);

function errorText(err: unknown): string {
  if (err instanceof NotAuthenticatedError) return err.message;
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}

server.tool(
  "ask_gpt_codex",
  `Ask ${DEFAULT_CODEX_MODEL} (via your ChatGPT subscription) to handle a coding task: patches, debugging, tests, repo inspection.`,
  {
    task: z.string().describe("The coding task to perform"),
    context: z
      .string()
      .optional()
      .describe("Code, errors, stack traces, or other relevant context"),
  },
  async ({ task, context }) => {
    try {
      const input = context ? `Task:\n${task}\n\nContext:\n${context}` : `Task:\n${task}`;
      const text = await respond({ model: DEFAULT_CODEX_MODEL, input });
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: errorText(err) }], isError: true };
    }
  }
);

server.tool(
  "ask_gpt_architect",
  `Ask ${DEFAULT_ARCHITECT_MODEL} (via your ChatGPT subscription, high reasoning) for architecture, security/threat modeling, or review of high-risk changes. Treat output as a hypothesis to verify.`,
  {
    question: z.string().describe("The architecture, design, or reasoning question"),
    context: z
      .string()
      .optional()
      .describe("Relevant code, constraints, or prior analysis"),
  },
  async ({ question, context }) => {
    try {
      const input = context
        ? `Question:\n${question}\n\nContext:\n${context}`
        : `Question:\n${question}`;
      const text = await respond({
        model: DEFAULT_ARCHITECT_MODEL,
        input,
        reasoningEffort: "high",
      });
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: errorText(err) }], isError: true };
    }
  }
);

server.tool(
  "check_usage",
  "Show remaining ChatGPT/Codex subscription quota for the signed-in account.",
  {},
  async () => {
    try {
      return { content: [{ type: "text" as const, text: await getUsage() }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: errorText(err) }], isError: true };
    }
  }
);

server.tool(
  "list_patterns",
  "List available orchestration patterns for driving the GPT subagents. Call this before non-trivial expert work — reviews, audits, threat modeling, large analysis — then read the chosen one with get_pattern. Returns each pattern's name, title, summary, and when to use it.",
  {},
  async () => {
    const patterns = listPatterns();
    if (patterns.length === 0) {
      return { content: [{ type: "text" as const, text: "No patterns found." }] };
    }
    const text = patterns
      .map(
        (p) => `- ${p.name} — ${p.title}\n  Summary: ${p.summary}\n  Use when: ${p.use_when}`
      )
      .join("\n\n");
    return {
      content: [
        {
          type: "text" as const,
          text: `Available orchestration patterns (read one in full with get_pattern):\n\n${text}`,
        },
      ],
    };
  }
);

server.tool(
  "get_pattern",
  "Return the full text of an orchestration pattern by name (see list_patterns). Use it to apply the pattern when orchestrating ask_gpt_codex / ask_gpt_architect calls.",
  {
    name: z
      .string()
      .describe("The pattern name from list_patterns, e.g. 'two-layer-cross-model-expert'"),
  },
  async ({ name }) => {
    const pattern = getPattern(name);
    if (!pattern) {
      const available = patternNames();
      const list = available.length ? available.join(", ") : "(none found)";
      return {
        content: [
          { type: "text" as const, text: `No pattern named "${name}". Available patterns: ${list}` },
        ],
      };
    }
    return {
      content: [{ type: "text" as const, text: `# ${pattern.title}\n\n${pattern.body}` }],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("gpt-subagents-subscription MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
