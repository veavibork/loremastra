/**
 * Raw Featherless stream dump — no tag assumptions, no field filtering.
 * Writes every SSE data line to stdout and to data/experiments/deepseek-raw-<timestamp>.jsonl
 *
 * Usage: npx tsx scripts/probe-deepseek-raw.ts
 */
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FEATHERLESS_BASE_URL, FEATHERLESS_USER_AGENT } from "../src/inference/featherless-config.js";

try {
  const envText = readFileSync(".env", "utf8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]!.replace(/^["']|["']$/g, "");
  }
} catch {
  /* ok */
}

const MODEL = process.env.PROBE_MODEL?.trim() || "deepseek-ai/DeepSeek-V4-Pro";
const apiKey = process.env.FEATHERLESS_API_KEY?.trim();
if (!apiKey) {
  console.error("set FEATHERLESS_API_KEY in .env");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.resolve("data/experiments/deepseek-raw");
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${stamp}.jsonl`);

function log(line: string): void {
  console.log(line);
  appendFileSync(outPath, line + "\n", "utf8");
}

/** Same assistant prefill production uses in streamWithFallback. */
const PREFILL = "<think>\n";

const messages = [
  {
    role: "system" as const,
    content:
      "You are a fantasy RPG narrator. Write 2 short in-character paragraphs. No meta commentary.",
  },
  { role: "user" as const, content: "The PC pushes open the tavern door and steps inside." },
];

const requestBody = {
  model: MODEL,
  messages: [...messages, { role: "assistant" as const, content: PREFILL }],
  temperature: 1,
  max_tokens: 600,
  stream: true,
};

log(`# probe started ${new Date().toISOString()}`);
log(`# model ${MODEL}`);
log(`# output file ${outPath}`);
log(`# request body (messages only):\n${JSON.stringify(messages, null, 2)}`);
log(`# assistant prefill (separate, exact bytes): ${JSON.stringify(PREFILL)}`);
log(`# POST ${FEATHERLESS_BASE_URL}/chat/completions`);
log("---");

const t0 = Date.now();
const res = await fetch(`${FEATHERLESS_BASE_URL}/chat/completions`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "User-Agent": FEATHERLESS_USER_AGENT,
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify(requestBody),
});

log(`# HTTP ${res.status} ${res.statusText} (+${Date.now() - t0}ms)`);
if (!res.ok) {
  log(await res.text());
  process.exit(1);
}
if (!res.body) {
  log("# no response body");
  process.exit(1);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let lineNo = 0;
let firstDataAt: number | null = null;

while (true) {
  const { value, done } = await reader.read();
  if (done) break;

  const chunk = decoder.decode(value, { stream: true });
  log(`# RAW_CHUNK +${Date.now() - t0}ms len=${chunk.length}\n${JSON.stringify(chunk)}`);

  buffer += chunk;
  const parts = buffer.split("\n");
  buffer = parts.pop() ?? "";

  for (const rawLine of parts) {
    lineNo++;
    log(`SSE_LINE ${lineNo} +${Date.now() - t0}ms ${JSON.stringify(rawLine)}`);

    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith(":")) continue;

    if (trimmed.startsWith("data:")) {
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        log(`DATA [DONE] +${Date.now() - t0}ms`);
        continue;
      }
      if (firstDataAt == null) firstDataAt = Date.now() - t0;
      // Log parsed JSON in full — every key the provider sent, not just delta.content
      try {
        const parsed = JSON.parse(payload);
        log(`DATA_JSON +${Date.now() - t0}ms\n${JSON.stringify(parsed, null, 2)}`);
      } catch {
        log(`DATA_PARSE_ERROR +${Date.now() - t0}ms ${JSON.stringify(payload)}`);
      }
    }
  }
}

if (buffer.trim()) {
  log(`# trailing buffer ${JSON.stringify(buffer)}`);
}

log(`---`);
log(`# first data line at +${firstDataAt ?? "?"}ms from request start`);
log(`# total wall ${Date.now() - t0}ms`);
log(`# done`);

writeFileSync(
  path.join(outDir, `${stamp}-meta.json`),
  JSON.stringify(
    {
      model: MODEL,
      firstDataMs: firstDataAt,
      wallMs: Date.now() - t0,
      prefill: PREFILL,
      messages,
      requestBody,
    },
    null,
    2
  ),
  "utf8"
);

console.error(`\nWrote ${outPath}`);
