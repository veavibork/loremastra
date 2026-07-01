import SetupView from "./SetupView";
import KickoffView from "./KickoffView";
import StoryView from "./StoryView";
import type { PanelProps } from "./panel-types";

export default function StoryPlayPanel({ story, phase, onPhaseChange }: PanelProps) {
  if (!story || !phase) return null;

  if (phase === "setup") {
    return <SetupView storyId={story.id} onKickoff={() => onPhaseChange("kickoff")} />;
  }
  if (phase === "kickoff") {
    return (
      <KickoffView
        storyId={story.id}
        onApproved={() => onPhaseChange("story")}
        onBack={() => onPhaseChange("setup")}
      />
    );
  }
  return <StoryView storyId={story.id} />;
}
