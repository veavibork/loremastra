import { useEffect } from 'react'

const CSS_VAR = '--app-height'

/**
 * Tracks `window.visualViewport`'s height into a CSS custom property, so `.story-app` can shrink
 * to the space actually left after a mobile on-screen keyboard opens instead of sitting under a
 * fixed `100vh`/`100dvh` that ignores it. No-op (and leaves the `100dvh` CSS fallback in place)
 * on browsers without `visualViewport`, e.g. desktop Firefox.
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    function update() {
      document.documentElement.style.setProperty(CSS_VAR, `${vv!.height}px`)
    }

    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      document.documentElement.style.removeProperty(CSS_VAR)
    }
  }, [])
}
