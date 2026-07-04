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
        { id: "mode.ooc", label: "OOC" },
        { id: "mode.ic", label: "IC" },
        { id: "action.undo", label: "↶ Undo" },
        { id: "action.redo", label: "↷ Redo" },
      ],
    },
    {
      id: "input-toggles",
      visible: true,
      showButton: false,
      showLabel: false,
      justify: "center",
      buttons: [
        { id: "toggle.length", label: "Length" },
        { id: "toggle.mood", label: "Mood" },
        { id: "toggle.param", label: "Param" },
        { id: "toggle.model", label: "Model" },
        { id: "toggle.effort", label: "Effort" },
      ],
    },
    {
      id: "input-actions",
      visible: true,
      showButton: false,
      showLabel: false,
      justify: "right",
      buttons: [
        { id: "action.retry", label: "Retry" },
        { id: "action.continue", label: "Continue" },
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
      if (seen.has(btn.id)) continue;
      seen.add(btn.id);
      out.push({ id: btn.id, label: btn.label ?? btn.id });
    }
  }
  return out;
}
