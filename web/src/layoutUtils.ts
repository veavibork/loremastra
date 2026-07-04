import type { LayoutConfigData, LayoutRegion } from "./api";

/** Default input bar when layout hasn't loaded yet — mirrors server DEFAULT_LAYOUT_CONFIG.inputBar. */
export const DEFAULT_INPUT_BAR: LayoutRegion = {
  containers: [
    {
      id: "input-nav",
      visible: true,
      showButton: false,
      showLabel: false,
      justify: "left",
      buttons: [
        { id: "mode.ooc", label: "OOC", visible: true },
        { id: "mode.ic", label: "IC", visible: true },
        { id: "action.undo", label: "↶ Undo", visible: true },
        { id: "action.redo", label: "↷ Redo", visible: true },
      ],
    },
    {
      id: "input-toggles",
      visible: true,
      showButton: false,
      showLabel: false,
      justify: "center",
      buttons: [
        { id: "toggle.length", label: "Length", visible: true },
        { id: "toggle.mood", label: "Mood", visible: true },
        { id: "toggle.param", label: "Param", visible: true },
        { id: "toggle.model", label: "Model", visible: true },
        { id: "toggle.effort", label: "Effort", visible: true },
        { id: "toggle.reasoning.show", label: "Trace", visible: true },
        { id: "toggle.reasoning.expand", label: "Trace open", visible: true },
      ],
    },
    {
      id: "input-actions",
      visible: true,
      showButton: false,
      showLabel: false,
      justify: "right",
      buttons: [
        { id: "action.retry", label: "Retry", visible: true },
        { id: "action.continue", label: "Continue", visible: true },
      ],
    },
  ],
};

export function flattenNavTabs(config: LayoutConfigData): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = [];
  const seen = new Set<string>();
  for (const container of config.nav.containers) {
    if (!container.visible) continue;
    for (const btn of container.buttons) {
      if (!btn.visible) continue;
      if (seen.has(btn.id)) continue;
      seen.add(btn.id);
      out.push({ id: btn.id, label: btn.label ?? btn.id });
    }
  }
  return out;
}
