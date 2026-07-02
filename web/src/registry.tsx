import type { ComponentType } from "react";
import TagsView from "./TagsView";
import WorldbookView from "./WorldbookView";
import StoryPlayPanel from "./StoryPlayPanel";
import SavesView from "./SavesView";
import LogsView from "./LogsView";
import DebugView from "./DebugView";
import AgentsView from "./AgentsView";
import PromptInspectorView from "./PromptInspectorView";
import MemoryView from "./MemoryView";
import PromptsView from "./PromptsView";
import SettingsView from "./SettingsView";
import type { PanelProps } from "./panel-types";

/**
 * Which component renders for a given (section, tab) pair is data (the layout
 * config says which sections/tabs exist), but the actual React component behind
 * each id is still a compile-time registry — Phase 1 doesn't need a plugin
 * system, just a lookup table mapping ids to the components that already exist.
 */
const REGISTRY: Record<string, ComponentType<PanelProps>> = {
  "story:play": StoryPlayPanel,
  "story:saves": SavesView,
  "story:logs": LogsView,
  "lore:tags": TagsView,
  "lore:worldbook": WorldbookView,
  "lore:memory": MemoryView,
  "config:agents": AgentsView,
  "config:preview": PromptInspectorView,
  "config:prompts": PromptsView,
  "debug:": DebugView,
  "settings:": SettingsView,
};

export function resolvePanel(sectionId: string, tabId: string): ComponentType<PanelProps> | null {
  return REGISTRY[`${sectionId}:${tabId}`] ?? null;
}
