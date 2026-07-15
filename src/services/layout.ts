/**
 * Per-user UI layout: nav tab bar and story input bar, both driven by nested button containers.
 * Phase 1 is JSON-editable (Settings > Layout); drag-and-drop reorder is deferred.
 */

export type LayoutJustify = 'left' | 'center' | 'right'

export interface LayoutButton {
  id: string
  label?: string
  visible: boolean
}

export interface LayoutContainer {
  id: string
  label?: string
  visible: boolean
  showButton: boolean
  showLabel: boolean
  justify: LayoutJustify
  buttons: LayoutButton[]
}

export interface LayoutRegion {
  containers: LayoutContainer[]
}

/** v1 shape — migrated to v2 on load. */
export interface LayoutConfigV1 {
  tabs: Array<{ id: string; label: string }>
}

export interface LayoutConfigData {
  version: 2
  nav: LayoutRegion
  inputBar: LayoutRegion
}

/** Tab ids removed from the product — stripped from saved layouts on load. */
const REMOVED_TAB_IDS = new Set([
  'story:summary',
  'lore:tags',
  'debug:',
  'story:archives',
  'lore:memory',
  'settings:',
])

const TAB_LABELS: Record<string, string> = {
  'story:play': 'Story',
  'story:saves': 'Saves',
  'story:logs': 'Logs',
  'story:queue': 'Queue',
  'story:segments': 'Segments',
  'lore:worldbook': 'Worldbook',
  'lore:context': 'Context',
  'config:agents': 'Agents',
  'config:prompts': 'Prompts',
  'preferences:': 'Settings',
}

export const INPUT_BAR_BUTTON_LABELS: Record<string, string> = {
  'mode.ooc': 'OOC',
  'mode.ic': 'IC',
  'action.undo': '↶ Undo',
  'action.redo': '↷ Redo',
  'action.retry': 'Retry',
  'action.continue': 'Continue',
  'toggle.length': 'Length',
  'toggle.mood': 'Mood',
  'toggle.param': 'Param',
  'toggle.model': 'Model',
  'toggle.effort': 'Effort',
  'toggle.reasoning.show': 'Trace',
  'toggle.reasoning.expand': 'Trace open',
}

export const DEFAULT_LAYOUT_CONFIG: LayoutConfigData = {
  version: 2,
  nav: {
    containers: [
      {
        id: 'nav-primary',
        visible: true,
        showButton: false,
        showLabel: false,
        justify: 'left',
        buttons: [
          { id: 'story:play', label: 'Story', visible: true },
          { id: 'lore:worldbook', label: 'Worldbook', visible: true },
          { id: 'story:segments', label: 'Segments', visible: true },
          { id: 'lore:context', label: 'Context', visible: true },
        ],
      },
      {
        id: 'debug',
        label: 'Debug',
        visible: true,
        showButton: true,
        showLabel: true,
        justify: 'center',
        buttons: [
          { id: 'story:queue', label: 'Queue', visible: true },
          { id: 'story:logs', label: 'Logs', visible: true },
          { id: 'config:agents', label: 'Agents', visible: true },
          { id: 'config:prompts', label: 'Prompts', visible: true },
        ],
      },
      {
        id: 'nav-util',
        visible: true,
        showButton: false,
        showLabel: false,
        justify: 'right',
        buttons: [
          { id: 'preferences:', label: 'Settings', visible: true },
          { id: 'story:saves', label: 'Saves', visible: true },
        ],
      },
    ],
  },
  inputBar: {
    containers: [
      {
        id: 'input-nav',
        visible: true,
        showButton: false,
        showLabel: false,
        justify: 'left',
        buttons: [
          { id: 'mode.ooc', label: 'OOC', visible: true },
          { id: 'mode.ic', label: 'IC', visible: true },
          { id: 'action.undo', label: '↶ Undo', visible: true },
          { id: 'action.redo', label: '↷ Redo', visible: true },
        ],
      },
      {
        id: 'input-toggles',
        visible: true,
        showButton: false,
        showLabel: false,
        justify: 'center',
        buttons: [
          { id: 'toggle.effort', label: 'Effort', visible: true },
          { id: 'toggle.reasoning.show', label: 'Trace', visible: true },
          { id: 'toggle.reasoning.expand', label: 'Trace open', visible: true },
        ],
      },
      {
        id: 'input-actions',
        visible: true,
        showButton: false,
        showLabel: false,
        justify: 'right',
        buttons: [
          { id: 'action.retry', label: 'Retry', visible: true },
          { id: 'action.continue', label: 'Continue', visible: true },
          { id: 'action.kickoff', label: 'Kickoff →', visible: true },
        ],
      },
    ],
  },
}

function stripRemovedButtons(buttons: LayoutButton[]): LayoutButton[] {
  return buttons.filter((b) => !REMOVED_TAB_IDS.has(b.id))
}

function normalizeButton(btn: LayoutButton): LayoutButton {
  return {
    id: btn.id,
    label: btn.label,
    visible: btn.visible !== false,
  }
}

function normalizeButtons(buttons: LayoutButton[]): LayoutButton[] {
  return stripRemovedButtons(buttons).map(normalizeButton)
}

function mergeInputBarButtons(config: LayoutConfigData): LayoutConfigData {
  const existingIds = new Set(config.inputBar.containers.flatMap((c) => c.buttons.map((b) => b.id)))
  const missing: LayoutButton[] = []
  for (const container of DEFAULT_LAYOUT_CONFIG.inputBar.containers) {
    for (const btn of container.buttons) {
      if (!existingIds.has(btn.id)) {
        missing.push(btn)
        existingIds.add(btn.id)
      }
    }
  }
  if (missing.length === 0) return config

  const toggles =
    config.inputBar.containers.find((c) => c.id === 'input-toggles') ??
    config.inputBar.containers[0]
  if (!toggles) return config
  return {
    ...config,
    inputBar: {
      containers: config.inputBar.containers.map((c) =>
        c.id === toggles.id ? { ...c, buttons: [...c.buttons, ...missing] } : c,
      ),
    },
  }
}

function mergeNavButtons(config: LayoutConfigData): LayoutConfigData {
  let result = config
  for (const defaultContainer of DEFAULT_LAYOUT_CONFIG.nav.containers) {
    for (const btn of defaultContainer.buttons) {
      if (REMOVED_TAB_IDS.has(btn.id)) continue
      const already = result.nav.containers.some((c) => c.buttons.some((b) => b.id === btn.id))
      if (already) continue
      const target =
        result.nav.containers.find((c) => c.id === defaultContainer.id) ?? result.nav.containers[0]
      if (!target) continue
      result = {
        ...result,
        nav: {
          containers: result.nav.containers.map((c) =>
            c.id === target.id ? { ...c, buttons: [...c.buttons, btn] } : c,
          ),
        },
      }
    }
  }
  return result
}

function migrateV1(raw: LayoutConfigV1): LayoutConfigData {
  const tabs = raw.tabs.filter((t) => !REMOVED_TAB_IDS.has(t.id))
  const tabIds = new Set(tabs.map((t) => t.id))

  function pick(ids: string[]): LayoutButton[] {
    return ids
      .filter((id) => tabIds.has(id))
      .map((id) => ({
        id,
        label: tabs.find((t) => t.id === id)?.label ?? TAB_LABELS[id] ?? id,
        visible: true,
      }))
  }

  const defaults = DEFAULT_LAYOUT_CONFIG.nav.containers
  return {
    version: 2,
    nav: {
      containers: defaults.map((dc) => ({
        ...dc,
        buttons: pick(dc.buttons.map((b) => b.id)),
      })),
    },
    inputBar: DEFAULT_LAYOUT_CONFIG.inputBar,
  }
}

export function normalizeLayoutConfig(raw: unknown): LayoutConfigData {
  if (!raw || typeof raw !== 'object') return DEFAULT_LAYOUT_CONFIG

  const obj = raw as Record<string, unknown>
  if (obj.version === 2 && obj.nav && obj.inputBar) {
    const config = obj as unknown as LayoutConfigData
    return mergeInputBarButtons(
      mergeNavButtons({
        version: 2,
        nav: {
          containers: config.nav.containers
            .filter((c) => c.visible !== false)
            .map((c) => ({
              ...c,
              buttons: normalizeButtons(c.buttons ?? []),
            })),
        },
        inputBar: {
          containers: (config.inputBar.containers ?? DEFAULT_LAYOUT_CONFIG.inputBar.containers).map(
            (c) => ({
              ...c,
              buttons: normalizeButtons(c.buttons ?? []),
            }),
          ),
        },
      }),
    )
  }

  const v1 = obj as unknown as LayoutConfigV1
  if (Array.isArray(v1.tabs)) {
    return mergeNavButtons(migrateV1(v1))
  }

  return DEFAULT_LAYOUT_CONFIG
}

/** @deprecated Use normalizeLayoutConfig — kept for callers during transition. */
export function mergeLayoutWithDefaults(
  config: LayoutConfigV1 | LayoutConfigData,
): LayoutConfigData {
  return normalizeLayoutConfig(config)
}

/** Flat tab list derived from nav containers — for open-tab validation and Settings display. */
export function flattenNavTabs(config: LayoutConfigData): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = []
  const seen = new Set<string>()
  for (const container of config.nav.containers) {
    if (!container.visible) continue
    for (const btn of container.buttons) {
      if (!btn.visible) continue
      if (seen.has(btn.id)) continue
      seen.add(btn.id)
      out.push({ id: btn.id, label: btn.label ?? TAB_LABELS[btn.id] ?? btn.id })
    }
  }
  return out
}
