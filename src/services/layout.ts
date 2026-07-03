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
    { id: "lore:tags", label: "Tags" },
    { id: "lore:worldbook", label: "Worldbook" },
    { id: "lore:memory", label: "Memory" },
    { id: "config:agents", label: "Agents" },
    { id: "config:prompts", label: "Prompts" },
    { id: "debug:", label: "Debug" },
    { id: "settings:", label: "Settings" },
  ],
};
