/**
 * Seed default for the "global-css" Settings-tab JSON space — mirrors the light/dark custom
 * properties, root font sizes, and narrow-screen breakpoint currently hardcoded in
 * web/src/index.css. Editable from Settings once seeded; this is only the first-run value.
 */
export const GLOBAL_CSS_SPACE = "global-css";

export const DEFAULT_GLOBAL_CSS = {
  light: {
    text: "#6b6375",
    textH: "#08060d",
    bg: "#fff",
    border: "#e5e4e7",
    codeBg: "#f4f3ec",
    accent: "#aa3bff",
    accentBg: "rgba(170, 59, 255, 0.1)",
    accentBorder: "rgba(170, 59, 255, 0.5)",
    socialBg: "rgba(244, 243, 236, 0.5)",
  },
  dark: {
    text: "#9ca3af",
    textH: "#f3f4f6",
    bg: "#16171d",
    border: "#2e303a",
    codeBg: "#1f2028",
    accent: "#c084fc",
    accentBg: "rgba(192, 132, 252, 0.15)",
    accentBorder: "rgba(192, 132, 252, 0.5)",
    socialBg: "rgba(47, 48, 58, 0.5)",
  },
  rootFontSize: 18,
  rootFontSizeNarrow: 16,
  narrowBreakpoint: 1024,
};
