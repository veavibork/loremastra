#!/usr/bin/env npx tsx
import { getGlobalDb } from '../src/db/global-db.js'
import { getStoryDb } from '../src/db/story-db.js'
import { getStory } from '../src/db/story-store.js'
import { getBookByType } from '../src/db/book-store.js'
import { buildChainPostIndex } from '../src/services/post-index.js'
import { buildStoryCorpus } from '../src/services/story-to-date-corpus.js'
import { getAgentProfile } from '../src/services/agent-config.js'
import { STORY_TO_DATE_INPUT_CUTOFF } from '../src/services/story-to-date.js'

const storyId = process.argv[2] ?? '019f25e0-219c-7189-b481-9f389a9a3c39'
const n = Number(process.argv[3] ?? 147)

const story = getStory(getGlobalDb(), storyId)!
const db = getStoryDb(storyId)
const logbook = getBookByType(db, 'logbook')!
const editor = getAgentProfile(story.ownerUserId, 'editor')
const corpus = buildStoryCorpus(db, storyId, logbook.id, {
  contextLimit: editor.contextLimit,
  responseLimit: editor.responseLimit,
  inputCutoff: STORY_TO_DATE_INPUT_CUTOFF,
})
const entry = buildChainPostIndex(db, logbook.id).find((e) => e.postNumber === n)

console.log({
  inputCeilingPost: corpus.inputCeilingPost,
  included: corpus.includedPosts.length,
  posts: corpus.posts.length,
})
console.log(
  `post ${n} in included:`,
  corpus.includedPosts.some((p) => p.icPostNumber === n),
)
console.log(`post ${n} chain:`, entry ? { hidden: entry.hidden } : null)
console.log(
  'included nearby:',
  corpus.includedPosts
    .filter((p) => p.icPostNumber >= n - 3 && p.icPostNumber <= n + 3)
    .map((p) => p.icPostNumber),
)
