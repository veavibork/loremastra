import { BANNED_PHRASES_SPACE, DEFAULT_REFUSAL_PREFIXES } from "./refusal-detection.js";
import { GLOBAL_CSS_SPACE, DEFAULT_GLOBAL_CSS } from "./global-css.js";
import { PLAY_TAB_SPACE, DEFAULT_PLAY_TAB_SETTINGS } from "./play-tab.js";

/**
 * Every valid Settings-tab JSON space and its seed default, keyed by the space id used in
 * `/api/settings/:space`. Populated incrementally as each space is added (see
 * refusal-detection.ts, global-css.ts, play-tab.ts) rather than all at once.
 */
export const SETTINGS_SPACE_DEFAULTS: Record<string, unknown> = {
  [BANNED_PHRASES_SPACE]: DEFAULT_REFUSAL_PREFIXES,
  [GLOBAL_CSS_SPACE]: DEFAULT_GLOBAL_CSS,
  [PLAY_TAB_SPACE]: DEFAULT_PLAY_TAB_SETTINGS,
};

export function getSpaceDefault(space: string): unknown {
  if (!(space in SETTINGS_SPACE_DEFAULTS)) return undefined;
  return SETTINGS_SPACE_DEFAULTS[space];
}

export function isKnownSpace(space: string): boolean {
  return space in SETTINGS_SPACE_DEFAULTS;
}
