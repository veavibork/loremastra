import type Database from "better-sqlite3";
import type { TextRole, TextRow } from "../db/text-store.js";
import { getPage, type PageRow } from "../db/page-store.js";
import { getText } from "../db/text-store.js";
import {
  buildContentBlockForWorker,
  compressPcGuidance,
  resolvePcInSummary,
  resolvePcNameFromContent,
} from "./worldbook-pc.js";

const PRIOR_PROSE_MESSAGES = 2;
const PRIOR_PROSE_MAX_CHARS = 180;

function plainMessageText(content: string): string {
  return content
    .replace(/<[^>]+>/g, " ")
    .replace(/\{\{\[(?:INPUT|OUTPUT|SYSTEM)\]\}\}/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripOuterQuotes(text: string): string {
  return text.replace(/^[\s"'""''`]+|[\s"'""''`]+$/g, "").trim();
}

export type CompressValidation = { ok: true } | { ok: false; reason: string };

/** Short acknowledgments — skip LLM (from lorepebble kai-log-index). */
export function tryTrivialCompress(content: string): { summary: string } | null {
  const plain = plainMessageText(content);
  if (!plain || plain.length > 160) return null;

  const words = plain.split(/\s+/).filter(Boolean);
  if (words.length > 22) return null;

  const trivialPatterns = [
    /^(thanks|thank you|thx|ty|ok(?:ay)?|sure|yes|no|please|sorry|got it|understood|see you|goodbye|bye|hello|hi|hey|welcome|absolutely|definitely|right|exactly|mhm|mmhm|lol|haha|nice|great|perfect|cool|awesome|sounds good)[!.?\s]*$/i,
    /^thanks for (having|inviting|letting|the|coming|showing)/i,
    /^(good\s+(morning|night|evening)|take care|drive safe)[!.?\s]*$/i,
  ];
  if (trivialPatterns.some((p) => p.test(plain))) {
    return { summary: plain };
  }

  return null;
}

/** Short player lines compress best verbatim (from lorepebble). */
export function tryShortVerbatimCompress(role: TextRole, content: string): { summary: string } | null {
  if (role !== "user") return null;
  const plain = plainMessageText(content);
  if (!plain || plain.length > 320) return null;

  const words = plain.split(/\s+/).filter(Boolean);
  if (words.length > 50) return null;

  const summary = plain.length > 280 ? `${plain.slice(0, 280)}…` : plain;
  return { summary };
}

export function validateCompressSummary(messageContent: string, summary: string, role: TextRole): CompressValidation {
  const plain = plainMessageText(messageContent);
  const sum = summary.trim();
  if (!plain || !sum) return { ok: true };

  const msgWords = plain.split(/\s+/).filter(Boolean).length;
  const sumWords = sum.split(/\s+/).filter(Boolean).length;
  const sumCore = stripOuterQuotes(sum);

  if (msgWords >= 60 && sumWords <= 15 && (plain.includes(sumCore) || plain.includes(sum))) {
    return { ok: false, reason: "summary_is_single_quoted_fragment" };
  }

  if (role === "agent" && msgWords >= 80 && sumWords < Math.min(20, Math.floor(msgWords * 0.08))) {
    return { ok: false, reason: "summary_too_short_for_narrative" };
  }

  if (
    role === "user" &&
    msgWords >= 8 &&
    plain.includes(sumCore) &&
    !plain.startsWith(sumCore.slice(0, Math.min(24, sumCore.length)))
  ) {
    return { ok: false, reason: "summary_drops_leading_user_content" };
  }

  if (/\{\{\[(?:INPUT|OUTPUT|SYSTEM)\]\}\}/i.test(sum)) {
    return { ok: false, reason: "summary_contains_instruct_markers" };
  }

  return { ok: true };
}

export function fallbackNarrativeSummary(content: string): string {
  const plain = plainMessageText(content);
  if (!plain) return "";

  const sentences =
    plain.match(/[^.!?…]+[.!?…]+(?:\s|$)|[^.!?…]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [plain];
  let out = "";
  for (const sentence of sentences) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (next.length > 300) break;
    out = next;
    if (out.split(/\s+/).length >= 35) break;
  }

  if (out.length >= 40) return out;
  return plain.length > 300 ? `${plain.slice(0, 300)}…` : plain;
}

export function compressRetryHint(reason: string): string {
  switch (reason) {
    case "summary_is_single_quoted_fragment":
      return "Your summary picked only one quoted line. Summarize the ENTIRE post: setting, actions, character introductions, and key dialogue — not just a single spoken sentence.";
    case "summary_too_short_for_narrative":
      return "Your summary is too short for this long narration. Cover the full post in one or two sentences.";
    case "summary_drops_leading_user_content":
      return "Your summary skipped the opening of the player line. Include every sentence from start to finish.";
    case "summary_contains_instruct_markers":
      return "Do not include {{[INPUT]}}, {{[OUTPUT]}}, or any template markers. Summarize the story prose only.";
    case "missing_summary_block":
      return "You must wrap the summary in [SUMMARY] and [/SUMMARY] tags.";
    default:
      return "Your summary did not cover the full target message. Try again covering the entire post.";
  }
}

export function sanitizeCompressResult(messageContent: string, result: { summary: string }): { summary: string } {
  const plain = plainMessageText(messageContent);
  const words = plain.split(/\s+/).filter(Boolean).length;
  let { summary } = result;

  if (!plain) return result;

  if (words <= 15 && summary.length > Math.max(plain.length * 2, plain.length + 80)) {
    summary = plain.length > 140 ? `${plain.slice(0, 140)}…` : plain;
  }

  summary = summary
    .replace(/\{\{\[(?:INPUT|OUTPUT|SYSTEM)\]\}\}/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return { summary };
}

/** KAI-style: prior prose turns for pronoun context — not prior compressed lines. */
function collectPriorProseSnippets(db: Database.Database, targetPage: PageRow): Array<{ role: TextRole; snippet: string }> {
  const snippets: Array<{ role: TextRole; snippet: string }> = [];
  let currentId: string | null = targetPage.prevPageId;

  while (currentId && snippets.length < PRIOR_PROSE_MESSAGES) {
    const page = getPage(db, currentId);
    if (!page?.selectedTextId) break;
    const text = getText(db, page.selectedTextId);
    if (text?.genPackage?.trim()) {
      const plain = plainMessageText(text.genPackage);
      const truncated = plain.length > PRIOR_PROSE_MAX_CHARS ? `${plain.slice(0, PRIOR_PROSE_MAX_CHARS)}…` : plain;
      snippets.unshift({ role: text.role, snippet: truncated });
    }
    currentId = page.prevPageId;
  }

  return snippets;
}

function roleLabel(role: TextRole): string {
  if (role === "agent") return "assistant";
  if (role === "user") return "user";
  return "system";
}

/** User-turn payload for the compress worker — target post plus CONTENT + prior prose context. */
export function buildCompressUserPrompt(db: Database.Database, targetText: TextRow, targetPage: PageRow): string {
  const plainTarget = plainMessageText(targetText.genPackage!);
  const wordCount = plainTarget.split(/\s+/).filter(Boolean).length;
  const pcName = resolvePcNameFromContent(db);
  const roleHint =
    targetText.role === "agent"
      ? "This is GM/narration — cover description, action, and dialogue beats across the entire post."
      : "This is a player line — include every sentence, including any opening reaction before questions.";

  let out = `${compressPcGuidance(pcName)}\n\n`;
  out += `Summarize ONLY the target post below. Do not summarize prior context or any other turn.\n`;
  out += `Target length: ~${wordCount} words. ${roleHint}\n\n`;

  const content = buildContentBlockForWorker(db);
  if (content) {
    out += `CONTENT (always-on worldbook — PC identity and setting live here):\n${content}\n\n`;
  }

  const priorSnippets = collectPriorProseSnippets(db, targetPage);
  if (priorSnippets.length) {
    out += `Prior context (reference only — do NOT summarize these):\n`;
    for (const { role, snippet } of priorSnippets) {
      out += `[${roleLabel(role)}]: ${snippet}\n`;
    }
    out += "\n";
  }

  out += `TARGET POST:\n>>> ${plainTarget}`;
  return out;
}

/** Apply PC third-person cleanup after compress generation. */
export function finalizeCompressSummary(db: Database.Database, summary: string): string {
  const pcName = resolvePcNameFromContent(db);
  if (!pcName) return summary;
  return resolvePcInSummary(summary, pcName);
}
