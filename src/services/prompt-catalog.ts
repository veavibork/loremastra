import { AUTHOR_SYSTEM_PROMPT, KICKOFF_INSTRUCTION } from "./history.js";
import { EDITOR_SETUP_SYSTEM_PROMPT, EXTRACTION_SYSTEM_PROMPT, RECORD_ENTRY_TOOL } from "./setup.js";
import { COMPRESS_SYSTEM_PROMPT, ARCHIVE_SYSTEM_PROMPT, SUMMARY_TOOL, ARCHIVE_TOOL } from "../queue/pipeline-runner.js";
import type { ToolDefinition } from "../inference/featherless.js";

export interface PromptCatalogEntry {
  id: string;
  name: string;
  usedBy: string;
  kind: "system-prompt" | "tool" | "instruction";
  sourceFile: string;
  content: string;
}

function toolEntry(id: string, tool: ToolDefinition, name: string, usedBy: string, sourceFile: string): PromptCatalogEntry {
  return {
    id,
    name,
    usedBy,
    kind: "tool",
    sourceFile,
    content: `${tool.description}\n\nParameters schema:\n${JSON.stringify(tool.parameters, null, 2)}`,
  };
}

/**
 * The complete set of static prompt/tool-schema blocks the app's agents actually run on right
 * now — as distinct from Preview/Memory, which show a live *assembled* prompt for a specific
 * story (worldbook entries, log history, etc. mixed in). This is the source template library;
 * that's an instance rendered from it. Rebuilt fresh on each call rather than cached — these
 * are plain module-level constants, not story data, so there's no meaningful cost either way.
 */
export function getPromptCatalog(): PromptCatalogEntry[] {
  return [
    {
      id: "author-system-prompt",
      name: "Author — core system prompt",
      usedBy: "Author",
      kind: "system-prompt",
      sourceFile: "src/services/history.ts",
      content: AUTHOR_SYSTEM_PROMPT,
    },
    {
      id: "kickoff-instruction",
      name: "Author — kickoff instruction",
      usedBy: "Author (kickoff)",
      kind: "instruction",
      sourceFile: "src/services/history.ts",
      content: KICKOFF_INSTRUCTION,
    },
    {
      id: "editor-setup-prompt",
      name: "Editor — setup conversation prompt",
      usedBy: "Editor (conversation)",
      kind: "system-prompt",
      sourceFile: "src/services/setup.ts",
      content: EDITOR_SETUP_SYSTEM_PROMPT,
    },
    {
      id: "extraction-system-prompt",
      name: "Worker — worldbook extraction prompt",
      usedBy: "Worker (extraction)",
      kind: "system-prompt",
      sourceFile: "src/services/setup.ts",
      content: EXTRACTION_SYSTEM_PROMPT,
    },
    toolEntry("record-entry-tool", RECORD_ENTRY_TOOL, "record_worldbook_entry tool schema", "Worker (extraction)", "src/services/setup.ts"),
    {
      id: "compress-system-prompt",
      name: "Worker — compress prompt",
      usedBy: "Worker (compress)",
      kind: "system-prompt",
      sourceFile: "src/queue/pipeline-runner.ts",
      content: COMPRESS_SYSTEM_PROMPT,
    },
    toolEntry("summary-tool", SUMMARY_TOOL, "submit_summary tool schema", "Worker (compress)", "src/queue/pipeline-runner.ts"),
    {
      id: "archive-system-prompt",
      name: "Editor — archive summary prompt",
      usedBy: "Editor (archive)",
      kind: "system-prompt",
      sourceFile: "src/queue/pipeline-runner.ts",
      content: ARCHIVE_SYSTEM_PROMPT,
    },
    toolEntry("archive-tool", ARCHIVE_TOOL, "submit_archive_summary tool schema", "Editor (archive)", "src/queue/pipeline-runner.ts"),
  ];
}
