import { useCallback, useEffect, useState } from "react";

const SHOW_KEY = "loremaster.reasoning.show";
const EXPANDED_KEY = "loremaster.reasoning.expanded";

function traceCacheKey(storyId: string): string {
  return `loremaster.reasoning.traces.${storyId}`;
}

function readBool(key: string, defaultValue: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === "true") return true;
    if (raw === "false") return false;
  } catch {
    // ignore
  }
  return defaultValue;
}

function writeBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // ignore
  }
}

/** Whether reasoning trace UI renders at all (pending stream + cached traces). Default on. */
export function useReasoningDisplayPrefs() {
  const [showReasoning, setShowReasoning] = useState(() => readBool(SHOW_KEY, true));
  const [reasoningExpanded, setReasoningExpanded] = useState(() => readBool(EXPANDED_KEY, false));

  useEffect(() => {
    writeBool(SHOW_KEY, showReasoning);
  }, [showReasoning]);

  useEffect(() => {
    writeBool(EXPANDED_KEY, reasoningExpanded);
  }, [reasoningExpanded]);

  const toggleShowReasoning = useCallback(() => setShowReasoning((v) => !v), []);
  const toggleReasoningExpanded = useCallback(() => setReasoningExpanded((v) => !v), []);

  return {
    showReasoning,
    reasoningExpanded,
    toggleShowReasoning,
    toggleReasoningExpanded,
  };
}

export function loadReasoningTrace(storyId: string, pageId: string): string | undefined {
  return loadAllReasoningTraces(storyId)[pageId]?.trim() || undefined;
}

export function loadAllReasoningTraces(storyId: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(traceCacheKey(storyId));
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

export function ReasoningTracePanel({
  thinking,
  expanded,
  autoScroll,
}: {
  thinking: string;
  expanded: boolean;
  /** While prose hasn't started yet, keep the pre scrolled to the latest tokens. */
  autoScroll?: boolean;
}) {
  return (
    <details className="pending-reasoning" open={expanded}>
      <summary>Reasoning trace</summary>
      <pre
        className="pending-reasoning-body"
        ref={(el) => {
          if (el && autoScroll) el.scrollTop = el.scrollHeight;
        }}
      >
        {thinking}
      </pre>
    </details>
  );
}

/** Persist a completed agent reasoning trace for replay when Trace: On. Caps per story. */
export function saveReasoningTrace(storyId: string, pageId: string, thinking: string): void {
  const trimmed = thinking.trim();
  if (!trimmed) return;
  try {
    const key = traceCacheKey(storyId);
    const map = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, string>;
    map[pageId] = trimmed;
    const ids = Object.keys(map);
    if (ids.length > 80) {
      for (const id of ids.slice(0, ids.length - 80)) delete map[id];
    }
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    // ignore quota / parse errors
  }
}
