import { useEffect, useRef, useState } from "react";
import {
  fetchLayout,
  updateLayout,
  fetchSettingsSpace,
  saveSettingsSpace,
  revertSettingsSpace,
  type LayoutConfigData,
} from "./api";
import SettingsTreeEditor, { type JsonData, type SettingsSection } from "./SettingsTreeEditor";
import { applyGlobalCssSettings, GLOBAL_CSS_SPACE, type GlobalCssSettings } from "./globalCssSettings";
import { PLAY_TAB_SPACE, useSetPlayTabSettings, type PlayTabSettings } from "./playTabSettings";
import "./SettingsView.css";

const BANNED_PHRASES_SPACE = "banned-phrases";

export default function SettingsView() {
  const [layout, setLayout] = useState<LayoutConfigData | null>(null);
  const [bannedPhrases, setBannedPhrases] = useState<string[] | null>(null);
  const [globalCss, setGlobalCss] = useState<GlobalCssSettings | null>(null);
  const [playTab, setPlayTab] = useState<PlayTabSettings | null>(null);
  const setLivePlayTabSettings = useSetPlayTabSettings();

  useEffect(() => {
    void fetchLayout().then((res) => setLayout(res.config));
    void fetchSettingsSpace<string[]>(BANNED_PHRASES_SPACE).then(setBannedPhrases);
    void fetchSettingsSpace<GlobalCssSettings>(GLOBAL_CSS_SPACE).then(setGlobalCss);
    void fetchSettingsSpace<PlayTabSettings>(PLAY_TAB_SPACE).then(setPlayTab);
  }, []);

  // Live edits to Global CSS / Play tab apply immediately (see each section's onChange below);
  // if the user navigates away from Settings without saving, re-apply whatever was last
  // actually persisted so the preview doesn't linger.
  const persistedGlobalCss = useRef<GlobalCssSettings | null>(null);
  useEffect(() => {
    persistedGlobalCss.current = globalCss;
  }, [globalCss]);
  const persistedPlayTab = useRef<PlayTabSettings | null>(null);
  useEffect(() => {
    persistedPlayTab.current = playTab;
  }, [playTab]);
  useEffect(() => {
    return () => {
      if (persistedGlobalCss.current) applyGlobalCssSettings(persistedGlobalCss.current);
      if (persistedPlayTab.current) setLivePlayTabSettings(persistedPlayTab.current);
    };
  }, [setLivePlayTabSettings]);

  if (!bannedPhrases || !globalCss || !playTab || !layout) {
    return (
      <div className="settings-view">
        <h2>Settings</h2>
        <p className="settings-note">Loading…</p>
      </div>
    );
  }

  const sections: SettingsSection[] = [
    {
      key: BANNED_PHRASES_SPACE,
      title: "Banned words/phrases",
      description:
        "Matched (case-insensitively) against the start of Worker/Editor compress and archive replies only — " +
        "these summaries feed the worldbook and are never shown to you directly. A match is treated as the model " +
        "refusing the task and triggers a retry. Not applied to live Author prose or the Editor's visible setup " +
        "replies, and not sent as a generation-time stop list.",
      value: bannedPhrases as unknown as JsonData,
      onSave: async (value) => {
        const saved = await saveSettingsSpace(BANNED_PHRASES_SPACE, value);
        setBannedPhrases(saved as string[]);
        return saved as unknown as JsonData;
      },
      onRevert: async () => {
        const reverted = await revertSettingsSpace<string[]>(BANNED_PHRASES_SPACE);
        setBannedPhrases(reverted);
        return reverted as unknown as JsonData;
      },
    },
    {
      key: GLOBAL_CSS_SPACE,
      title: "Global CSS",
      description:
        "Light/dark color variables, root font size, and the narrow-screen breakpoint used across the whole app. " +
        "Edits apply immediately as a preview; navigating away without saving reverts them.",
      value: globalCss as unknown as JsonData,
      onChange: (value) => applyGlobalCssSettings(value as unknown as GlobalCssSettings),
      onSave: async (value) => {
        const saved = await saveSettingsSpace(GLOBAL_CSS_SPACE, value);
        setGlobalCss(saved as unknown as GlobalCssSettings);
        return saved as unknown as JsonData;
      },
      onRevert: async () => {
        const reverted = await revertSettingsSpace<GlobalCssSettings>(GLOBAL_CSS_SPACE);
        setGlobalCss(reverted);
        applyGlobalCssSettings(reverted);
        return reverted as unknown as JsonData;
      },
    },
    {
      key: PLAY_TAB_SPACE,
      title: "Story tab",
      description:
        "Controls how posts render in the Story tab's OOC and IC modes: post font size, whether the user/editor " +
        "role labels are shown at all, what text they use, and whether editor posts render in italics. Edits " +
        "apply immediately as a preview; navigating away without saving reverts them.",
      value: playTab as unknown as JsonData,
      onChange: (value) => setLivePlayTabSettings(value as unknown as PlayTabSettings),
      onSave: async (value) => {
        const saved = await saveSettingsSpace(PLAY_TAB_SPACE, value);
        setPlayTab(saved as unknown as PlayTabSettings);
        return saved as unknown as JsonData;
      },
      onRevert: async () => {
        const reverted = await revertSettingsSpace<PlayTabSettings>(PLAY_TAB_SPACE);
        setPlayTab(reverted);
        setLivePlayTabSettings(reverted);
        return reverted as unknown as JsonData;
      },
    },
    {
      key: "layout",
      title: "Layout",
      description:
        "A flat, ordered list of tabs — this order is exactly the tab bar's render order, top to bottom in " +
        "this list, left to right in the bar. No nested containers/grouping at this time. Config-driven but " +
        "read-only — no drag-and-drop editor yet, so reordering is a direct JSON edit, per loremaster.md's UI " +
        "Structure section. No one-step undo here (unlike the other three spaces).",
      value: layout as unknown as JsonData,
      onSave: async (value) => {
        const res = await updateLayout(value as unknown as LayoutConfigData);
        setLayout(res.config);
        return res.config as unknown as JsonData;
      },
    },
  ];

  return (
    <div className="settings-view">
      <h2>Settings</h2>
      <SettingsTreeEditor sections={sections} />
    </div>
  );
}
