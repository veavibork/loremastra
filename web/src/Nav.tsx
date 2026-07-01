import { useState } from "react";
import type { LayoutConfigData } from "./api";
import { resolvePanel } from "./registry";
import type { PanelProps } from "./panel-types";
import "./Nav.css";

export default function Nav({ config, panelProps }: { config: LayoutConfigData; panelProps: PanelProps }) {
  const [activeSectionId, setActiveSectionId] = useState(config.sections[0]?.id ?? "");
  const activeSection = config.sections.find((s) => s.id === activeSectionId) ?? config.sections[0];
  const [activeTabId, setActiveTabId] = useState(activeSection?.tabs[0]?.id ?? "");

  function selectSection(sectionId: string) {
    setActiveSectionId(sectionId);
    const section = config.sections.find((s) => s.id === sectionId);
    setActiveTabId(section?.tabs[0]?.id ?? "");
  }

  const tabId = activeSection?.tabs.length ? activeTabId : "";
  const Panel = activeSection ? resolvePanel(activeSection.id, tabId) : null;

  return (
    <div className="nav-shell">
      <nav className="nav-sections">
        {config.sections.map((section) => (
          <button
            key={section.id}
            type="button"
            className={section.id === activeSectionId ? "active" : ""}
            onClick={() => selectSection(section.id)}
          >
            {section.label}
          </button>
        ))}
      </nav>

      {activeSection && activeSection.tabs.length > 0 && (
        <nav className="nav-tabs">
          {activeSection.tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={tab.id === activeTabId ? "active" : ""}
              onClick={() => setActiveTabId(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      )}

      <div className="nav-panel">{Panel ? <Panel {...panelProps} /> : <p>Nothing configured here yet.</p>}</div>
    </div>
  );
}
