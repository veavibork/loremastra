import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

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

/** Scroll just enough to keep `el` visible — never yanks past it to a tail sentinel. */
export function scrollLogEntryIntoView(log: HTMLElement, pageId: string): void {
  const entry = log.querySelector<HTMLElement>(`.entry[data-page-id="${pageId}"]`);
  if (!entry) return;
  const logRect = log.getBoundingClientRect();
  const entryRect = entry.getBoundingClientRect();
  if (entryRect.top >= logRect.top && entryRect.bottom <= logRect.bottom) return;
  entry.scrollIntoView({ block: "nearest", inline: "nearest" });
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
  /** Inline edit textarea autogrow — lock scroll while this changes. */
  editDraftLength: number;
};

/**
 * One place for story-log scroll decisions — replaces ad-hoc scrollIntoView calls.
 *
 * Policy:
 * - Follow the tail only when the user is already pinned to the bottom AND viewing the head.
 * - Never auto-scroll while a post is being edited inline.
 * - Preserve scrollTop when entering edit; focus the textarea without browser scroll jumps.
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
  editDraftLength,
}: UseStoryLogScrollOptions): { beginEditScrollCapture: () => void } {
  const pinnedRef = useRef(true);
  const prevScrollHeightRef = useRef(0);
  const prevStoryIdRef = useRef(storyId);
  const editScrollTopRef = useRef<number | null>(null);

  const beginEditScrollCapture = useCallback(() => {
    const log = logRef.current;
    if (log) editScrollTopRef.current = log.scrollTop;
  }, [logRef]);

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
    editScrollTopRef.current = null;
  }, [storyId]);

  useLayoutEffect(() => {
    const log = logRef.current;
    if (!log || !editingPageId) return;

    if (editScrollTopRef.current !== null) {
      log.scrollTop = editScrollTopRef.current;
    }

    const textarea = log.querySelector<HTMLTextAreaElement>(
      `.entry[data-page-id="${editingPageId}"] textarea.edit-box-textarea`
    );
    if (textarea && document.activeElement !== textarea) {
      textarea.focus({ preventScroll: true });
    }

    scrollLogEntryIntoView(log, editingPageId);
    editScrollTopRef.current = log.scrollTop;
  }, [editingPageId, editDraftLength, logRef]);

  useLayoutEffect(() => {
    if (editingPageId === null) {
      editScrollTopRef.current = null;
    }
  }, [editingPageId]);

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
      if (editScrollTopRef.current !== null) {
        log.scrollTop = editScrollTopRef.current;
      }
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

  return { beginEditScrollCapture };
}
