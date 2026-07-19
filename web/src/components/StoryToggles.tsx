import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchModelConfigs,
  fetchSettingsSpace,
  type GenerationOptions,
  type ModelConfig,
} from '../api'
import { getStoryToggles, setStoryToggles, type ToggleIndices } from '../store'

export const TOGGLE_LENGTH_SPACE = 'toggle-length'
export const TOGGLE_MOOD_SPACE = 'toggle-mood'
export const TOGGLE_PARAM_SPACE = 'toggle-param'
export const TOGGLE_EFFORT_SPACE = 'toggle-effort'

export interface MoodPreset {
  id: string
  label: string
  promptFragment: string
}

export interface ParamPreset {
  id: string
  label: string
  temperature?: number
  topP?: number
  topK?: number
  minP?: number
  presencePenalty?: number
  frequencyPenalty?: number
  repetitionPenalty?: number
}

export interface EffortPreset {
  id: string
  label: string
  enableThinking: boolean
  thinkingBudget?: number
}

/** 0 = "Auto": no per-post override, the Author agent's configured responseLimit applies. */
const DEFAULT_LENGTH = [0, 100, 300, 500]
const DEFAULT_MOOD: MoodPreset[] = [
  { id: 'neutral', label: 'Neutral', promptFragment: '' },
  { id: 'tense', label: 'Tense', promptFragment: 'The atmosphere is tense and urgent.' },
  { id: 'cozy', label: 'Cozy', promptFragment: 'The mood is warm and comfortable.' },
]
const DEFAULT_PARAMS: ParamPreset[] = [
  { id: 'default', label: 'Default' },
  { id: 'creative', label: 'Creative', temperature: 1.1, topP: 0.95 },
  { id: 'precise', label: 'Precise', temperature: 0.5, topP: 0.8 },
]
const DEFAULT_EFFORT: EffortPreset[] = [
  { id: 'standard', label: 'Standard', enableThinking: false },
  { id: 'thinking', label: 'Thinking', enableThinking: true, thinkingBudget: 4096 },
  { id: 'deep', label: 'Deep', enableThinking: true, thinkingBudget: 16384 },
]

export function useStoryToggles(storyId: string) {
  const [lengthSteps, setLengthSteps] = useState<number[]>(DEFAULT_LENGTH)
  const [moods, setMoods] = useState<MoodPreset[]>(DEFAULT_MOOD)
  const [params, setParams] = useState<ParamPreset[]>(DEFAULT_PARAMS)
  const [efforts, setEfforts] = useState<EffortPreset[]>(DEFAULT_EFFORT)
  const [authorModels, setAuthorModels] = useState<ModelConfig[]>([])
  const [indices, setIndices] = useState<ToggleIndices>(() => getStoryToggles(storyId))

  useEffect(() => {
    setIndices(getStoryToggles(storyId))
  }, [storyId])

  useEffect(() => {
    void Promise.all([
      fetchSettingsSpace<number[]>(TOGGLE_LENGTH_SPACE),
      fetchSettingsSpace<MoodPreset[]>(TOGGLE_MOOD_SPACE),
      fetchSettingsSpace<ParamPreset[]>(TOGGLE_PARAM_SPACE),
      fetchSettingsSpace<EffortPreset[]>(TOGGLE_EFFORT_SPACE),
      fetchModelConfigs(),
    ])
      .then(([len, mood, param, effort, configs]) => {
        if (len?.length) setLengthSteps(len)
        if (mood?.length) setMoods(mood)
        if (param?.length) setParams(param)
        if (effort?.length) setEfforts(effort)
        setAuthorModels(configs.filter((c) => c.active && c.useAuthor))
      })
      .catch(() => {})
  }, [])

  const persist = useCallback(
    (next: ToggleIndices) => {
      setIndices(next)
      setStoryToggles(storyId, next)
    },
    [storyId],
  )

  function cycle(field: keyof ToggleIndices, max: number) {
    persist({ ...indices, [field]: (indices[field] + 1) % Math.max(max, 1) })
  }

  const labels = useMemo(() => {
    const len = lengthSteps[indices.length % lengthSteps.length] ?? lengthSteps[0]
    const mood = moods[indices.mood % moods.length]
    const param = params[indices.param % params.length]
    const model = authorModels[indices.model % Math.max(authorModels.length, 1)]
    const effort = efforts[indices.effort % efforts.length]
    return {
      length: len != null ? (len === 0 ? 'Auto' : `${len}t`) : 'Length',
      mood: mood?.label ?? 'Mood',
      param: param?.label ?? 'Param',
      model: model?.model?.split('/').pop() ?? 'Model',
      effort: effort?.label ?? 'Effort',
    }
  }, [indices, lengthSteps, moods, params, efforts, authorModels])

  const generationOptions = useCallback((): GenerationOptions | undefined => {
    // Mood / param / model toggles disabled — Length and Effort are wired.
    const options: GenerationOptions = {}
    const len = lengthSteps[indices.length % lengthSteps.length]
    // 0 = "Auto": send no override, the Author agent's configured responseLimit applies.
    if (len != null && len > 0) options.responseLimit = len
    const effort = efforts[indices.effort % efforts.length]
    if (effort) {
      options.effort = {
        enableThinking: effort.enableThinking,
        thinkingBudget: effort.thinkingBudget,
      }
    }
    return Object.keys(options).length ? options : undefined
  }, [indices.length, indices.effort, lengthSteps, efforts])

  /* Disabled toggle wiring (mood/param/model) — re-enable when presets are tuned.
  const generationOptionsFull = useCallback((): GenerationOptions | undefined => {
    const mood = moods[indices.mood % moods.length];
    const param = params[indices.param % params.length];
    const model = authorModels[indices.model % Math.max(authorModels.length, 1)];
    const options: GenerationOptions = {};
    if (mood?.promptFragment?.trim()) options.moodFragment = mood.promptFragment.trim();
    if (param && param.id !== "default") {
      options.paramOverrides = { temperature: param.temperature, topP: param.topP, ... };
    }
    if (model && indices.model > 0) {
      options.modelOverride = model.model;
      options.configIdOverride = model.id;
    }
    ...
  }, [...]);
  */

  return {
    labels,
    cycleLength: () => cycle('length', lengthSteps.length),
    cycleMood: () => cycle('mood', moods.length),
    cycleParam: () => cycle('param', params.length),
    cycleModel: () => cycle('model', authorModels.length || 1),
    cycleEffort: () => cycle('effort', efforts.length),
    generationOptions,
  }
}
