import type { LayoutButton, LayoutRegion, Story, StoryPhase } from '../api'

/** Common props every registry-resolved panel receives — not every panel uses all of them, but a uniform shape keeps the registry simple (config-driven: which panel renders is data, not a hardcoded switch). */
export interface PanelProps {
  story: Story | null
  phase: StoryPhase | null
  onStoryChange: (story: Story) => void
  onPhaseChange: (phase: StoryPhase) => void
  inputBar?: LayoutRegion
  onReorder?: (
    region: 'nav' | 'inputBar',
    containerId: string,
    reorderedButtons: LayoutButton[],
  ) => void
}
