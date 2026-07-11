import type Database from "better-sqlite3";
import type { ChatMessage } from "../inference/featherless.js";
import { completeChat } from "../inference/featherless.js";
import { fillStoryToDateSegment, getStoryToDateSegment, listStoryToDateSegments } from "../db/story-to-date-store.js";
import { getAgentProfile } from "./agent-config.js";
import { STORY_TO_DATE_FOLD_TIMEOUT_MS } from "./story-to-date-fold-worker.js";
import {
  buildDefaultBeginsSystemPrompt,
  buildCoverageSprintRetryUserMessage,
  buildNextSceneContinuesSystemPrompt,
  buildSeamRetryUserMessage,
  buildStoryCorpus,
  extractCoverage,
  extractStoryBlock,
  formatCorpusForEditor,
  mergeStoryToDate,
  hasLeakedStoryMarkers,
  looksNextSceneCoverageSprint,
  sanitizeStoryBlockContent,
  shouldRetrySeamGate,
  STORY_BLOCK_DUPLICATE_OVERLAP_THRESHOLD,
  storyBlockWordCount,
  storyBlockWordOverlapRatio,
  stripStoryToDateWrapper,
  type StoryBlockKind,
  type StoryToDateSegment,
  type VerbosePost,
} from "./story-to-date-corpus.js";
import { STORY_TO_DATE_INPUT_CUTOFF } from "./story-to-date.js";
import { buildChainPostIndex } from "./post-index.js";

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
      : buildNextSceneContinuesSystemPrompt(corpus.inputCeilingPost, priorCoveragePost);

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
  apiKey: string,
  signal?: AbortSignal
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
      let raw = await completeChat(editor, apiKey, messages, {
        maxTokens: editor.responseLimit,
        timeoutMs: STORY_TO_DATE_FOLD_TIMEOUT_MS,
        signal,
      });
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
        const retryRaw = await completeChat(editor, apiKey, retryMessages, {
          maxTokens: editor.responseLimit,
          timeoutMs: STORY_TO_DATE_FOLD_TIMEOUT_MS,
          signal,
        });
        const retryParsed = parseResponse(retryRaw, kind);
        if (
          retryParsed &&
          retryParsed.coverageThroughPost < candidate.coverageThroughPost &&
          retryParsed.coverageThroughPost <= (corpus.inputCeilingPost ?? Infinity)
        ) {
          candidate = retryParsed;
          raw = retryRaw;
        }
      }

      if (candidate && kind === "continues" && priorSegments.length) {
        const priorCov = priorSegments[priorSegments.length - 1]!.coverageThroughPost;
        const delta = candidate.coverageThroughPost - priorCov;
        if (looksNextSceneCoverageSprint(candidate.block, delta)) {
          const sprintMessages: ChatMessage[] = [
            ...messages,
            { role: "assistant", content: raw },
            {
              role: "user",
              content: buildCoverageSprintRetryUserMessage(
                kind,
                candidate.coverageThroughPost,
                priorCov
              ),
            },
          ];
          const sprintRaw = await completeChat(editor, apiKey, sprintMessages, {
            maxTokens: editor.responseLimit,
            timeoutMs: STORY_TO_DATE_FOLD_TIMEOUT_MS,
            signal,
          });
          const sprintParsed = parseResponse(sprintRaw, kind);
          if (sprintParsed) {
            const sprintBlock = sanitizeStoryBlockContent(sprintParsed.block);
            const sprintDelta = sprintParsed.coverageThroughPost - priorCov;
            if (
              sprintBlock &&
              sprintParsed.coverageThroughPost < candidate.coverageThroughPost &&
              !looksNextSceneCoverageSprint(sprintBlock, sprintDelta)
            ) {
              candidate = { ...sprintParsed, block: sprintBlock };
            }
          }
        }
      }

      if (!candidate) {
        lastError = "missing block or coverage";
        continue;
      }

      candidate = {
        ...candidate,
        block: sanitizeStoryBlockContent(candidate.block),
      };
      if (!candidate.block) {
        lastError = "empty block after sanitization";
        continue;
      }
      if (hasLeakedStoryMarkers(candidate.block)) {
        lastError = "block still contains leaked story markers after sanitization";
        continue;
      }

      if (kind === "continues" && priorSegments.length) {
        const priorBlock = priorSegments[priorSegments.length - 1]!.content;
        const overlap = storyBlockWordOverlapRatio(candidate.block, priorBlock);
        if (overlap >= STORY_BLOCK_DUPLICATE_OVERLAP_THRESHOLD) {
          lastError = `block duplicates prior segment (${(overlap * 100).toFixed(1)}% word overlap)`;
          continue;
        }
      }

      if (corpus.includedPosts.length === 0) {
        lastError = "no log prose in editor input";
        continue;
      }
      if (corpus.inputCeilingPost != null && candidate.coverageThroughPost > corpus.inputCeilingPost) {
        lastError = `coverage ${candidate.coverageThroughPost} exceeds ceiling ${corpus.inputCeilingPost}`;
        continue;
      }
      const chainEntry = buildChainPostIndex(db, logbookId).find(
        (e) => e.postNumber === candidate.coverageThroughPost
      );
      if (!chainEntry) {
        lastError = `coverage post ${candidate.coverageThroughPost} not on chain`;
        continue;
      }
      if (chainEntry.hidden) {
        lastError = `coverage post ${candidate.coverageThroughPost} lands on hidden OOC turn`;
        continue;
      }
      const coveragePost = findPostByIcNumber(corpus.includedPosts, candidate.coverageThroughPost);
      if (!coveragePost) {
        lastError = `coverage post ${candidate.coverageThroughPost} not in input (ceiling ${corpus.inputCeilingPost ?? "?"})`;
        continue;
      }
      if (kind === "continues" && priorSegments.length) {
        const priorCov = priorSegments[priorSegments.length - 1]!.coverageThroughPost;
        if (candidate.coverageThroughPost <= priorCov) {
          lastError = `coverage must advance beyond ${priorCov}`;
          continue;
        }
        const coverageDelta = candidate.coverageThroughPost - priorCov;
        if (looksNextSceneCoverageSprint(candidate.block, coverageDelta)) {
          lastError = `coverage sprint: +${coverageDelta} posts in ${storyBlockWordCount(candidate.block)} words`;
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
