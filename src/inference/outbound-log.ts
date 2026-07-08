import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ChatMessage } from "./featherless.js";

/**
 * Every outbound chat-completions call, verbatim, for troubleshooting prompt-assembly bugs
 * (e.g. guided retry silently not steering the model) without needing to re-instrument the
 * code each time. child_process stdio redirection (dev-restart.mjs's dev-server.log) has been
 * observed to lose output entirely on Windows, so this writes straight from the process rather
 * than relying on a piped stdout. Best-effort: a logging failure must never break the actual
 * inference call it's describing.
 */
const LOG_PATH = path.resolve(process.cwd(), "data", "outbound-requests.log");
const MAX_ENTRIES = 50;
/** Avoid re-reading a multi-MB log on every inference call — trim only once we're over the cap. */
const MAX_LOG_BYTES = 512 * 1024;

interface OutboundLogEntry {
  at: string;
  call: "streamInference" | "callWithTools" | "completeChat";
  model: string;
  messages: ChatMessage[];
}

function trimLogFile(): void {
  const lines = readFileSync(LOG_PATH, "utf-8").split("\n").filter(Boolean);
  const trimmed = lines.slice(-MAX_ENTRIES);
  writeFileSync(LOG_PATH, trimmed.join("\n") + (trimmed.length ? "\n" : ""));
}

export function logOutboundRequest(entry: Omit<OutboundLogEntry, "at">): void {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    if (!existsSync(LOG_PATH)) {
      writeFileSync(LOG_PATH, "");
    }
    appendFileSync(LOG_PATH, line + "\n");
    const size = statSync(LOG_PATH).size;
    if (size > MAX_LOG_BYTES) trimLogFile();
  } catch (err) {
    console.error("outbound-log: failed to record request", err);
  }
}

export function readRecentOutboundRequests(limit?: number): OutboundLogEntry[] {
  if (!existsSync(LOG_PATH)) return [];
  const lines = readFileSync(LOG_PATH, "utf-8").split("\n").filter(Boolean);
  const scoped = limit ? lines.slice(-limit) : lines;
  return scoped.map((line) => JSON.parse(line) as OutboundLogEntry);
}
