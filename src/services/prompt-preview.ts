import type Database from "better-sqlite3";
import { assembleAuthorPrompt, estimateTokens } from "./history.js";
import { getAgentProfile } from "./agent-config.js";
import { STORY_TO_DATE_TRIGGER } from "./story-to-date.js";

export interface PromptPreviewMessage {
  role: "user" | "assistant" | "system";
  content: string;
  tokenEstimate: number;
  /** Set for verbose IC user/assistant turns only. */
  icPostNumber: number | null;
  /** Running sum of tokenEstimate through this message (inclusive). */
  cumulativeTokens: number;
}

export interface PromptPreview {
  messages: PromptPreviewMessage[];
  totalTokens: number;
  usableBudget: number;
  storyToDateTriggerAt: number;
}

export function buildPromptPreview(
  db: Database.Database,
  userId: string,
  logbookId: string,
  fromPageId: string | null
): PromptPreview {
  const messages = assembleAuthorPrompt(db, userId, logbookId, fromPageId);
  const author = getAgentProfile(userId, "author");
  const usableBudget = author.contextLimit - author.responseLimit;
  const storyToDateTriggerAt = Math.floor(usableBudget * STORY_TO_DATE_TRIGGER);

  let cumulative = 0;
  let icPost = 0;
  const enriched: PromptPreviewMessage[] = messages.map((m) => {
    const content = m.content ?? "";
    const tokenEstimate = estimateTokens(content);
    cumulative += tokenEstimate;

    let icPostNumber: number | null = null;
    if (m.role === "user" || m.role === "assistant") {
      icPost++;
      icPostNumber = icPost;
    }

    return {
      role: m.role as PromptPreviewMessage["role"],
      content,
      tokenEstimate,
      icPostNumber,
      cumulativeTokens: cumulative,
    };
  });

  return {
    messages: enriched,
    totalTokens: cumulative,
    usableBudget,
    storyToDateTriggerAt,
  };
}
