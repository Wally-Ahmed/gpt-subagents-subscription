import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Compiled to <pkg>/dist/patterns.js, so the patterns/ folder is one level up.
const PATTERNS_DIR = resolve(__dirname, "..", "patterns");

export type PatternMeta = {
  name: string;
  title: string;
  summary: string;
  use_when: string;
};

export type Pattern = PatternMeta & { body: string };

// Minimal single-line `key: value` frontmatter parser. Avoids a dependency —
// pattern frontmatter is intentionally simple (one line per field).
function parseFrontmatter(raw: string): {
  meta: Record<string, string>;
  body: string;
} {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value;
  }
  return { meta, body: match[2].trim() };
}

// A file counts as a pattern only if it declares frontmatter with a `name`.
// Keeps stray Markdown (notes, CLAUDE.local.md, etc.) out of the catalog.
function loadPattern(file: string): Pattern | null {
  const raw = readFileSync(join(PATTERNS_DIR, file), "utf8");
  const { meta, body } = parseFrontmatter(raw);
  if (!meta.name) return null;
  return {
    name: meta.name,
    title: meta.title || meta.name,
    summary: meta.summary || "",
    use_when: meta.use_when || "",
    body,
  };
}

// Patterns are read fresh on each call, so adding or editing one needs no
// rebuild. README.md is the folder's own docs; the html/ subfolder and other
// non-.md entries are ignored automatically.
function loadAll(): Pattern[] {
  let files: string[];
  try {
    files = readdirSync(PATTERNS_DIR).filter(
      (f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md"
    );
  } catch {
    return [];
  }
  return files
    .sort()
    .map(loadPattern)
    .filter((p): p is Pattern => p !== null);
}

export function listPatterns(): PatternMeta[] {
  return loadAll().map(({ name, title, summary, use_when }) => ({
    name,
    title,
    summary,
    use_when,
  }));
}

export function getPattern(name: string): Pattern | null {
  const target = name.trim().toLowerCase();
  return loadAll().find((p) => p.name.toLowerCase() === target) || null;
}

export function patternNames(): string[] {
  return loadAll().map((p) => p.name);
}
