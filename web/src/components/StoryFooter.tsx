import type { FormEvent, KeyboardEvent, RefObject } from 'react'
import ButtonContainerRow from './ButtonContainerRow'
import AutoGrowTextarea from './AutoGrowTextarea'
import type { LayoutButton, LayoutContainer, Position, StoryPhase } from '../api'

interface StoryFooterProps {
  error: string | null
  onDismissError: () => void
  /** Virtuoso's scroll container, forwarded to the composer's AutoGrowTextarea so its
   *  per-keystroke resize can protect the log's scroll position — see AutoGrowTextarea. */
  scrollerRef: RefObject<HTMLElement | null>
  editingPageId: string | null
  onSaveEdit: () => void
  onCancelEdit: () => void
  onForkFromEdit: () => void
  onDeleteEdit: () => void
  busy: boolean
  mode: 'guide' | 'play'
  phase: StoryPhase
  canRetry: boolean
  lastEntryPageId?: string
  onRetry: (pageId: string) => void
  onContinue: () => void
  onKickoff: () => void
  onEnterOoc: () => void
  onSetMode: (mode: 'guide' | 'play') => void
  onUndo: () => void
  onRedo: () => void
  position: Position | null
  toolbarContainers: LayoutContainer[]
  toggleLabels: { length: string; mood: string; param: string; model: string; effort: string }
  onCycleLength: () => void
  onCycleMood: () => void
  onCycleParam: () => void
  onCycleModel: () => void
  onCycleEffort: () => void
  showReasoning: boolean
  reasoningExpanded: boolean
  onToggleShowReasoning: () => void
  onToggleReasoningExpanded: () => void
  draft: string
  onDraftChange: (value: string) => void
  onSubmit: (e?: FormEvent) => void
  onReorder?: (
    region: 'nav' | 'inputBar',
    containerId: string,
    reorderedButtons: LayoutButton[],
  ) => void
}

export default function StoryFooter({
  error,
  onDismissError,
  scrollerRef,
  editingPageId,
  onSaveEdit,
  onCancelEdit,
  onForkFromEdit,
  onDeleteEdit,
  busy,
  mode,
  phase,
  canRetry,
  lastEntryPageId,
  onRetry,
  onContinue,
  onKickoff,
  onEnterOoc,
  onSetMode,
  onUndo,
  onRedo,
  position,
  toolbarContainers,
  toggleLabels,
  onCycleLength,
  onCycleMood,
  onCycleParam,
  onCycleModel,
  onCycleEffort,
  showReasoning,
  reasoningExpanded,
  onToggleShowReasoning,
  onToggleReasoningExpanded,
  draft,
  onDraftChange,
  onSubmit,
  onReorder,
}: StoryFooterProps) {
  return (
    <div className="story-view-footer">
      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button
            type="button"
            className="error-banner-dismiss"
            onClick={onDismissError}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      <div className="play-toolbar">
        {editingPageId ? (
          <>
            <button type="button" onClick={() => void onSaveEdit()}>
              Save
            </button>
            <button type="button" onClick={onCancelEdit}>
              Cancel
            </button>
            <button type="button" onClick={() => void onForkFromEdit()}>
              Fork
            </button>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onDeleteEdit}>
              Del
            </button>
          </>
        ) : (
          <ButtonContainerRow
            storageScope="input"
            containers={toolbarContainers}
            resolveLabel={(id, fallback) => {
              if (id === 'toggle.length') return `Length: ${toggleLabels.length}`
              if (id === 'toggle.mood') return `Mood: ${toggleLabels.mood}`
              if (id === 'toggle.param') return `Param: ${toggleLabels.param}`
              if (id === 'toggle.model') return `Model: ${toggleLabels.model}`
              if (id === 'toggle.effort') return `Effort: ${toggleLabels.effort}`
              if (id === 'toggle.reasoning.show') return showReasoning ? 'Trace: On' : 'Trace: Off'
              if (id === 'toggle.reasoning.expand')
                return reasoningExpanded ? 'Trace: Open' : 'Trace: Closed'
              if (id === 'action.kickoff') return 'Kickoff →'
              return fallback ?? id
            }}
            getButtonProps={(id) => {
              if (busy && !id.startsWith('mode.')) {
                // mode switches disabled when busy; toggles too
              }
              if (id === 'mode.ooc') {
                return {
                  onClick: () => void onEnterOoc(),
                  active: mode === 'guide',
                  disabled: busy || !!editingPageId,
                  className: mode === 'guide' ? 'active' : undefined,
                }
              }
              if (id === 'mode.ic') {
                return {
                  onClick: () => onSetMode('play'),
                  active: mode === 'play',
                  disabled: busy || !!editingPageId,
                  className: mode === 'play' ? 'active' : undefined,
                }
              }
              if (id === 'action.undo') {
                return { onClick: () => void onUndo(), disabled: busy || !position?.canUndo }
              }
              if (id === 'action.redo') {
                return { onClick: () => void onRedo(), disabled: busy || !position?.canRedo }
              }
              if (id === 'action.retry') {
                return {
                  onClick: () => lastEntryPageId && onRetry(lastEntryPageId),
                  disabled: busy || !canRetry,
                }
              }
              if (id === 'action.continue') {
                return { onClick: onContinue, disabled: busy }
              }
              if (id === 'action.kickoff') {
                if (mode !== 'guide' || phase !== 'setup') return null
                return { onClick: () => void onKickoff(), disabled: busy || !!editingPageId }
              }
              if (id === 'toggle.length') {
                return { onClick: onCycleLength, disabled: busy || mode !== 'play' }
              }
              if (id === 'toggle.mood') {
                return { onClick: onCycleMood, disabled: busy || mode !== 'play' }
              }
              if (id === 'toggle.param') {
                return { onClick: onCycleParam, disabled: busy || mode !== 'play' }
              }
              if (id === 'toggle.model') {
                return { onClick: onCycleModel, disabled: busy || mode !== 'play' }
              }
              if (
                id === 'toggle.length' ||
                id === 'toggle.mood' ||
                id === 'toggle.param' ||
                id === 'toggle.model'
              ) {
                return null
              }
              if (id === 'toggle.effort') {
                return { onClick: onCycleEffort, disabled: busy || mode !== 'play' }
              }
              if (id === 'toggle.reasoning.show') {
                return { onClick: onToggleShowReasoning, disabled: mode !== 'play' }
              }
              if (id === 'toggle.reasoning.expand') {
                return {
                  onClick: onToggleReasoningExpanded,
                  disabled: mode !== 'play' || !showReasoning,
                }
              }
              return null
            }}
            onReorder={
              onReorder
                ? (containerId, reorderedButtons) =>
                    onReorder('inputBar', containerId, reorderedButtons)
                : undefined
            }
          />
        )}
      </div>

      <form className="composer" onSubmit={onSubmit}>
        <AutoGrowTextarea
          value={draft}
          onChange={onDraftChange}
          protectScrollRef={scrollerRef}
          onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (editingPageId) return
              if (draft.trim()) {
                void onSubmit()
              } else if (!busy) {
                // Continue (unlike Send) isn't queueable — it acts on "whatever's current" once
                // an existing reply resolves, so it stays serialized behind anything pending.
                onContinue()
              }
            }
          }}
          placeholder={
            position && !position.atHead
              ? 'Viewing an earlier point'
              : mode === 'guide'
                ? 'Tell the Editor about your story… (Enter on an empty box continues; also used as guidance for Retry/Continue)'
                : 'Say something… (Enter on an empty box continues; also used as guidance for Retry/Continue)'
          }
          disabled={!!editingPageId}
        />
        <button type="submit" disabled={!!editingPageId || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}
