import { useEffect, useState } from "react";
import { createStory, fetchLayout, fetchPhase, listStories, type LayoutConfigData, type Story, type StoryPhase } from "./api";
import Nav from "./Nav";
import "./App.css";

export default function App() {
  const [story, setStory] = useState<Story | null>(null);
  const [phase, setPhase] = useState<StoryPhase | null>(null);
  const [layout, setLayout] = useState<LayoutConfigData | null>(null);

  useEffect(() => {
    void (async () => {
      const stories = await listStories();
      const active = stories[0] ?? (await createStory("Default Story"));
      setStory(active);
      setPhase((await fetchPhase(active.id)).phase);
      setLayout((await fetchLayout()).config);
    })();
  }, []);

  if (!layout) return null;

  return (
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
  );
}
