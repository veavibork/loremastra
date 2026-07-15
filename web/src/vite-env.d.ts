/// <reference types="vite/client" />

declare const __BUILD_INFO__: { commit: string; builtAt: string }

interface Window {
  /** Toggle story view debug logging from the browser console: `window.DEBUG_STORY = true` */
  DEBUG_STORY?: boolean
}
