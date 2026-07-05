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
  // Read fresh inside the ResizeObserver callback below rather than closed over at effect-setup
  // time — the observer is created once (see that effect's empty-ish deps) and a passive effect
  // recreating it on editingPageId change would still lag one animation frame behind the footer's
  // actual (synchronous, same-commit) resize when swapping into the edit toolbar, letting a stale
  // closure's `editingPageId` read as null and wrongly snap-to-bottom.
  const editingPageIdRef = useRef(editingPageId);
  const atHeadRef = useRef(atHead);
  editingPageIdRef.current = editingPageId;
  atHeadRef.current = atHead;

  useEffect(() => {
    const log = logRef.current;
    if (!log) return;

    function onScroll() {
      const wasPinned = pinnedRef.current;
      pinnedRef.current = isLogPinnedToBottom(log!);
      // eslint-disable-next-line no-console
      console.info("[scrollDebug] scroll event", {
        scrollTop: log!.scrollTop,
        scrollHeight: log!.scrollHeight,
        clientHeight: log!.clientHeight,
        pinnedBefore: wasPinned,
        pinnedAfter: pinnedRef.current,
      });
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
    // eslint-disable-next-line no-console
    console.info("[scrollDebug] edit-anchor effect", {
      editingPageId,
      foundTextarea: !!textarea,
      alreadyFocused: textarea ? document.activeElement === textarea : null,
      scrollTop: log.scrollTop,
      scrollHeight: log.scrollHeight,
    });
    if (textarea && document.activeElement !== textarea) {
      textarea.focus({ preventScroll: true });
      // eslint-disable-next-line no-console
      console.info("[scrollDebug] edit-anchor effect: focused, scrollTop after", log.scrollTop);
    }
  }, [editingPageId, logRef]);

  useEffect(() => {
    const footer = footerRef.current;
    const log = logRef.current;
    if (!footer || !log) return;

    const ro = new ResizeObserver(() => {
      const willBail = !!editingPageIdRef.current || !pinnedRef.current || !atHeadRef.current;
      // eslint-disable-next-line no-console
      console.info("[scrollDebug] footer ResizeObserver fired", {
        editingPageId: editingPageIdRef.current,
        pinned: pinnedRef.current,
        atHead: atHeadRef.current,
        willScroll: !willBail,
        scrollTopBefore: log.scrollTop,
      });
      if (willBail) return;
      scrollLogToBottom(log, "auto");
      // eslint-disable-next-line no-console
      console.info("[scrollDebug] footer ResizeObserver: scrolled to bottom, scrollTop after", log.scrollTop);
    });

    ro.observe(footer);
    return () => ro.disconnect();
  }, [footerRef, logRef]);

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

    // eslint-disable-next-line no-console
    console.info("[scrollDebug] growth-follow effect", {
      editingPageId,
      prevHeight,
      newHeight: log.scrollHeight,
      grew,
      storyJustOpened,
      pinned: pinnedRef.current,
      atHead,
      shouldFollow,
    });

    if (shouldFollow) {
      const streaming = pendingTailSignature.length > 0;
      scrollLogToBottom(log, streaming ? "auto" : "smooth");
      pinnedRef.current = true;
    }
  }, [entriesLength, pendingTailSignature, atHead, editingPageId, logRef]);
}
