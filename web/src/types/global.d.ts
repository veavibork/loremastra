export {}

declare global {
  interface Window {
    /** Toggle story view debug logging from the browser console: `window.DEBUG_STORY = true` */
    DEBUG_STORY?: boolean
  }
}
