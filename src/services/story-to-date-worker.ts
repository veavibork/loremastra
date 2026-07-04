import type Database from "better-sqlite3";
import type { ChatMessage } from "../inference/featherless.js";
import { completeChat } from "../inference/featherless.js";
import { fillStoryToDateSegment, getStoryToDateSegment, listStoryToDateSegments } from "../db/story-to-date-store.js";
import { getAgentProfile } from "./agent-config.js";
import {
  buildDefaultBeginsSystemPrompt,
  buildDefaultContinuesSystemPrompt,
  buildSeamRetryUserMessage,
  buildStoryCorpus,
  extractCoverage,
  extractStoryBlock,
  formatCorpusForEditor,
  mergeStoryToDate,
  shouldRetrySeamGate,
  stripStoryToDateWrapper,
  type StoryBlockKind,
  type StoryToDateSegment,
  type VerbosePost,
} from "./story-to-date-corpus.js";
import { STORY_TO_DATE_INPUT_CUTOFF } from "./story-to-date.js";

const MAX_ATTEMPTS = 2;

function findPostByIcNumber(posts: VerbosePost[], icPostNumber: number): VerbosePost | undefined {
  return posts.find((p) => p.icPostNumber === icPostNumber);
}

function buildMessages(
  db: Database.Database,
  storyId: string,
  logbookId: string,
  kind: StoryBlockKind,
  editorUserId: string,
  priorSegments: StoryToDateSegment[]
): { messages: ChatMessage[]; corpus: ReturnType<typeof buildStoryCorpus> } {
  const editor = getAgentProfile(editorUserId, "editor");
  const priorStoryToDate =
    kind === "continues" ? mergeStoryToDate(priorSegments) : undefined;
  const lastCoverage = priorSegments.length
    ? priorSegments[priorSegments.length - 1]?.coveragePageId
    : null;
  const priorCoveragePost = priorSegments.length
    ? priorSegments[priorSegments.length - 1]?.coverageThroughPost ?? null
    : null;

  const corpus = buildStoryCorpus(db, storyId, logbookId, {
    contextLimit: editor.contextLimit,
    responseLimit: editor.responseLimit,
    inputCutoff: STORY_TO_DATE_INPUT_CUTOFF,
    afterPageId: kind === "continues" ? lastCoverage : null,
    priorStoryToDate,
  });

  const corpusText = formatCorpusForEditor(corpus, corpus.includedPosts, true);
  const system =
    kind === "begins"
      ? buildDefaultBeginsSystemPrompt(corpus.inputCeilingPost)
      : buildDefaultContinuesSystemPrompt(corpus.inputCeilingPost, priorCoveragePost);

  const user =
    kind === "begins"
      ? `Compress the following into [STORY BEGINS]:\n\n${corpusText}`
      : `[STORY TO DATE]\n${stripStoryToDateWrapper(priorStoryToDate?.trim() || "(empty)")}\n\nNew log prose to fold in:\n\n${corpusText}`;

  return {
    corpus,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
}

interface ParsedResponse {
  raw: string;
  block: string;
  coverageThroughPost: number;
}

function parseResponse(raw: string, kind: StoryBlockKind): ParsedResponse | null {
  const block = extractStoryBlock(raw, kind);
  const coverageThroughPost = extractCoverage(raw);
  if (!block || coverageThroughPost == null) return null;
  return { raw, block, coverageThroughPost };
}

export async function executeStoryToDateJob(
  db: Database.Database,
  userId: string,
  storyId: string,
  logbookId: string,
  segmentId: string,
  apiKey: string
): Promise<void> {
  const segmentRow = getStoryToDateSegment(db, segmentId);
  if (!segmentRow || segmentRow.broken) throw new Error("story-to-date segment missing or broken");
  if (segmentRow.content?.trim()) throw new Error("segment already filled");

  const kind = segmentRow.kind;
  const priorRows = listStoryToDateSegments(db, logbookId)
    .filter((s) => s.seq < segmentRow.seq && s.content?.trim() && !s.broken)
    .sort((a, b) => a.seq - b.seq);
  const priorSegments: StoryToDateSegment[] = priorRows.map((s) => ({
    kind: s.kind,
    content: s.content!.trim(),
    coverageThroughPost: s.coverageThroughIcPost ?? 0,
    coveragePageId: s.coveragePageId,
  }));

  const { messages, corpus } = buildMessages(db, storyId, logbookId, kind, userId, priorSegments);
  const editor = getAgentProfile(userId, "editor");

  let parsed: ParsedResponse | null = null;
  let lastError = "unknown error";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !parsed; attempt++) {
    try {
      let raw = await completeChat(editor, apiKey, messages, { maxTokens: editor.responseLimit });
      let candidate = parseResponse(raw, kind);

      if (
        candidate &&
        corpus.inputCeilingPost != null &&
        shouldRetrySeamGate(candidate.coverageThroughPost, corpus.inputCeilingPost)
      ) {
        const retryMessages: ChatMessage[] = [
          ...messages,
          { role: "assistant", content: raw },
          {
            role: "user",
            content: buildSeamRetryUserMessage(kind, candidate.coverageThroughPost, corpus.inputCeilingPost),
          },
        ];
        const retryRaw = await completeChat(editor, apiKey, retryMessages, { maxTokens: editor.responseLimit });
        const retryParsed = parseResponse(retryRaw, kind);
        if (
          retryParsed &&
          retryParsed.coverageThroughPost < candidate.coverageThroughPost &&
          retryParsed.coverageThroughPost <= (corpus.inputCeilingPost ?? Infinity)
        ) {
          candidate = retryParsed;
        }
      }

      if (!candidate) {
        lastError = "missing block or coverage";
        continue;
      }
      if (corpus.inputCeilingPost != null && candidate.coverageThroughPost > corpus.inputCeilingPost) {
        lastError = `coverage ${candidate.coverageThroughPost} exceeds ceiling ${corpus.inputCeilingPost}`;
        continue;
      }
      const coveragePost = findPostByIcNumber(corpus.includedPosts, candidate.coverageThroughPost);
      if (!coveragePost) {
        lastError = `coverage post ${candidate.coverageThroughPost} not in input`;
        continue;
      }
      if (kind === "continues" && priorSegments.length) {
        const priorCov = priorSegments[priorSegments.length - 1]!.coverageThroughPost;
        if (candidate.coverageThroughPost <= priorCov) {
          lastError = `coverage must advance beyond ${priorCov}`;
          continue;
        }
      }

      fillStoryToDateSegment(db, segmentId, {
        content: candidate.block,
        coverageThroughIcPost: candidate.coverageThroughPost,
        coveragePageId: coveragePost.pageId,
        inputCeilingIcPost: corpus.inputCeilingPost ?? candidate.coverageThroughPost,
        inputCeilingPageId: corpus.inputCeilingPageId ?? coveragePost.pageId,
      });
      parsed = candidate;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  if (!parsed) throw new Error(`story-to-date failed: ${lastError}`);
}
