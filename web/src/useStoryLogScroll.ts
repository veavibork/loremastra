import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** How close to the bottom (px) counts as "following" live tail output. */
const BOTTOM_PIN_THRESHOLD_PX = 64;

export function isLogPinnedToBottom(log: HTMLElement, threshold = BOTTOM_PIN_THRESHOLD_PX): boolean {
  return log.scrollHeight - log.scrollTop - log.clientHeight <= threshold;
}

export function scrollLogToBottom(log: HTMLElement, behavior: ScrollBehavior = "auto"): void {
  const top = Math.max(0, log.scrollHeight - log.clientHeight);
  if (behavior === "auto") {
    log.scrollTop = top;
  } else {
    log.scrollTo({ top, behavior });
  }
}

type UseStoryLogScrollOptions = {
  logRef: RefObject<HTMLDivElement | null>;
  /** Toolbar + composer (+ error banner) — height changes shrink `.log` and need re-anchoring. */
  footerRef: RefObject<HTMLElement | null>;
  storyId: string;
  entriesLength: number;
  /** Changes when streamed tail text grows — triggers follow when pinned. */
  pendingTailSignature: string;
  atHead: boolean;
  editingPageId: string | null;
};

/**
 * One place for story-log scroll decisions — replaces ad-hoc scrollIntoView calls.
 *
 * Policy:
 * - Follow the tail only when the user is already pinned to the bottom AND viewing the head.
 * - Never auto-scroll while a post is being edited inline.
 * - Focus the edit textarea without browser scroll jumps; let native caret-follow handle the rest.
 * - When the footer grows/shrinks, keep the bottom aligned if the user was pinned.
 */
export function useStoryLogScroll({
  logRef,
  footerRef,
  storyId,
  entriesLength,
  pendingTailSignature,
  atHead,
  editingPageId,
}: UseStoryLogScrollOptions): void {
  const pinnedRef = useRef(true);
  const prevScrollHeightRef = useRef(0);
  const prevStoryIdRef = useRef(storyId);

  useEffect(() => {
    const log = logRef.current;
    if (!log) return;

    function onScroll() {
      pinnedRef.current = isLogPinnedToBottom(log!);
    }

    onScroll();
    log.addEventListener("scroll", onScroll, { passive: true });
    return () => log.removeEventListener("scroll", onScroll);
  }, [logRef]);

  useLayoutEffect(() => {
    if (prevStoryIdRef.current === storyId) return;
    prevStoryIdRef.current = storyId;
    pinnedRef.current = true;
    prevScrollHeightRef.current = 0;
  }, [storyId]);

  useLayoutEffect(() => {
    const log = logRef.current;
    if (!log || !editingPageId) return;

    const textarea = log.querySelector<HTMLTextAreaElement>(
      `.entry[data-page-id="${editingPageId}"] textarea.edit-box-textarea`
    );
    if (textarea && document.activeElement !== textarea) {
      textarea.focus({ preventScroll: true });
    }
  }, [editingPageId, logRef]);

  useEffect(() => {
    const footer = footerRef.current;
    const log = logRef.current;
    if (!footer || !log) return;

    const ro = new ResizeObserver(() => {
      if (editingPageId) return;
      if (!pinnedRef.current || !atHead) return;
      scrollLogToBottom(log, "auto");
    });

    ro.observe(footer);
    return () => ro.disconnect();
  }, [footerRef, logRef, atHead, editingPageId]);

  useLayoutEffect(() => {
    const log = logRef.current;
    if (!log) return;

    if (editingPageId) {
      prevScrollHeightRef.current = log.scrollHeight;
      return;
    }

    const prevHeight = prevScrollHeightRef.current;
    const grew = log.scrollHeight > prevHeight;
    prevScrollHeightRef.current = log.scrollHeight;

    const storyJustOpened = prevHeight === 0 && entriesLength > 0;
    const shouldFollow = pinnedRef.current && atHead && (storyJustOpened || grew);

    if (shouldFollow) {
      const streaming = pendingTailSignature.length > 0;
      scrollLogToBottom(log, streaming ? "auto" : "smooth");
      pinnedRef.current = true;
    }
  }, [entriesLength, pendingTailSignature, atHead, editingPageId, logRef]);
}
