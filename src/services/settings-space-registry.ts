import type { AgentProfile } from '../config.js'
import { BANNED_PHRASES_SPACE, DEFAULT_REFUSAL_PREFIXES } from './refusal-detection.js'
import { GLOBAL_CSS_SPACE, DEFAULT_GLOBAL_CSS } from '../defaults/global-css.js'
import { PLAY_TAB_SPACE, DEFAULT_PLAY_TAB_SETTINGS } from './display-preferences.js'
import {
  TOGGLE_LENGTH_SPACE,
  TOGGLE_MOOD_SPACE,
  TOGGLE_PARAM_SPACE,
  TOGGLE_EFFORT_SPACE,
  DEFAULT_TOGGLE_LENGTH,
  DEFAULT_TOGGLE_MOOD,
  DEFAULT_TOGGLE_PARAMS,
  DEFAULT_TOGGLE_EFFORT,
} from './generation-presets.js'

export const SETTINGS_SPACE_DEFAULTS: Record<string, unknown> = {
  [BANNED_PHRASES_SPACE]: DEFAULT_REFUSAL_PREFIXES,
  [GLOBAL_CSS_SPACE]: DEFAULT_GLOBAL_CSS,
  [PLAY_TAB_SPACE]: DEFAULT_PLAY_TAB_SETTINGS,
  [TOGGLE_LENGTH_SPACE]: DEFAULT_TOGGLE_LENGTH,
  [TOGGLE_MOOD_SPACE]: DEFAULT_TOGGLE_MOOD,
  [TOGGLE_PARAM_SPACE]: DEFAULT_TOGGLE_PARAMS,
  [TOGGLE_EFFORT_SPACE]: DEFAULT_TOGGLE_EFFORT,
}

export function getSpaceDefault(space: string): unknown {
  if (!(space in SETTINGS_SPACE_DEFAULTS)) return undefined
  return SETTINGS_SPACE_DEFAULTS[space]
}

export function isKnownSpace(space: string): boolean {
  return space in SETTINGS_SPACE_DEFAULTS
}

/** Per-post generation overrides from input-bar toggles. */
export interface GenerationOptions {
  responseLimit?: number
  moodFragment?: string
  paramOverrides?: Partial<
    Pick<
      AgentProfile,
      | 'temperature'
      | 'topP'
      | 'topK'
      | 'minP'
      | 'presencePenalty'
      | 'frequencyPenalty'
      | 'repetitionPenalty'
    >
  >
  modelOverride?: string
  configIdOverride?: string
  effort?: { enableThinking?: boolean; thinkingBudget?: number }
}
