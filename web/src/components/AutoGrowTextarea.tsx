import { useLayoutEffect, useRef } from 'react'
import type { FocusEvent, KeyboardEvent, RefObject } from 'react'

/**
 * Grows with its content instead of scrolling internally — used for both the composer and
 * tap-to-edit's single edit box so neither ever shows a stale, pre-resize box on first paint.
 *
 * The layout effect immediately measures and sets height to scrollHeight (then re-measures
 * in a rAF to catch late metric shifts like async root-font-size overrides). On every value
 * change the same effect fires again.
 *
 * `protectScrollRef`: scroll container that has pin-to-bottom semantics — the component
 * saves/restores its scrollTop around the temporary `height: auto` collapse (which shrinks
 * the container's clientHeight and can cause the browser to clamp scrollTop upward) so the
 * pinned position is preserved. The composer's protector is `.log`; tap-to-edit's protector
 * is the entry wrapper that has the same scroll-restore semantics because it sits below the
 * edit box in the visible item. The protector can't be discovered automatically because
 * tap-to-edit's edit box is in a self-contained entry wrapper where `.log` is not the
 * closest scroll parent — it's only an *ancestor* of the edit box, not of the composer (a
 * flex sibling whose height changes shift .log's clientHeight through their shared parent
 * either way). An ancestor-walk from this element wouldn't find a sibling, so the caller
 * passes the ref explicitly instead of this component guessing.
 */
export default function AutoGrowTextarea({
  value,
  onChange,
  onKeyDown,
  onFocus,
  className,
  placeholder,
  disabled,
  autoFocus,
  initialHeight,
  protectScrollRef,
}: {
  value: string
  onChange: (value: string) => void
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  onFocus?: (e: FocusEvent<HTMLTextAreaElement>) => void
  className?: string
  placeholder?: string
  disabled?: boolean
  autoFocus?: boolean
  initialHeight?: number
  protectScrollRef?: RefObject<HTMLElement | null>
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const resize = () => {
      // Collapsing to "auto" below is necessary to detect shrinking content (scrollHeight never
      // shrinks on its own), but reading el.scrollHeight forces a real synchronous layout with
      // the box collapsed to one row — if protectScrollRef's container is scrolled at/near its
      // bottom, that transient shrink (of this box, or of a flex sibling's clientHeight through a
      // shared parent) can make the browser clamp its scrollTop, and restoring the real height a
      // line later does not undo that clamp (browsers only clamp scrollTop down on shrink, never
      // push it back up on regrow). Save/restore around the collapse to prevent it.
      const scrollTarget = protectScrollRef?.current
      const prevScrollTop = scrollTarget?.scrollTop

      // scrollHeight reflects whatever's rendered inside the box, including a wrapped
      // placeholder — for the composer's long instructional placeholder that inflated an
      // empty box to 2-3 lines tall. Hide it for the measurement so height only ever tracks
      // the actual value.
      const placeholder = el.placeholder
      el.placeholder = ''
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
      el.placeholder = placeholder

      if (scrollTarget && prevScrollTop !== undefined) {
        scrollTarget.scrollTop = prevScrollTop
      }
    }
    resize()
    // Catches late metric shifts (e.g. Global CSS's async root-font-size override landing after
    // this first measurement) that the value-keyed effect above has no other reason to rerun for.
    const raf = requestAnimationFrame(resize)
    return () => cancelAnimationFrame(raf)
  }, [value, protectScrollRef])

  return (
    <textarea
      ref={(el) => {
        ref.current = el
        // Guards against re-applying on every render (callback refs re-fire then) — once the
        // layout effect above has set a real height, style.height is no longer empty and this
        // becomes a no-op.
        if (el && initialHeight && !el.style.height) el.style.height = `${initialHeight}px`
      }}
      rows={1}
      className={className}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
    />
  )
}
