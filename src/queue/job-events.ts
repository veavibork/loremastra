import { EventEmitter } from "node:events";

/**
 * Bridges the background pipeline runner (which calls Featherless) to any SSE
 * clients watching a given job. This is what lets the client open its stream
 * only once a job is actually running, per the handshake design, instead of
 * making its own inference call.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function publishToken(jobId: string, text: string): void {
  emitter.emit(jobId, { type: "token", text });
}

/** For non-streaming jobs (e.g. the Editor's tool-calling setup turn) that have no tokens to emit but do have real intermediate steps worth narrating instead of a dead "…". */
export function publishProgress(jobId: string, label: string): void {
  emitter.emit(jobId, { type: "progress", label });
}

export function publishDone(jobId: string, fullText: string): void {
  emitter.emit(jobId, { type: "done", fullText });
}

export function publishError(jobId: string, message: string): void {
  emitter.emit(jobId, { type: "error", message });
}

export type JobEvent =
  | { type: "token"; text: string }
  | { type: "progress"; label: string }
  | { type: "done"; fullText: string }
  | { type: "error"; message: string };

export function subscribeJob(jobId: string, onEvent: (event: JobEvent) => void): () => void {
  emitter.on(jobId, onEvent);
  return () => emitter.off(jobId, onEvent);
}
