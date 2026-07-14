import StoryView from './StoryView'
import type { PanelProps } from '../lib/panel-types'

export default function StoryPanel({ story, phase, onPhaseChange, inputBar }: PanelProps) {
  if (!story || !phase) return null
  return (
    <StoryView
      storyId={story.id}
      phase={phase}
      onKickedOff={() => onPhaseChange('story')}
      inputBar={inputBar}
    />
  )
}
