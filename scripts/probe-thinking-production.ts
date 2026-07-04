/**
 * Probe enable_thinking:true with a real assembleAuthorPrompt payload.
 * Compares Author (DeepSeek) vs Worker (Hermes) stream shapes.
 *
 * Usage:
 *   npx tsx scripts/probe-thinking-production.ts
 *   PROBE_REPEAT=3 npx tsx scripts/probe-thinking-production.ts   # repeat enable_thinking:true
 *   PROBE_ONLY=author_enable_thinking_false npx tsx scripts/probe-thinking-production.ts
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { getGlobalDb } from "../src/db/global-db.js";
import { getStoryDb, closeStoryDb } from "../src/db/story-db.js";
import { getStory } from "../src/db/story-store.js";
import { getBookByType } from "../src/db/book-store.js";
import { findHeadPageId } from "../src/db/page-store.js";
import { assembleAuthorPrompt } from "../src/services/history.js";
import { estimateMessageTokens, isReasoningModel } from "../src/inference/featherless.js";
import type { ChatMessage } from "../src/inference/featherless.js";
import { FEATHERLESS_BASE_URL, FEATHERLESS_USER_AGENT } from "../src/inference/featherless-config.js";

try {
  process.loadEnvFile();
} catch {
  /* ok */
}

function looksMetaReasoning(text: string): boolean {
  return /\b(should|therefore|I need|the PC|content register|write|respond|scene|NPC|GM|meta|user wants)\b/i.test(text);
}

function looksProseLike(text: string): boolean {
  const t = text.trim();
  if (t.length < 80) return false;
  return /^The [A-Z]|^"[A-Za-z]|^Suki|^Sloane|^Lex|\b(said|looked|stepped|turned|admits|murmurs)\b/i.test(t);
}

const STORY_ID = process.env.PROBE_STORY?.trim() ?? "019f25e0-219c-7189-b481-9f389a9a3c39";
const MAX_TOKENS = Number(process.env.PROBE_MAX_TOKENS ?? "500");
const WALL_MS = Number(process.env.PROBE_WALL_MS ?? "300000");
const GAP_MS = Number(process.env.PROBE_GAP_MS ?? "8000");
const PREFILL = "<think>\n";
const apiKey = process.env.FEATHERLESS_API_KEY?.trim();
if (!apiKey) {
  console.error("set FEATHERLESS_API_KEY in .env");
  process.exit(1);
}

interface Case {
  id: string;
  model: string;
  prefill: boolean;
  chatTemplateKwargs?: Record<string, unknown>;
}

interface RunResult {
  id: string;
  model: string;
  httpStatus: number;
  wallMs: number;
  promptTokenEstimate: number;
  messageCount: number;
  firstReasoningMs: number | null;
  firstContentMs: number | null;
  reasoningChars: number;
  contentChars: number;
  reasoningPreview: string;
  contentPreview: string;
  wouldRetry: boolean;
  retryReason: string | null;
  deltaKeys: Record<string, number>;
  usage: unknown;
  error?: string;
}

const PROMPT_LOG =
  process.env.PROBE_PROMPT_LOG?.trim() ??
  (existsSync(path.resolve("data/outbound-requests-vm.log"))
    ? path.resolve("data/outbound-requests-vm.log")
    : path.resolve("data/outbound-requests.log"));

function trimToContextBudget(messages: ChatMessage[], contextLimit: number, maxOutput: number): ChatMessage[] {
  const budget = contextLimit - maxOutput - 256;
  if (estimateMessageTokens(messages) <= budget) return messages;
  const pinned: ChatMessage[] = [];
  const verbose: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "user" || m.role === "assistant") verbose.push(m);
    else pinned.push(m);
  }
  while (verbose.length > 1 && estimateMessageTokens([...pinned, ...verbose]) > budget) {
    verbose.shift();
  }
  return [...pinned, ...verbose];
}

function loadFromOutboundLogEntry(): { messages: ChatMessage[]; source: string } {
  if (!existsSync(PROMPT_LOG)) throw new Error(`no prompt log at ${PROMPT_LOG}`);
  const lines = readFileSync(PROMPT_LOG, "utf8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const row = JSON.parse(lines[i]!) as { call?: string; messages?: ChatMessage[] };
      if (row.call === "streamInference" && row.messages?.length) {
        const msgs = [...row.messages];
        const last = msgs[msgs.length - 1];
        if (last?.role === "assistant" && last.content?.startsWith("<think>")) msgs.pop();
        return {
          messages: trimToContextBudget(msgs, 32768, MAX_TOKENS),
          source: `${PROMPT_LOG} (latest streamInference)`,
        };
      }
    } catch {
      /* skip bad line */
    }
  }
  throw new Error(`no streamInference entry in ${PROMPT_LOG}`);
}

function loadProductionMessages(): { messages: ChatMessage[]; source: string } {
  if (process.env.PROBE_USE_OUTBOUND !== "0" && existsSync(PROMPT_LOG)) {
    try {
      return loadFromOutboundLogEntry();
    } catch (err) {
      console.warn(`outbound log load failed (${err instanceof Error ? err.message : err}) — trying story db`);
    }
  }
  try {
    const globalDb = getGlobalDb();
    const story = getStory(globalDb, STORY_ID);
    if (!story) throw new Error("story not found");
    const db = getStoryDb(STORY_ID);
    try {
      const logbook = getBookByType(db, "logbook");
      if (!logbook) throw new Error("logbook missing");
      const headId = findHeadPageId(db, logbook.id);
      const messages = trimToContextBudget(
        assembleAuthorPrompt(db, story.ownerUserId, logbook.id, headId),
        32768,
        MAX_TOKENS
      );
      return { messages, source: `assembleAuthorPrompt(${STORY_ID})` };
    } finally {
      closeStoryDb(STORY_ID);
    }
  } catch (err) {
    console.warn(`story db load failed (${err instanceof Error ? err.message : err}) — using outbound log`);
    return loadFromOutboundLogEntry();
  }
}

async function runCase(baseMessages: ChatMessage[], c: Case): Promise<RunResult> {
  const wireMessages = c.prefill
    ? [...baseMessages, { role: "assistant" as const, content: PREFILL }]
    : baseMessages;

  const promptTokenEstimate = estimateMessageTokens(wireMessages);
  const body: Record<string, unknown> = {
    model: c.model,
    messages: wireMessages,
    temperature: 1,
    max_tokens: MAX_TOKENS,
    stream: true,
    ...(c.chatTemplateKwargs && Object.keys(c.chatTemplateKwargs).length
      ? { chat_template_kwargs: c.chatTemplateKwargs }
      : {}),
  };

  const t0 = Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`wall timeout ${WALL_MS}ms`)), WALL_MS);

  let firstReasoningMs: number | null = null;
  let firstContentMs: number | null = null;
  let reasoning = "";
  let content = "";
  const deltaKeys: Record<string, number> = {};
  let usage: unknown = null;

  try {
    const res = await fetch(`${FEATHERLESS_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": FEATHERLESS_USER_AGENT,
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: abort.signal,
    });

    if (!res.ok || !res.body) {
      return {
        id: c.id,
        model: c.model,
        httpStatus: res.status,
        wallMs: Date.now() - t0,
        promptTokenEstimate,
        messageCount: wireMessages.length,
        firstReasoningMs: null,
        firstContentMs: null,
        reasoningChars: 0,
        contentChars: 0,
        reasoningPreview: "",
        contentPreview: "",
        wouldRetry: false,
        retryReason: null,
        deltaKeys: {},
        usage: null,
        error: await res.text(),
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: Record<string, unknown> }>;
            usage?: unknown;
          };
          if (parsed.usage) usage = parsed.usage;
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;
          for (const key of Object.keys(delta)) {
            if (delta[key] != null) deltaKeys[key] = (deltaKeys[key] ?? 0) + 1;
          }
          const ms = Date.now() - t0;
          const r =
            (typeof delta.reasoning === "string" ? delta.reasoning : "") ||
            (typeof delta.reasoning_content === "string" ? delta.reasoning_content : "");
          if (r) {
            reasoning += r;
            if (firstReasoningMs == null) firstReasoningMs = ms;
          }
          if (typeof delta.content === "string") {
            content += delta.content;
            if (firstContentMs == null) firstContentMs = ms;
          }
        } catch {
          /* ignore */
        }
      }
    }

    const sawReasoning = reasoning.trim().length > 0;
    const hasContent = content.trim().length > 0;
    let wouldRetry = false;
    let retryReason: string | null = null;
    if (!hasContent && sawReasoning) {
      wouldRetry = true;
      retryReason = "reasoning but no answer content";
    } else if (!hasContent && !sawReasoning) {
      wouldRetry = true;
      retryReason = "empty completion";
    }

    return {
      id: c.id,
      model: c.model,
      httpStatus: res.status,
      wallMs: Date.now() - t0,
      promptTokenEstimate,
      messageCount: wireMessages.length,
      firstReasoningMs,
      firstContentMs,
      reasoningChars: reasoning.length,
      contentChars: content.length,
      reasoningPreview: reasoning.slice(0, 600).replace(/\s+/g, " "),
      contentPreview: content.slice(0, 600).replace(/\s+/g, " "),
      wouldRetry,
      retryReason,
      deltaKeys,
      usage,
    };
  } catch (err) {
    return {
      id: c.id,
      model: c.model,
      httpStatus: 0,
      wallMs: Date.now() - t0,
      promptTokenEstimate,
      messageCount: wireMessages.length,
      firstReasoningMs: null,
      firstContentMs: null,
      reasoningChars: reasoning.length,
      contentChars: content.length,
      reasoningPreview: reasoning.slice(0, 600).replace(/\s+/g, " "),
      contentPreview: content.slice(0, 600).replace(/\s+/g, " "),
      wouldRetry: reasoning.trim() && !content.trim() ? true : false,
      retryReason: reasoning.trim() && !content.trim() ? "reasoning but no answer content (partial)" : null,
      deltaKeys,
      usage,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

const { messages, source } = loadProductionMessages();
const authorModel = process.env.AUTHOR_MODEL?.trim() ?? "deepseek-ai/DeepSeek-V4-Pro";
const REPEAT_TRUE = Number(process.env.PROBE_REPEAT ?? "3");
const authorPrefill = isReasoningModel(authorModel);

function authorCase(id: string, chatTemplateKwargs?: Record<string, unknown>): Case {
  return { id, model: authorModel, prefill: authorPrefill, chatTemplateKwargs };
}

const allCases: Case[] = [
  authorCase("author_enable_thinking_false", { enable_thinking: false }),
  authorCase("author_thinking_budget_100", { thinking_budget: 100 }),
  authorCase("author_enable_thinking_false_budget_100", { enable_thinking: false, thinking_budget: 100 }),
  authorCase("author_baseline_prefill"),
  ...Array.from({ length: REPEAT_TRUE }, (_, i) =>
    authorCase(`author_enable_thinking_true_${i + 1}`, { enable_thinking: true })
  ),
];

const only = process.env.PROBE_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);
const cases = only?.length ? allCases.filter((c) => only.includes(c.id)) : allCases;

console.log(`story=${STORY_ID} source=${source} messages=${messages.length} max_tokens=${MAX_TOKENS}`);
console.log(`prompt token estimate≈${estimateMessageTokens(messages)}\n`);

const results: RunResult[] = [];
for (const c of cases) {
  process.stderr.write(`running ${c.id} (${c.model})… `);
  const result = await runCase(messages, c);
  results.push(result);
  process.stderr.write(`${result.wouldRetry ? "RETRY" : "ok"} (${result.wallMs}ms)\n`);
  await new Promise((r) => setTimeout(r, GAP_MS));
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.resolve("data/experiments/thinking-kwargs");
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `production-${stamp}.json`);
writeFileSync(
  outPath,
  JSON.stringify({ storyId: STORY_ID, promptSource: source, maxTokens: MAX_TOKENS, cases: cases.map((c) => c.id), results }, null, 2),
  "utf8"
);

console.log("\n=== SUMMARY ===\n");
for (const r of results) {
  console.log(`## ${r.id}`);
  console.log(`  model: ${r.model}`);
  if (r.error) {
    console.log(`  ERROR: ${r.error.slice(0, 300)}`);
    continue;
  }
  console.log(`  prompt≈${r.promptTokenEstimate} tokens, ${r.messageCount} messages`);
  console.log(`  delta keys: ${JSON.stringify(r.deltaKeys)}`);
  console.log(`  timing: reasoning@${r.firstReasoningMs ?? "—"} content@${r.firstContentMs ?? "—"} wall=${r.wallMs}ms`);
  console.log(`  chars: reasoning=${r.reasoningChars} content=${r.contentChars}`);
  console.log(`  wouldRetry: ${r.wouldRetry}${r.retryReason ? ` (${r.retryReason})` : ""}`);
  if (r.reasoningPreview) {
    console.log(
      `  reasoning style: meta=${looksMetaReasoning(r.reasoningPreview)} prose-like=${looksProseLike(r.reasoningPreview)}`
    );
    console.log(`  reasoning▸ ${r.reasoningPreview}`);
  }
  if (r.contentPreview) console.log(`  content▸ ${r.contentPreview}`);
  if (r.usage) console.log(`  usage: ${JSON.stringify(r.usage)}`);
  console.log();
}

console.error(`\nWrote ${outPath}`);
