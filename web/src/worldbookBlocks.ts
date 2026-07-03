// Backend: src/services/worldbook-extraction.ts
// Frontend: web/src/worldbookBlocks.ts
// These two files must stay in sync -- this project has no shared-module path between
// the Node backend and the Vite frontend (web/tsconfig.app.json only includes web/src,
// no path aliases, no workspace tooling). If you change the bracket regex in one, change
// it in the other.

export type WorldbookEntryType = "content" | "roster" | "memory";

export interface ExtractedBlock {
  entryType: WorldbookEntryType;
  content: string;
}

export const WORLDBOOK_BLOCK_PATTERN = /\[(CONTENT|ROSTER|MEMORY)\]([\s\S]*?)\[\/\1\]/g;

export function extractWorldbookBlocks(text: string): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = [];
  for (const match of text.matchAll(WORLDBOOK_BLOCK_PATTERN)) {
    const entryType = match[1].toLowerCase() as WorldbookEntryType;
    const content = match[2].trim();
    if (content) blocks.push({ entryType, content });
  }
  return blocks;
}
