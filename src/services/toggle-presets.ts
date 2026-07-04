export const TOGGLE_LENGTH_SPACE = "toggle-length";
export const TOGGLE_MOOD_SPACE = "toggle-mood";
export const TOGGLE_PARAM_SPACE = "toggle-param";
export const TOGGLE_EFFORT_SPACE = "toggle-effort";

export interface MoodPreset {
  id: string;
  label: string;
  promptFragment: string;
}

export interface ParamPreset {
  id: string;
  label: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  repetitionPenalty?: number;
}

export interface EffortPreset {
  id: string;
  label: string;
  /** Passed as chat_template_kwargs when the model supports reasoning toggles. */
  enableThinking?: boolean;
  thinkingBudget?: number;
}

export const DEFAULT_TOGGLE_LENGTH = [100, 300, 500];

export const DEFAULT_TOGGLE_MOOD: MoodPreset[] = [
  { id: "neutral", label: "Neutral", promptFragment: "" },
  {
    id: "intense",
    label: "Intense",
    promptFragment: "Write with more intensity; use visceral, sensory language.",
  },
  {
    id: "light",
    label: "Light",
    promptFragment: "Keep the tone lighter and less heavy; don't linger on grim detail.",
  },
];

export const DEFAULT_TOGGLE_PARAMS: ParamPreset[] = [
  { id: "default", label: "Default" },
  { id: "creative", label: "Creative", temperature: 1.15, topP: 0.95 },
  { id: "precise", label: "Precise", temperature: 0.7, topP: 0.85 },
];

export const DEFAULT_TOGGLE_EFFORT: EffortPreset[] = [
  { id: "off", label: "Off", enableThinking: false },
  { id: "on", label: "On", enableThinking: true },
];
