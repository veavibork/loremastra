import type { ComponentType } from "react";
import TagsView from "./TagsView";
import WorldbookView from "./WorldbookView";
import StoryPanel from "./StoryPanel";
import SavesView from "./SavesView";
import LogsView from "./LogsView";
import SummaryView from "./SummaryView";
import DebugView from "./DebugView";
import AgentsView from "./AgentsView";
import MemoryView from "./MemoryView";
import PromptsView from "./PromptsView";
import SettingsView from "./SettingsView";
import type { PanelProps } from "./panel-types";

/**
 * Which component renders for a given tab id is data (the layout config says which tabs exist
 * and in what order), but the actual React component behind each id is still a compile-time
 * registry — Phase 1 doesn't need a plugin system, just a lookup table mapping ids to the
 * components that already exist.
 */
const REGISTRY: Record<string, ComponentType<PanelProps>> = {
  "story:play": StoryPanel,
  "story:saves": SavesView,
  "story:logs": LogsView,
  "story:summary": SummaryView,
  "lore:tags": TagsView,
  "lore:worldbook": WorldbookView,
  "lore:memory": MemoryView,
  "config:agents": AgentsView,
  "config:prompts": PromptsView,
  "debug:": DebugView,
  "settings:": SettingsView,
};

export function resolvePanel(id: string): ComponentType<PanelProps> | null {
  return REGISTRY[id] ?? null;
}
