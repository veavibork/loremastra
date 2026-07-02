import { useEffect, useState } from "react";
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
} from "./api";
import ClaimGate, { type GateReason } from "./ClaimGate";
import Nav from "./Nav";
import { useGlobalCssSettings } from "./globalCssSettings";
import { PlayTabProvider } from "./playTabSettings";
import "./App.css";

interface GateState {
  reason: GateReason;
  info: SupersededInfo | null;
}

export default function App() {
  const [gate, setGate] = useState<GateState | null>(() =>
    getSessionId() ? null : { reason: "no-session", info: null }
  );
  const [story, setStory] = useState<Story | null>(null);
  const [phase, setPhase] = useState<StoryPhase | null>(null);
  const [layout, setLayout] = useState<LayoutConfigData | null>(null);

  useGlobalCssSettings(!gate);

  useEffect(() => onSuperseded((info) => setGate({ reason: info.reason, info })), []);

  useEffect(() => {
    if (gate) return; // don't bootstrap while gated — onSuperseded already flipped us here if a call failed
    void (async () => {
      try {
        const stories = await listStories();
        const active = stories[0] ?? (await createStory("Default Story"));
        setStory(active);
        setPhase((await fetchPhase(active.id)).phase);
        setLayout((await fetchLayout()).config);
      } catch {
        // A 409 already notified onSuperseded above; nothing else to do with the rejection here.
      }
    })();
  }, [gate]);

  if (gate) {
    return <ClaimGate reason={gate.reason} info={gate.info} onClaimed={() => setGate(null)} />;
  }
  if (!layout) return null;

  return (
    <PlayTabProvider>
      <div className="story-app">
        <header className="app-header">
          <h1>{story?.name ?? "Loremaster"}</h1>
        </header>

        <Nav
          config={layout}
          panelProps={{
            story,
            phase,
            onStoryChange: setStory,
            onPhaseChange: setPhase,
          }}
        />
      </div>
    </PlayTabProvider>
  );
}
