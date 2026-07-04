/**
 * loremaster.md's UI Structure section: every component's size/position lives in a per-user data
 * structure rather than hardcoded markup. Phase 1 is read-only (no drag-and-drop editor) — this is
 * the config shape that drives the nav; editing it happens as a direct JSON edit (Settings >
 * Layout), which is what "configuration-file-level task, not a user-facing drag-and-drop
 * interface" means for Phase 1. Flat and ordered on purpose: the tab bar has no visual grouping or
 * nested containers today, so a nested sections/tabs shape would claim structure the UI doesn't
 * actually have. `id` doubles as the registry key each tab resolves to (see web/src/registry.tsx).
 */
export interface LayoutTab {
  id: string;
  label: string;
}

export interface LayoutConfigData {
  tabs: LayoutTab[];
}

/** Tabs removed from the product — stripped from saved layouts on load. */
const REMOVED_TAB_IDS = new Set(["story:summary", "lore:tags", "debug:"]);

export const DEFAULT_LAYOUT_CONFIG: LayoutConfigData = {
  tabs: [
    { id: "story:play", label: "Story" },
    { id: "story:saves", label: "Saves" },
    { id: "story:logs", label: "Logs" },
    { id: "story:archives", label: "Archives" },
    { id: "lore:worldbook", label: "Worldbook" },
    { id: "lore:memory", label: "Memory" },
    { id: "config:agents", label: "Agents" },
    { id: "config:prompts", label: "Prompts" },
    { id: "settings:", label: "Settings" },
  ],
};

/** Inject tabs added to DEFAULT_LAYOUT_CONFIG into older saved layouts (read-only merge). */
export function mergeLayoutWithDefaults(config: LayoutConfigData): LayoutConfigData {
  const tabs = config.tabs.filter((t) => !REMOVED_TAB_IDS.has(t.id));
  const existingIds = new Set(tabs.map((t) => t.id));
  const missing = DEFAULT_LAYOUT_CONFIG.tabs.filter((t) => !existingIds.has(t.id));
  if (missing.length === 0 && tabs.length === config.tabs.length) return config;

  const merged = [...tabs];
  for (const tab of missing) {
    const defaultIdx = DEFAULT_LAYOUT_CONFIG.tabs.findIndex((t) => t.id === tab.id);
    let insertAt = merged.length;
    for (let i = defaultIdx - 1; i >= 0; i--) {
      const anchorIdx = merged.findIndex((t) => t.id === DEFAULT_LAYOUT_CONFIG.tabs[i]!.id);
      if (anchorIdx >= 0) {
        insertAt = anchorIdx + 1;
        break;
      }
    }
    merged.splice(insertAt, 0, tab);
  }
  return { tabs: merged };
}
