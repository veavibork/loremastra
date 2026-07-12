/** Detect bracket-tagged prompt blocks for Memory tab styling. */
export type PromptBlockKind =
  | 'author-system'
  | 'content'
  | 'roster'
  | 'memory'
  | 'story-to-date'
  | 'event-summary'
  | 'user'
  | 'assistant'
  | 'system'

export function classifyPromptBlock(content: string, role: string): PromptBlockKind {
  const head = content.trimStart()
  if (head.startsWith('[STORY TO DATE]')) return 'story-to-date'
  if (head.startsWith('[EVENT SUMMARY')) return 'event-summary'
  if (head.startsWith('[CONTENT]')) return 'content'
  if (head.startsWith('[ROSTER]')) return 'roster'
  if (head.startsWith('[MEMORY]')) return 'memory'
  if (role === 'user') return 'user'
  if (role === 'assistant') return 'assistant'
  return 'system'
}

export function promptBlockLabel(kind: PromptBlockKind): string {
  switch (kind) {
    case 'content':
      return 'content'
    case 'roster':
      return 'roster'
    case 'memory':
      return 'memory'
    case 'story-to-date':
      return 'story to date'
    case 'event-summary':
      return 'event summary'
    case 'author-system':
      return 'author system'
    default:
      return kind
  }
}
