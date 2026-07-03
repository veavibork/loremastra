import type { AgentProfile } from "../config.js";
import type { ChatMessage } from "./featherless.js";
import { HORDE_API_KEY, HORDE_BASE_URL, HORDE_USER_AGENT } from "./horde-config.js";

/** Carries the HTTP status, mirroring FeatherlessError — see featherless.ts. */
export class HordeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HordeError";
    this.status = status;
  }
}

/**
 * `is_possible: false` is a live, continuously-recomputed flag (not a one-time submit
 * rejection) reflecting whether any currently-online worker matches the request's
 * constraints right now — it can flip back to true while a request is still queued. Kept as
 * its own error type, distinct from HordeError/faulted, so a caller (the P5b poll loop) can
 * treat it as a semi-terminal signal rather than an immediate hard failure.
 */
export class HordeImpossibleError extends Error {
  constructor(message = "no worker currently available for this request") {
    super(message);
    this.name = "HordeImpossibleError";
  }
}

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": HORDE_USER_AGENT,
    apikey: HORDE_API_KEY,
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

// A hung request must not be able to hold a Horde slot forever — with only
// HORDE_MAX_CONCURRENT (2 by default, see horde-slots.ts) slots total, one or two stuck
// requests would starve the whole Horde path. Found live 2026-07-03: a submit call that's
// merely slow (not hung) is normal and expected — Horde generation genuinely varies from
// seconds to minutes — but nothing here previously bounded a request that never resolves at
// all. Each call is a single one-shot request/response (no streaming to reset on), so a plain
// fixed timeout is enough, unlike featherless.ts's armTimeout which resets per streamed chunk.
const DEFAULT_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new HordeError(0, `Horde request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

/**
 * No chat-template concept in Horde's plain-text completion API — a role-prefixed transcript
 * join, ending with an open "assistant:" cue so the model actually continues in that voice
 * instead of guessing at turn-taking format on its own (observed live: without the trailing
 * cue, a raw completion model echoed a stray "admin_user:" line instead of replying). Known
 * simplification, not a generic per-model chat-template system.
 */
function buildPrompt(messages: ChatMessage[]): string {
  const transcript = messages.map((m) => `${m.role}: ${m.content ?? ""}`).join("\n\n");
  return `${transcript}\n\nassistant:`;
}

/** Omits sampler fields Horde has no equivalent for (presence/frequency penalty) rather than sending something misleading. */
function hordeParams(profile: AgentProfile): Record<string, number> {
  const params: Record<string, number> = {
    max_context_length: profile.contextLimit,
    max_length: profile.responseLimit,
    temperature: profile.temperature,
  };
  if (profile.topP !== undefined) params.top_p = profile.topP;
  if (profile.topK !== undefined) params.top_k = profile.topK;
  if (profile.repetitionPenalty !== undefined) params.rep_pen = profile.repetitionPenalty;
  return params;
}

export interface HordeSubmitResult {
  id: string;
  kudos: number;
}

/**
 * Submit-then-return — Horde has no synchronous completion endpoint. Returns almost
 * immediately with a request id to poll (see pollTextGeneration); the actual generation can
 * take anywhere from seconds to minutes depending on pool availability.
 */
export async function submitTextGeneration(profile: AgentProfile, messages: ChatMessage[]): Promise<HordeSubmitResult> {
  const response = await fetchWithTimeout(`${HORDE_BASE_URL}/v2/generate/text/async`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      prompt: buildPrompt(messages),
      params: hordeParams(profile),
      models: [profile.model],
    }),
  });

  if (!response.ok) {
    throw new HordeError(response.status, `Horde submit failed: ${response.status} ${await safeText(response)}`);
  }

  const data = (await response.json()) as { id: string; kudos: number };
  return { id: data.id, kudos: data.kudos };
}

export interface HordeStatus {
  done: boolean;
  faulted: boolean;
  isPossible: boolean;
  queuePosition: number;
  waitTime: number;
  text: string | null;
}

/** One status check per call — the caller (the queue's poll loop) owns the looping/interval, not this function. */
export async function pollTextGeneration(requestId: string): Promise<HordeStatus> {
  const response = await fetchWithTimeout(`${HORDE_BASE_URL}/v2/generate/text/status/${requestId}`, {
    headers: headers(),
  });

  if (!response.ok) {
    throw new HordeError(response.status, `Horde status poll failed: ${response.status} ${await safeText(response)}`);
  }

  const data = (await response.json()) as {
    done: boolean;
    faulted: boolean;
    is_possible: boolean;
    queue_position: number;
    wait_time: number;
    generations?: Array<{ text?: string }>;
  };

  return {
    done: data.done,
    faulted: data.faulted,
    isPossible: data.is_possible,
    queuePosition: data.queue_position,
    waitTime: data.wait_time,
    text: data.generations?.[0]?.text ?? null,
  };
}

/** Best-effort — used from the queue's cancel path, which marks the job cancelled locally regardless of whether Horde's own ack succeeds. */
export async function cancelTextGeneration(requestId: string): Promise<void> {
  try {
    await fetchWithTimeout(`${HORDE_BASE_URL}/v2/generate/text/status/${requestId}`, {
      method: "DELETE",
      headers: headers(),
    });
  } catch {
    // best-effort — a failed cancel-ack must never block marking the job cancelled locally
  }
}

export interface HordeTextModel {
  name: string;
  count: number;
  queued: number;
  eta: number;
}

/** Available-models discovery — a model with count: 0 has no worker online right now and would resolve is_possible: false immediately if targeted. */
export async function listTextModels(): Promise<HordeTextModel[]> {
  const response = await fetchWithTimeout(`${HORDE_BASE_URL}/v2/status/models?type=text`, {
    headers: headers(),
  });

  if (!response.ok) {
    throw new HordeError(response.status, `Horde model list failed: ${response.status} ${await safeText(response)}`);
  }

  const data = (await response.json()) as Array<{ name: string; count: number; queued: number; eta: number }>;
  return data.map((m) => ({ name: m.name, count: m.count, queued: m.queued, eta: m.eta }));
}
