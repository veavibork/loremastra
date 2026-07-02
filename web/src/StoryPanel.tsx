import StoryView from "./StoryView";
import type { PanelProps } from "./panel-types";

export default function StoryPanel({ story, phase, onPhaseChange }: PanelProps) {
  if (!story || !phase) return null;
  return <StoryView storyId={story.id} phase={phase} onKickedOff={() => onPhaseChange("story")} />;
}
