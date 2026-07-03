import {
  EDITOR_SETUP_OPENING,
  EDITOR_SETUP_PROMPT,
  EDITOR_SETUP_WORLDBOOK,
  AUTHOR_KICKOFF_PROMPT,
  AUTHOR_SYSTEM_PROMPT,
  COMPRESS_SYSTEM_PROMPT,
  ARCHIVE_SYSTEM_PROMPT,
  EDITOR_UPDATE_OPENING,
  EDITOR_UPDATE_PROMPT,
} from "../prompts.js";
import { SUMMARY_TOOL, ARCHIVE_TOOL } from "../queue/pipeline-runner.js";
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
      sourceFile: "src/prompts.ts",
      content: AUTHOR_SYSTEM_PROMPT,
    },
    {
      id: "author-kickoff-prompt",
      name: "Author — kickoff prompt",
      usedBy: "Author (kickoff)",
      kind: "instruction",
      sourceFile: "src/prompts.ts",
      content: AUTHOR_KICKOFF_PROMPT,
    },
    {
      id: "editor-setup-opening",
      name: "Editor — new story opening line",
      usedBy: "Editor (setup, canned)",
      kind: "instruction",
      sourceFile: "src/prompts.ts",
      content: EDITOR_SETUP_OPENING,
    },
    {
      id: "editor-setup-prompt",
      name: "Editor — setup conversation prompt",
      usedBy: "Editor (setup conversation)",
      kind: "system-prompt",
      sourceFile: "src/prompts.ts",
      content: EDITOR_SETUP_PROMPT,
    },
    {
      id: "editor-setup-worldbook",
      name: "Editor — setup worldbook-authoring prompt",
      usedBy: "Editor (setup worldbook pass)",
      kind: "system-prompt",
      sourceFile: "src/prompts.ts",
      content: EDITOR_SETUP_WORLDBOOK,
    },
    {
      id: "editor-update-opening",
      name: "Editor — new OOC session opening line",
      usedBy: "Editor (update session, canned)",
      kind: "instruction",
      sourceFile: "src/prompts.ts",
      content: EDITOR_UPDATE_OPENING,
    },
    {
      id: "editor-update-prompt",
      name: "Editor — update session prompt",
      usedBy: "Editor (update session)",
      kind: "system-prompt",
      sourceFile: "src/prompts.ts",
      content: EDITOR_UPDATE_PROMPT,
    },
    {
      id: "compress-system-prompt",
      name: "Worker — compress prompt",
      usedBy: "Worker (compress)",
      kind: "system-prompt",
      sourceFile: "src/prompts.ts",
      content: COMPRESS_SYSTEM_PROMPT,
    },
    toolEntry("summary-tool", SUMMARY_TOOL, "submit_summary tool schema", "Worker (compress)", "src/queue/pipeline-runner.ts"),
    {
      id: "archive-system-prompt",
      name: "Editor — archive summary prompt",
      usedBy: "Editor (archive)",
      kind: "system-prompt",
      sourceFile: "src/prompts.ts",
      content: ARCHIVE_SYSTEM_PROMPT,
    },
    toolEntry("archive-tool", ARCHIVE_TOOL, "submit_archive_summary tool schema", "Editor (archive)", "src/queue/pipeline-runner.ts"),
  ];
}
