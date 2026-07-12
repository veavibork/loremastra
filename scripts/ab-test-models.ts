/**
 * Direct Featherless A/B test: sends the same tool-calling prompt to each candidate model
 * and compares latency, tool-call correctness, and output quality.
 *
 * Usage: FEATHERLESS_API_KEY=... npx tsx scripts/ab-test-models.ts
 */

import { FEATHERLESS_BASE_URL, FEATHERLESS_USER_AGENT } from "../src/inference/featherless-config.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const apiKey = process.env.FEATHERLESS_API_KEY;
if (!apiKey) {
  console.error("set FEATHERLESS_API_KEY");
  process.exit(1);
}

// ── Models under test ────────────────────────────────────────

const MODELS = {
  "1-slot": [
    "Qwen/Qwen2.5-Coder-7B-Instruct",
    "Qwen/Qwen2.5-7B-Instruct",
    "NousResearch/Hermes-4-14B",
    "NousResearch/Hermes-3-Llama-3.1-8B", // baseline
  ],
  "2-slot": [
    "Qwen/Qwen2.5-Coder-32B-Instruct",
    "Qwen/Qwen2.5-32B-Instruct",
  ],
};

// ── Prompt ────────────────────────────────────────────────────

const evalScript = readFileSync(join(import.meta.dirname ?? ".", "evaluate-worker-models.ts"), "utf-8");
const feathModels = readFileSync(join(import.meta.dirname ?? ".", "..", "src", "inference", "featherless-models.ts"), "utf-8");

const systemPrompt = `You are a precise technical analyst. Follow instructions exactly. Keep output under 200 words.`;

const userPrompt = `Analyze these two files and write your findings to test-results/<MODEL>-analysis.md.

## File 1: scripts/evaluate-worker-models.ts

\`\`\`typescript
${evalScript}
\`\`\`

## File 2: src/inference/featherless-models.ts

\`\`\`typescript
${feathModels}
\`\`\`

Write test-results/<MODEL>-analysis.md with exactly three sections using ## headers:
1. ## How listModels works — params, pagination, return shape
2. ## How the eval script uses it — filters, paging loop, scoring entry point
3. ## One improvement you would suggest

Keep the entire file under 200 words. Use proper Markdown. Call write_file exactly once.`;

const tools = [
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Write content to a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
];

// ── Fetch helper ──────────────────────────────────────────────

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface TurnResult {
  content: string | null;
  toolCalls: ToolCall[];
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

const BASE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "User-Agent": FEATHERLESS_USER_AGENT,
};

async function callModel(model: string): Promise<TurnResult> {
  const start = performance.now();

  const response = await fetch(`${FEATHERLESS_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      ...BASE_HEADERS,
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
      max_tokens: 2048,
      stream: false,
      tools,
      tool_choice: "auto",
    }),
  });

  const durationMs = Math.round(performance.now() - start);

  if (!response.ok) {
    const body = await response.text().catch(() => "(body unreadable)");
    throw new Error(`${model}: HTTP ${response.status} — ${body.slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{ id?: string | null; function?: { name?: string; arguments?: string } }>;
      };
    }>;
  };

  const msg = data.choices?.[0]?.message;
  const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((tc, idx) => {
    let args: Record<string, unknown> = {};
    try {
      args = tc.function?.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
    } catch { /* empty args */ }
    return { id: tc.id ?? `call_${idx}`, name: tc.function?.name ?? "", arguments: args };
  });

  return {
    content: msg?.content ?? null,
    toolCalls,
    durationMs,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
}

// ── Scoring ───────────────────────────────────────────────────

interface Score {
  model: string;
  tier: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  calledWriteFile: boolean;
  pathCorrect: boolean;
  hasAllSections: boolean;
  wordCount: number;
  errors: string[];
}

function scoreResult(model: string, tier: string, r: TurnResult): Score {
  const errors: string[] = [];
  const tc = r.toolCalls[0];

  const calledWriteFile = tc?.name === "write_file";
  if (!calledWriteFile) errors.push("did not call write_file");

  const path = String(tc?.arguments?.path ?? "");
  const pathExpected = `test-results/${model.split("/").pop()}-analysis.md`;
  const pathCorrect = path === pathExpected;
  if (!pathCorrect) errors.push(`wrong path: "${path}" (expected "${pathExpected}")`);

  const content = String(tc?.arguments?.content ?? "");
  const hasAllSections =
    content.includes("## How listModels works") &&
    content.includes("## How the eval script uses it") &&
    content.includes("## One improvement");
  if (!hasAllSections) errors.push("missing one or more required sections");

  const wordCount = content.split(/\s+/).filter(Boolean).length;

  return { model, tier, durationMs: r.durationMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens, calledWriteFile, pathCorrect, hasAllSections, wordCount, errors };
}

// ── Runner ────────────────────────────────────────────────────

async function main() {
  const allScores: Score[] = [];

  for (const [tier, models] of Object.entries(MODELS)) {
    for (const model of models) {
      console.error(`\nTesting ${model} (${tier})...`);
      try {
        const r = await callModel(model);
        const s = scoreResult(model, tier, r);
        allScores.push(s);
        const status = s.errors.length === 0 ? "PASS" : `FAIL: ${s.errors.join("; ")}`;
        console.error(`  ${status} | ${r.durationMs}ms | ${r.inputTokens}+${r.outputTokens} tok | ${s.wordCount}w`);
      } catch (err) {
        console.error(`  ERROR: ${String(err).slice(0, 200)}`);
        allScores.push({
          model, tier, durationMs: -1, inputTokens: 0, outputTokens: 0,
          calledWriteFile: false, pathCorrect: false, hasAllSections: false, wordCount: 0,
          errors: [String(err).slice(0, 200)],
        });
      }
    }
  }

  // ── Report ──────────────────────────────────────────────────
  console.log("\n## Results\n");
  console.log("| Model | Tier | ms | Tok IN | Tok OUT | Path ✓ | Sections ✓ | Words | Errors |");
  console.log("|-------|------|----|--------|---------|---------|-------------|-------|--------|");

  for (const s of allScores) {
    const short = s.model.split("/").pop() ?? s.model;
    const path = s.pathCorrect ? "✓" : "✗";
    const secs = s.hasAllSections ? "✓" : "✗";
    const errs = s.errors.length > 0 ? s.errors.join("; ") : "";
    console.log(`| ${short} | ${s.tier} | ${s.durationMs} | ${s.inputTokens} | ${s.outputTokens} | ${path} | ${secs} | ${s.wordCount} | ${errs} |`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});