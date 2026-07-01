/**
 * loremaster.md's UI Structure section: every component's size/position/grouping lives in a
 * per-user data structure rather than hardcoded markup. Phase 1 is read-only (no drag-and-drop
 * editor) — this is the config shape that drives the nav; editing it happens as a direct JSON
 * edit (Settings > Layout), which is what "configuration-file-level task, not a user-facing
 * drag-and-drop interface" means for Phase 1. Deliberately flat (sections + one level of tabs)
 * rather than a fully generic recursive component tree — that generality isn't needed for what
 * Phase 1 actually renders, and speculative flexibility here would be guessing at a shape v4_uuids
 * levels of nesting never actually gets used at this stage.
 */
export interface LayoutTab {
  id: string;
  label: string;
}

export interface LayoutSection {
  id: string;
  label: string;
  tabs: LayoutTab[];
}

export interface LayoutConfigData {
  sections: LayoutSection[];
}

export const DEFAULT_LAYOUT_CONFIG: LayoutConfigData = {
  sections: [
    {
      id: "story",
      label: "Story",
      tabs: [
        { id: "play", label: "Play" },
        { id: "saves", label: "Saves" },
        { id: "logs", label: "Logs" },
      ],
    },
    {
      id: "lore",
      label: "Lore",
      tabs: [
        { id: "worldbook", label: "Worldbook" },
        { id: "memory", label: "Memory" },
      ],
    },
    {
      id: "config",
      label: "Config",
      tabs: [
        { id: "agents", label: "Agents" },
        { id: "preview", label: "Preview" },
        { id: "prompts", label: "Prompts" },
      ],
    },
    { id: "debug", label: "Debug", tabs: [] },
    { id: "settings", label: "Settings", tabs: [] },
  ],
};
