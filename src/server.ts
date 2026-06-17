import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { respond, getUsage } from "./client.js";
import { NotAuthenticatedError } from "./tokens.js";
import { listPatterns, getPattern, patternNames } from "./patterns.js";
import { SUPPORTED_MODELS } from "./config.js";

const server = new McpServer(
  { name: "gpt-subagents-subscription", version: "1.0.0" },
  {
    instructions: `
Delegate to GPT "expert" models powered by your ChatGPT subscription (via Sign in with ChatGPT),
not a pay-per-use API key.

- ask_gpt: ask a GPT model. You MUST choose \`model\` and write \`instructions\` (its system prompt) explicitly every call — there are no defaults:
  - gpt-5.4: capable general-purpose (coding, analysis).
  - gpt-5.4-mini: faster / cheaper, for lighter tasks.
  - gpt-5.5: deepest reasoning — architecture, security/threat modeling, hard review.
  Set reasoning_effort "high" for deep audits. Models may be confidently wrong — treat output as a
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
  "ask_gpt",
  "Ask a GPT model via your ChatGPT subscription. You must choose `model` explicitly AND write `instructions` (the model's system prompt) yourself — there are no defaults. Use gpt-5.4 for general work, gpt-5.4-mini for faster/cheaper light tasks, and gpt-5.5 (with reasoning_effort 'high') for architecture, security/threat modeling, and hard review. Treat output as a hypothesis to verify.",
  {
    model: z
      .enum(SUPPORTED_MODELS)
      .describe(
        "Which model to use (required, no default): gpt-5.4 (general), gpt-5.4-mini (faster/cheaper), gpt-5.5 (deepest reasoning)"
      ),
    instructions: z
      .string()
      .describe(
        "System instructions for the model (required, no default): its role, persona, and how to respond. Write these explicitly for the task at hand."
      ),
    prompt: z.string().describe("The task or question for the model"),
    reasoning_effort: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe("Reasoning effort (higher = deeper but slower). Best with gpt-5.5 for hard tasks."),
    context: z
      .string()
      .optional()
      .describe("Code, errors, constraints, or other relevant context"),
  },
  async ({ model, instructions, prompt, reasoning_effort, context }) => {
    try {
      const input = context ? `${prompt}\n\nContext:\n${context}` : prompt;
      const text = await respond({ model, instructions, input, reasoningEffort: reasoning_effort });
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
  "Return the full text of an orchestration pattern by name (see list_patterns). Use it to apply the pattern when orchestrating ask_gpt calls.",
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
