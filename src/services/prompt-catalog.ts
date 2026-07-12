import {
  EDITOR_SETUP_OPENING,
  EDITOR_SETUP_PROMPT,
  EDITOR_SETUP_WORLDBOOK,
  AUTHOR_KICKOFF_PROMPT,
  AUTHOR_SYSTEM_PROMPT,
  COMPRESS_SYSTEM_PROMPT,
  ARCHIVE_SYSTEM_PROMPT,
  EDITOR_UPDATE_PROMPT,
  NAMING_PROMPT,
  ARCHIVE_NAMING_PROMPT,
  WORLDBOOK_COMPACT_SYSTEM_PROMPT,
  buildIcProseSteering,
} from '../prompts.js'
import { INCLUDE_EXCLUDE_GUIDANCE } from './story-to-date-corpus.js'

export interface PromptCatalogEntry {
  id: string
  name: string
  usedBy: string
  kind: 'system-prompt' | 'instruction'
  sourceFile: string
  content: string
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
      id: 'author-system-prompt',
      name: 'Author — core system prompt',
      usedBy: 'Author',
      kind: 'system-prompt',
      sourceFile: 'src/prompts.ts',
      content: AUTHOR_SYSTEM_PROMPT,
    },
    {
      id: 'author-kickoff-prompt',
      name: 'Author — kickoff prompt',
      usedBy: 'Author (kickoff)',
      kind: 'instruction',
      sourceFile: 'src/prompts.ts',
      content: AUTHOR_KICKOFF_PROMPT,
    },
    {
      id: 'author-ic-prose-steering',
      name: 'Author — IC prose steering (template)',
      usedBy: 'Author (every IC generation; Register injected at runtime)',
      kind: 'instruction',
      sourceFile: 'src/prompts.ts',
      content: buildIcProseSteering({
        register: 'Pornographic with a light touch. Tactile, teasing, direct.',
        tenseGuard: true,
      }),
    },
    {
      id: 'editor-worldbook-compact-prompt',
      name: 'Editor — worldbook entry compaction',
      usedBy: 'Editor (manual Crunch worldbook)',
      kind: 'system-prompt',
      sourceFile: 'src/prompts.ts',
      content: WORLDBOOK_COMPACT_SYSTEM_PROMPT,
    },
    {
      id: 'editor-setup-opening',
      name: 'Editor — new story opening line',
      usedBy: 'Editor (setup, canned)',
      kind: 'instruction',
      sourceFile: 'src/prompts.ts',
      content: EDITOR_SETUP_OPENING,
    },
    {
      id: 'editor-setup-prompt',
      name: 'Editor — setup conversation prompt',
      usedBy: 'Editor (setup conversation)',
      kind: 'system-prompt',
      sourceFile: 'src/prompts.ts',
      content: EDITOR_SETUP_PROMPT,
    },
    {
      id: 'editor-setup-worldbook',
      name: 'Editor — setup worldbook-authoring prompt',
      usedBy: 'Editor (setup worldbook pass)',
      kind: 'system-prompt',
      sourceFile: 'src/prompts.ts',
      content: EDITOR_SETUP_WORLDBOOK,
    },
    {
      id: 'editor-update-prompt',
      name: 'Editor — update session prompt',
      usedBy: 'Editor (update session)',
      kind: 'system-prompt',
      sourceFile: 'src/prompts.ts',
      content: EDITOR_UPDATE_PROMPT,
    },
    {
      id: 'story-to-date-include-exclude',
      name: 'Editor — story-to-date INCLUDE/EXCLUDE guidance',
      usedBy: 'Editor (story-to-date begins/continues)',
      kind: 'instruction',
      sourceFile: 'src/services/story-to-date-corpus.ts',
      content: INCLUDE_EXCLUDE_GUIDANCE,
    },
    {
      id: 'worker-naming-prompt',
      name: 'Worker — story/scene naming prompt',
      usedBy: 'Worker (story-name, archive-name)',
      kind: 'system-prompt',
      sourceFile: 'src/prompts.ts',
      content: NAMING_PROMPT,
    },
    {
      id: 'worker-archive-naming-prompt',
      name: 'Worker — archive block naming prompt',
      usedBy: 'Worker (archive-name from summary)',
      kind: 'system-prompt',
      sourceFile: 'src/prompts.ts',
      content: ARCHIVE_NAMING_PROMPT,
    },
    {
      id: 'compress-system-prompt',
      name: 'Worker — compress prompt',
      usedBy: 'Worker (compress, retired)',
      kind: 'system-prompt',
      sourceFile: 'src/prompts.ts',
      content: COMPRESS_SYSTEM_PROMPT,
    },
    {
      id: 'archive-system-prompt',
      name: 'Editor — archive summary prompt',
      usedBy: 'Editor (archive, retired)',
      kind: 'system-prompt',
      sourceFile: 'src/prompts.ts',
      content: ARCHIVE_SYSTEM_PROMPT,
    },
  ]
}
