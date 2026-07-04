import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchModelConfigs,
  fetchSettingsSpace,
  type GenerationOptions,
  type ModelConfig,
} from "./api";

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
  enableThinking?: boolean;
  thinkingBudget?: number;
}

const DEFAULT_LENGTH = [100, 300, 500];
const DEFAULT_MOOD: MoodPreset[] = [
  { id: "neutral", label: "Neutral", promptFragment: "" },
  { id: "intense", label: "Intense", promptFragment: "Write with more intensity; use visceral, sensory language." },
  { id: "light", label: "Light", promptFragment: "Keep the tone lighter and less heavy; don't linger on grim detail." },
];
const DEFAULT_PARAMS: ParamPreset[] = [
  { id: "default", label: "Default" },
  { id: "creative", label: "Creative", temperature: 1.15, topP: 0.95 },
  { id: "precise", label: "Precise", temperature: 0.7, topP: 0.85 },
];
const DEFAULT_EFFORT: EffortPreset[] = [
  { id: "off", label: "Off", enableThinking: false },
  { id: "on", label: "On", enableThinking: true },
];

interface ToggleIndices {
  length: number;
  mood: number;
  param: number;
  model: number;
  effort: number;
}

function storageKey(storyId: string): string {
  return `loremaster.storyToggles.${storyId}`;
}

function loadIndices(storyId: string): ToggleIndices {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(storyId)) ?? "null") as Partial<ToggleIndices> | null;
    if (!raw) return { length: 1, mood: 0, param: 0, model: 0, effort: 0 };
    return {
      length: raw.length ?? 1,
      mood: raw.mood ?? 0,
      param: raw.param ?? 0,
      model: raw.model ?? 0,
      effort: raw.effort ?? 0,
    };
  } catch {
    return { length: 1, mood: 0, param: 0, model: 0, effort: 0 };
  }
}

function saveIndices(storyId: string, indices: ToggleIndices): void {
  localStorage.setItem(storageKey(storyId), JSON.stringify(indices));
}

export function useStoryToggles(storyId: string) {
  const [lengthSteps, setLengthSteps] = useState<number[]>(DEFAULT_LENGTH);
  const [moods, setMoods] = useState<MoodPreset[]>(DEFAULT_MOOD);
  const [params, setParams] = useState<ParamPreset[]>(DEFAULT_PARAMS);
  const [efforts, setEfforts] = useState<EffortPreset[]>(DEFAULT_EFFORT);
  const [authorModels, setAuthorModels] = useState<ModelConfig[]>([]);
  const [indices, setIndices] = useState<ToggleIndices>(() => loadIndices(storyId));

  useEffect(() => {
    setIndices(loadIndices(storyId));
  }, [storyId]);

  useEffect(() => {
    void Promise.all([
      fetchSettingsSpace<number[]>(TOGGLE_LENGTH_SPACE),
      fetchSettingsSpace<MoodPreset[]>(TOGGLE_MOOD_SPACE),
      fetchSettingsSpace<ParamPreset[]>(TOGGLE_PARAM_SPACE),
      fetchSettingsSpace<EffortPreset[]>(TOGGLE_EFFORT_SPACE),
      fetchModelConfigs(),
    ]).then(([len, mood, param, effort, configs]) => {
      if (len?.length) setLengthSteps(len);
      if (mood?.length) setMoods(mood);
      if (param?.length) setParams(param);
      if (effort?.length) setEfforts(effort);
      setAuthorModels(configs.filter((c) => c.active && c.useAuthor));
    });
  }, []);

  const persist = useCallback(
    (next: ToggleIndices) => {
      setIndices(next);
      saveIndices(storyId, next);
    },
    [storyId]
  );

  function cycle(field: keyof ToggleIndices, max: number) {
    persist({ ...indices, [field]: (indices[field] + 1) % Math.max(max, 1) });
  }

  const labels = useMemo(() => {
    const len = lengthSteps[indices.length % lengthSteps.length] ?? lengthSteps[0];
    const mood = moods[indices.mood % moods.length];
    const param = params[indices.param % params.length];
    const model = authorModels[indices.model % Math.max(authorModels.length, 1)];
    const effort = efforts[indices.effort % efforts.length];
    return {
      length: len != null ? `${len}t` : "Length",
      mood: mood?.label ?? "Mood",
      param: param?.label ?? "Param",
      model: model?.model?.split("/").pop() ?? "Model",
      effort: effort?.label ?? "Effort",
    };
  }, [indices, lengthSteps, moods, params, efforts, authorModels]);

  const generationOptions = useCallback((): GenerationOptions | undefined => {
    if (authorModels.length === 0 && indices.model === 0) {
      // still allow other toggles
    }
    const len = lengthSteps[indices.length % lengthSteps.length];
    const mood = moods[indices.mood % moods.length];
    const param = params[indices.param % params.length];
    const model = authorModels[indices.model % Math.max(authorModels.length, 1)];
    const effort = efforts[indices.effort % efforts.length];

    const options: GenerationOptions = {};
    if (len != null) options.responseLimit = len;
    if (mood?.promptFragment?.trim()) options.moodFragment = mood.promptFragment.trim();
    if (param && param.id !== "default") {
      options.paramOverrides = {
        temperature: param.temperature,
        topP: param.topP,
        topK: param.topK,
        minP: param.minP,
        presencePenalty: param.presencePenalty,
        frequencyPenalty: param.frequencyPenalty,
        repetitionPenalty: param.repetitionPenalty,
      };
    }
    if (model && indices.model > 0) {
      options.modelOverride = model.model;
      options.configIdOverride = model.id;
    }
    if (effort) {
      options.effort = {
        enableThinking: effort.enableThinking,
        thinkingBudget: effort.thinkingBudget,
      };
    }
    return Object.keys(options).length ? options : undefined;
  }, [indices, lengthSteps, moods, params, efforts, authorModels]);

  return {
    labels,
    cycleLength: () => cycle("length", lengthSteps.length),
    cycleMood: () => cycle("mood", moods.length),
    cycleParam: () => cycle("param", params.length),
    cycleModel: () => cycle("model", authorModels.length || 1),
    cycleEffort: () => cycle("effort", efforts.length),
    generationOptions,
  };
}
