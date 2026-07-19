import { useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchLayout,
  updateLayout,
  fetchSettingsSpace,
  saveSettingsSpace,
  revertSettingsSpace,
  type LayoutCatalog,
  type LayoutConfigData,
} from '../api'
import LayoutEditor from '../components/LayoutEditor'
import SettingsTreeEditor, {
  type JsonData,
  type SettingsSection,
} from '../components/SettingsTreeEditor'
import AccountSettings from './AccountSettings'
import {
  applyGlobalCssSettings,
  GLOBAL_CSS_SPACE,
  type GlobalCssSettings,
} from '../lib/global-css-settings'
import {
  DEFAULT_PLAY_TAB_SETTINGS,
  PLAY_TAB_SPACE,
  useSetPlayTabSettings,
  type PlayTabSettings,
} from '../components/PlayTabSettings'
import './SettingsView.css'

import {
  TOGGLE_LENGTH_SPACE,
  TOGGLE_MOOD_SPACE,
  TOGGLE_PARAM_SPACE,
  TOGGLE_EFFORT_SPACE,
} from '../components/StoryToggles'

const BANNED_PHRASES_SPACE = 'banned-phrases'

const SETTINGS_SPACES = [
  BANNED_PHRASES_SPACE,
  GLOBAL_CSS_SPACE,
  PLAY_TAB_SPACE,
  TOGGLE_LENGTH_SPACE,
  TOGGLE_MOOD_SPACE,
  TOGGLE_PARAM_SPACE,
  TOGGLE_EFFORT_SPACE,
  'layout',
] as const

export default function SettingsView() {
  const [layout, setLayout] = useState<LayoutConfigData | null>(null)
  const [layoutCatalog, setLayoutCatalog] = useState<LayoutCatalog | null>(null)
  const [bannedPhrases, setBannedPhrases] = useState<string[] | null>(null)
  const [globalCss, setGlobalCss] = useState<GlobalCssSettings | null>(null)
  const [playTab, setPlayTab] = useState<PlayTabSettings | null>(null)
  const [toggleLength, setToggleLength] = useState<number[] | null>(null)
  const [toggleMood, setToggleMood] = useState<unknown[] | null>(null)
  const [toggleParam, setToggleParam] = useState<unknown[] | null>(null)
  const [toggleEffort, setToggleEffort] = useState<unknown[] | null>(null)
  const [sectionErrors, setSectionErrors] = useState<Record<string, string>>({})
  const setLivePlayTabSettings = useSetPlayTabSettings()

  useEffect(() => {
    // Each section is fetched independently; a failure is recorded per-space so it can't leave
    // an unhandled rejection or hang the "Loading N sections…" counter forever.
    const reportError = (space: string) => (err: unknown) => {
      console.error(err)
      setSectionErrors((prev) => ({
        ...prev,
        [space]: err instanceof Error ? err.message : String(err),
      }))
    }
    void fetchLayout()
      .then((res) => {
        setLayout(res.config)
        setLayoutCatalog(res.catalog ?? null)
      })
      .catch(reportError('layout'))
    void fetchSettingsSpace<string[]>(BANNED_PHRASES_SPACE)
      .then(setBannedPhrases)
      .catch(reportError(BANNED_PHRASES_SPACE))
    void fetchSettingsSpace<GlobalCssSettings>(GLOBAL_CSS_SPACE)
      .then(setGlobalCss)
      .catch(reportError(GLOBAL_CSS_SPACE))
    void fetchSettingsSpace<Partial<PlayTabSettings>>(PLAY_TAB_SPACE)
      .then((saved) => setPlayTab({ ...DEFAULT_PLAY_TAB_SETTINGS, ...saved }))
      .catch(reportError(PLAY_TAB_SPACE))
    void fetchSettingsSpace<number[]>(TOGGLE_LENGTH_SPACE)
      .then(setToggleLength)
      .catch(reportError(TOGGLE_LENGTH_SPACE))
    void fetchSettingsSpace<unknown[]>(TOGGLE_MOOD_SPACE)
      .then(setToggleMood)
      .catch(reportError(TOGGLE_MOOD_SPACE))
    void fetchSettingsSpace<unknown[]>(TOGGLE_PARAM_SPACE)
      .then(setToggleParam)
      .catch(reportError(TOGGLE_PARAM_SPACE))
    void fetchSettingsSpace<unknown[]>(TOGGLE_EFFORT_SPACE)
      .then(setToggleEffort)
      .catch(reportError(TOGGLE_EFFORT_SPACE))
  }, [])

  const persistedGlobalCss = useRef<GlobalCssSettings | null>(null)
  useEffect(() => {
    persistedGlobalCss.current = globalCss
  }, [globalCss])
  const persistedPlayTab = useRef<PlayTabSettings | null>(null)
  useEffect(() => {
    persistedPlayTab.current = playTab
  }, [playTab])
  useEffect(() => {
    return () => {
      if (persistedGlobalCss.current) applyGlobalCssSettings(persistedGlobalCss.current)
      if (persistedPlayTab.current) setLivePlayTabSettings(persistedPlayTab.current)
    }
  }, [setLivePlayTabSettings])

  const sections = useMemo(() => {
    const out: SettingsSection[] = []

    if (bannedPhrases) {
      out.push({
        key: BANNED_PHRASES_SPACE,
        title: 'Banned words/phrases',
        description:
          'Matched (case-insensitively) against the start of Worker/Editor compress and archive replies only — ' +
          'these summaries feed the worldbook and are never shown to you directly. A match is treated as the model ' +
          "refusing the task and triggers a retry. Not applied to live Author prose or the Editor's visible setup " +
          'replies, and not sent as a generation-time stop list.',
        value: bannedPhrases as unknown as JsonData,
        onSave: async (value) => {
          const saved = await saveSettingsSpace(BANNED_PHRASES_SPACE, value)
          setBannedPhrases(saved as string[])
          return saved as unknown as JsonData
        },
        onRevert: async () => {
          const reverted = await revertSettingsSpace<string[]>(BANNED_PHRASES_SPACE)
          setBannedPhrases(reverted)
          return reverted as unknown as JsonData
        },
      })
    }

    if (globalCss) {
      out.push({
        key: GLOBAL_CSS_SPACE,
        title: 'Global CSS',
        description:
          'Light/dark color variables, root font size, and the narrow-screen breakpoint used across the whole app. ' +
          'Edits apply immediately as a preview; navigating away without saving reverts them.',
        value: globalCss as unknown as JsonData,
        onChange: (value) => applyGlobalCssSettings(value as unknown as GlobalCssSettings),
        onSave: async (value) => {
          const saved = await saveSettingsSpace(GLOBAL_CSS_SPACE, value)
          setGlobalCss(saved as unknown as GlobalCssSettings)
          return saved as unknown as JsonData
        },
        onRevert: async () => {
          const reverted = await revertSettingsSpace<GlobalCssSettings>(GLOBAL_CSS_SPACE)
          setGlobalCss(reverted)
          applyGlobalCssSettings(reverted)
          return reverted as unknown as JsonData
        },
      })
    }

    if (playTab) {
      out.push({
        key: PLAY_TAB_SPACE,
        title: 'Story tab',
        description:
          "Controls how posts render in the Story tab's OOC and IC modes: post font size, whether the user/editor " +
          'role labels are shown at all, what text they use, whether editor posts render in italics, per-role text ' +
          'color, and per-role chat-bubble backgrounds (color + on/off). Edits apply immediately as a preview; ' +
          'navigating away without saving reverts them.',
        value: playTab as unknown as JsonData,
        onChange: (value) => setLivePlayTabSettings(value as unknown as PlayTabSettings),
        onSave: async (value) => {
          const saved = await saveSettingsSpace(PLAY_TAB_SPACE, value)
          setPlayTab(saved as unknown as PlayTabSettings)
          return saved as unknown as JsonData
        },
        onRevert: async () => {
          const reverted = await revertSettingsSpace<PlayTabSettings>(PLAY_TAB_SPACE)
          setPlayTab(reverted)
          setLivePlayTabSettings(reverted)
          return reverted as unknown as JsonData
        },
      })
    }

    if (toggleLength !== null) {
      out.push({
        key: TOGGLE_LENGTH_SPACE,
        parent: 'preset',
        parentKey: 'length',
        title: 'Length steps',
        description:
          'Token counts cycled by the input bar Length toggle (Author responseLimit override). 0 = Auto: no override, the agent default applies.',
        value: toggleLength as unknown as JsonData,
        onSave: async (value) => {
          const saved = await saveSettingsSpace(TOGGLE_LENGTH_SPACE, value)
          setToggleLength(saved as number[])
          return saved as unknown as JsonData
        },
        onRevert: async () => {
          const reverted = await revertSettingsSpace<number[]>(TOGGLE_LENGTH_SPACE)
          setToggleLength(reverted)
          return reverted as unknown as JsonData
        },
      })
    }

    if (toggleMood !== null) {
      out.push({
        key: TOGGLE_MOOD_SPACE,
        parent: 'preset',
        parentKey: 'mood',
        title: 'Mood presets',
        description: 'Named prompt fragments appended when the Mood toggle is active.',
        value: toggleMood as unknown as JsonData,
        onSave: async (value) => {
          const saved = await saveSettingsSpace(TOGGLE_MOOD_SPACE, value)
          setToggleMood(saved as unknown[])
          return saved as unknown as JsonData
        },
        onRevert: async () => {
          const reverted = await revertSettingsSpace<unknown[]>(TOGGLE_MOOD_SPACE)
          setToggleMood(reverted)
          return reverted as unknown as JsonData
        },
      })
    }

    if (toggleParam !== null) {
      out.push({
        key: TOGGLE_PARAM_SPACE,
        parent: 'preset',
        parentKey: 'param',
        title: 'Param presets',
        description:
          'Sampler overrides merged atop the Author profile when Param toggle is active.',
        value: toggleParam as unknown as JsonData,
        onSave: async (value) => {
          const saved = await saveSettingsSpace(TOGGLE_PARAM_SPACE, value)
          setToggleParam(saved as unknown[])
          return saved as unknown as JsonData
        },
        onRevert: async () => {
          const reverted = await revertSettingsSpace<unknown[]>(TOGGLE_PARAM_SPACE)
          setToggleParam(reverted)
          return reverted as unknown as JsonData
        },
      })
    }

    if (toggleEffort !== null) {
      out.push({
        key: TOGGLE_EFFORT_SPACE,
        parent: 'preset',
        parentKey: 'effort',
        title: 'Effort presets',
        description:
          'Reasoning/thinking kwargs passed when Effort toggle is active (model-dependent).',
        value: toggleEffort as unknown as JsonData,
        onSave: async (value) => {
          const saved = await saveSettingsSpace(TOGGLE_EFFORT_SPACE, value)
          setToggleEffort(saved as unknown[])
          return saved as unknown as JsonData
        },
        onRevert: async () => {
          const reverted = await revertSettingsSpace<unknown[]>(TOGGLE_EFFORT_SPACE)
          setToggleEffort(reverted)
          return reverted as unknown as JsonData
        },
      })
    }

    if (layout) {
      out.push({
        key: 'layout',
        title: 'Layout (advanced)',
        description:
          'Raw JSON for the nav tab bar and story input bar layout (v2). Prefer the "Layout buttons" ' +
          'editor above — this escape hatch edits the same config directly.',
        value: layout as unknown as JsonData,
        onSave: async (value) => {
          const res = await updateLayout(value as unknown as LayoutConfigData)
          setLayout(res.config)
          return res.config as unknown as JsonData
        },
      })
    }

    return out
  }, [
    bannedPhrases,
    globalCss,
    playTab,
    toggleLength,
    toggleMood,
    toggleParam,
    toggleEffort,
    layout,
    setLivePlayTabSettings,
  ])

  const loadedCount = sections.length
  const erroredSpaces = Object.keys(sectionErrors)
  const pendingCount = SETTINGS_SPACES.length - loadedCount - erroredSpaces.length

  return (
    <div className="settings-view">
      <h2>Settings</h2>
      {pendingCount > 0 && (
        <p className="settings-note">
          Loading {pendingCount} section{pendingCount === 1 ? '' : 's'}…
        </p>
      )}
      {erroredSpaces.length > 0 && (
        <div className="error-banner">
          Failed to load {erroredSpaces.length} section{erroredSpaces.length === 1 ? '' : 's'}:{' '}
          {erroredSpaces.map((space) => sectionErrors[space]).join('; ')}
        </div>
      )}
      <AccountSettings />
      {layout && layoutCatalog && (
        <LayoutEditor
          layout={layout}
          catalog={layoutCatalog}
          onSave={async (config) => {
            const res = await updateLayout(config)
            setLayout(res.config)
            return res.config
          }}
        />
      )}
      {loadedCount > 0 && <SettingsTreeEditor sections={sections} />}
    </div>
  )
}
