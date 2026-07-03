/**
 * Persistent backend connection to Featherless's real account-wide concurrency feed
 * (`GET /account/concurrency/stream` — no `/v1` prefix, confirmed in
 * docs/featherless-notes.md), so slot-acquisition can gate on ground truth instead of the
 * purely local counter in src/queue/slots.ts. One process-wide connection, since this is
 * account data, not per-story. Docs: one event immediately on connect, then every 2s.
 */
import { FEATHERLESS_API_KEY, FEATHERLESS_BASE_URL, FEATHERLESS_USER_AGENT } from "../inference/featherless-config.js";

// FEATHERLESS_BASE_URL includes /v1 for chat/models endpoints; this endpoint lives at the bare host.
const CONCURRENCY_STREAM_URL = `${FEATHERLESS_BASE_URL.replace(/\/v1$/, "")}/account/concurrency/stream`;

// A snapshot older than this many ms is treated as stale (4x the documented ~2s cadence —
// generous margin, consistent with this codebase's other timeout margins).
const STALE_AFTER_MS = 8_000;

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000];

export interface ConcurrencySnapshot {
  limit: number;
  usedCost: number;
  updatedAt: number;
}

let snapshot: ConcurrencySnapshot | null = null;
let reconnectAttempt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let abortController: AbortController | null = null;
let stopped = true;

export function getConcurrencySnapshot(): ConcurrencySnapshot | null {
  return snapshot;
}

export function isFeedHealthy(): boolean {
  return !!snapshot && Date.now() - snapshot.updatedAt <= STALE_AFTER_MS;
}

export function startConcurrencyFeed(): void {
  if (!stopped) return;
  stopped = false;
  connect();
}

export function stopConcurrencyFeed(): void {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  abortController?.abort();
  abortController = null;
}

function scheduleReconnect(): void {
  if (stopped) return;
  const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  reconnectAttempt++;
  reconnectTimer = setTimeout(connect, delay);
}

async function connect(): Promise<void> {
  if (stopped) return;
  if (!FEATHERLESS_API_KEY) {
    // No key configured — nothing to connect to. Callers see this via isFeedHealthy() staying
    // false forever and fall back to the local counter.
    scheduleReconnect();
    return;
  }

  abortController = new AbortController();
  try {
    const response = await fetch(CONCURRENCY_STREAM_URL, {
      headers: {
        Authorization: `Bearer ${FEATHERLESS_API_KEY}`,
        "User-Agent": FEATHERLESS_USER_AGENT,
        Accept: "text/event-stream",
      },
      signal: abortController.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`concurrency stream request failed: ${response.status}`);
    }

    reconnectAttempt = 0; // connected successfully — reset backoff
    const reader = response.body.getReader();
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
        try {
          const parsed = JSON.parse(payload) as { limit?: number; used_cost?: number };
          if (typeof parsed.limit === "number" && typeof parsed.used_cost === "number") {
            snapshot = { limit: parsed.limit, usedCost: parsed.used_cost, updatedAt: Date.now() };
          }
        } catch {
          // ignore malformed SSE chunk
        }
      }
    }
  } catch (err) {
    if (!stopped) {
      console.error("concurrency feed disconnected:", err instanceof Error ? err.message : err);
    }
  } finally {
    abortController = null;
    scheduleReconnect();
  }
}
