import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { fetchSettingsSpace } from "./api";

export const PLAY_TAB_SPACE = "play-tab";

export interface PlayTabSettings {
  fontSize: number;
  showUserLabel: boolean;
  showEditorLabel: boolean;
  userLabel: string;
  editorLabel: string;
  italicizeEditor: boolean;
}

export const DEFAULT_PLAY_TAB_SETTINGS: PlayTabSettings = {
  fontSize: 15,
  showUserLabel: true,
  showEditorLabel: true,
  userLabel: "user",
  editorLabel: "editor",
  italicizeEditor: true,
};

interface PlayTabContextValue {
  settings: PlayTabSettings;
  /** Also used for local live preview while editing in Settings — see SettingsView.tsx. */
  setSettings: (settings: PlayTabSettings) => void;
}

const PlayTabContext = createContext<PlayTabContextValue>({
  settings: DEFAULT_PLAY_TAB_SETTINGS,
  setSettings: () => {},
});

function applyPlayTabCssVars(settings: PlayTabSettings): void {
  const root = document.documentElement.style;
  root.setProperty("--entry-font-size", `${settings.fontSize}px`);
  root.setProperty("--entry-editor-style", settings.italicizeEditor ? "italic" : "normal");
}

/**
 * Wraps the post-claim app tree; fetches the persisted space on mount and shares it (plus a
 * setter for live preview) via context. Only ever mounted once a session is claimed (see
 * App.tsx), so the fetch is unconditional here — unlike useGlobalCssSettings, which is called
 * higher up and has to guard against the pre-claim gate itself.
 */
export function PlayTabProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<PlayTabSettings>(DEFAULT_PLAY_TAB_SETTINGS);

  useEffect(() => {
    void fetchSettingsSpace<PlayTabSettings>(PLAY_TAB_SPACE).then(setSettings).catch(() => {});
  }, []);

  useEffect(() => applyPlayTabCssVars(settings), [settings]);

  return <PlayTabContext.Provider value={{ settings, setSettings }}>{children}</PlayTabContext.Provider>;
}

export function usePlayTabSettings(): PlayTabSettings {
  return useContext(PlayTabContext).settings;
}

export function useSetPlayTabSettings(): (settings: PlayTabSettings) => void {
  return useContext(PlayTabContext).setSettings;
}

/**
 * Renders the role label for a log entry per the Play tab settings — resolves both whether to
 * show it at all and its display text. Centralizes what StoryView/KickoffView/SetupView used
 * to each do slightly differently (StoryView showed the raw "agent" role; the other two
 * hardcoded a rename to "editor") into one place driven by user settings.
 */
export function RoleLabel({ role }: { role: string }) {
  const settings = usePlayTabSettings();
  if (role === "user") {
    return settings.showUserLabel ? <span className="entry-role">{settings.userLabel}</span> : null;
  }
  if (role === "agent") {
    return settings.showEditorLabel ? <span className="entry-role">{settings.editorLabel}</span> : null;
  }
  return <span className="entry-role">{role}</span>;
}
