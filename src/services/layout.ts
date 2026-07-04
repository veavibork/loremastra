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

export const DEFAULT_LAYOUT_CONFIG: LayoutConfigData = {
  tabs: [
    { id: "story:play", label: "Story" },
    { id: "story:saves", label: "Saves" },
    { id: "story:logs", label: "Logs" },
    { id: "story:summary", label: "Summary" },
    { id: "story:archives", label: "Archives" },
    { id: "lore:tags", label: "Tags" },
    { id: "lore:worldbook", label: "Worldbook" },
    { id: "lore:memory", label: "Memory" },
    { id: "config:agents", label: "Agents" },
    { id: "config:prompts", label: "Prompts" },
    { id: "debug:", label: "Debug" },
    { id: "settings:", label: "Settings" },
  ],
};

/** Inject tabs added to DEFAULT_LAYOUT_CONFIG into older saved layouts (read-only merge). */
export function mergeLayoutWithDefaults(config: LayoutConfigData): LayoutConfigData {
  const existingIds = new Set(config.tabs.map((t) => t.id));
  const missing = DEFAULT_LAYOUT_CONFIG.tabs.filter((t) => !existingIds.has(t.id));
  if (missing.length === 0) return config;

  const tabs = [...config.tabs];
  for (const tab of missing) {
    const defaultIdx = DEFAULT_LAYOUT_CONFIG.tabs.findIndex((t) => t.id === tab.id);
    let insertAt = tabs.length;
    for (let i = defaultIdx - 1; i >= 0; i--) {
      const anchorIdx = tabs.findIndex((t) => t.id === DEFAULT_LAYOUT_CONFIG.tabs[i]!.id);
      if (anchorIdx >= 0) {
        insertAt = anchorIdx + 1;
        break;
      }
    }
    tabs.splice(insertAt, 0, tab);
  }
  return { tabs };
}
