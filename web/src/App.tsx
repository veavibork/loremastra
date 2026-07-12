import { useEffect, useState } from 'react'
import {
  createStory,
  fetchLayout,
  fetchPhase,
  getSessionId,
  listStories,
  onSuperseded,
  type LayoutConfigData,
  type Story,
  type StoryPhase,
  type SupersededInfo,
} from './api'
import ClaimGate, { type GateReason } from './ClaimGate'
import Nav from './Nav'
import { useGlobalCssSettings } from './globalCssSettings'
import { PlayTabProvider } from './playTabSettings'
import { useVisualViewport } from './useVisualViewport'
import './App.css'

interface GateState {
  reason: GateReason
  info: SupersededInfo | null
}

const SELECTED_STORY_STORAGE_KEY = 'loremaster.selectedStoryId'

export default function App() {
  const [gate, setGate] = useState<GateState | null>(() =>
    getSessionId() ? null : { reason: 'no-session', info: null },
  )
  const [story, setStory] = useState<Story | null>(null)
  const [phase, setPhase] = useState<StoryPhase | null>(null)
  const [layout, setLayout] = useState<LayoutConfigData | null>(null)

  useGlobalCssSettings(!gate)
  useVisualViewport()

  function selectStory(next: Story) {
    localStorage.setItem(SELECTED_STORY_STORAGE_KEY, next.id)
    setStory(next)
  }

  useEffect(() => onSuperseded((info) => setGate({ reason: info.reason, info })), [])

  useEffect(() => {
    if (gate) return // don't bootstrap while gated — onSuperseded already flipped us here if a call failed
    void (async () => {
      try {
        const stories = await listStories()
        const savedId = localStorage.getItem(SELECTED_STORY_STORAGE_KEY)
        const active =
          stories.find((s) => s.id === savedId) ??
          stories[0] ??
          (await createStory('Default Story'))
        selectStory(active)
        setPhase((await fetchPhase(active.id)).phase)
        setLayout((await fetchLayout()).config)
      } catch {
        // A 409 already notified onSuperseded above; nothing else to do with the rejection here.
      }
    })()
  }, [gate])

  if (gate) {
    return <ClaimGate reason={gate.reason} info={gate.info} onClaimed={() => setGate(null)} />
  }
  if (!layout) return null

  return (
    <PlayTabProvider>
      <div className="story-app">
        <header className="app-header">
          <div className="app-header-title">
            <h1>{story?.name ?? 'Loremaster'}</h1>
            {story?.id && <span className="app-header-story-id">{story.id}</span>}
            <span className="app-header-build-info" title={__BUILD_INFO__.builtAt}>
              {__BUILD_INFO__.commit}
            </span>
          </div>
        </header>

        <Nav
          config={layout}
          panelProps={{
            story,
            phase,
            onStoryChange: selectStory,
            onPhaseChange: setPhase,
          }}
        />
      </div>
    </PlayTabProvider>
  )
}
