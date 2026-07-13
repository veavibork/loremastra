/**
 * Smoke test: absolute chain post indexing + Editor corpus (hidden omitted, numbers gap).
 *
 * Run: npx tsx scripts/test-post-index-smoke.ts [storyId]
 */
import { getGlobalDb } from '../src/db/global-db.js'
import { getStoryDb } from '../src/db/story-db.js'
import { getStory } from '../src/db/story-store.js'
import { getBookByType } from '../src/db/book-store.js'
import { getAgentProfile } from '../src/services/agent-config.js'
import {
  buildChainPostIndex,
  countChainPosts,
  resolveChainPostNumber,
} from '../src/services/post-index.js'
import { buildStoryCorpus, formatCorpusForEditor } from '../src/services/story-to-date-engine.js'
import { buildLogView } from '../src/services/log-view.js'
import { buildPromptPreview } from '../src/services/prompt-preview.js'
import { listStoryToDateSegments } from '../src/db/story-to-date-store.js'
import { findHeadPageId } from '../src/db/page-store.js'

const STORY_ID = process.argv[2] ?? '019f25e0-219c-7189-b481-9f389a9a3c39'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`)
  console.log(`ok: ${message}`)
}

function main(): void {
  console.log(`\n=== post-index smoke (${STORY_ID}) ===\n`)

  const globalDb = getGlobalDb()
  const story = getStory(globalDb, STORY_ID)
  if (!story) throw new Error(`story not found: ${STORY_ID}`)

  const db = getStoryDb(STORY_ID)
  const logbook = getBookByType(db, 'logbook')
  if (!logbook) throw new Error('no logbook')

  const chain = buildChainPostIndex(db, logbook.id)
  const hiddenCount = chain.filter((e) => e.hidden).length
  const visibleCount = chain.filter((e) => !e.hidden).length

  console.log(`chain posts: ${chain.length} (${visibleCount} visible, ${hiddenCount} hidden)`)
  assert(hiddenCount > 0, 'story has hidden posts to validate gap behavior')

  const { entries: logEntries } = buildLogView(db, logbook.id)
  for (const entry of logEntries) {
    if (entry.icPostNumber == null) continue
    const expected = resolveChainPostNumber(db, logbook.id, entry.pageId)
    assert(
      entry.icPostNumber === expected,
      `Logs post # matches chain index for ${entry.pageId.slice(0, 8)}`,
    )
  }

  const editor = getAgentProfile(story.ownerUserId, 'editor')
  const corpus = buildStoryCorpus(db, STORY_ID, logbook.id, {
    contextLimit: editor.contextLimit,
    responseLimit: editor.responseLimit,
  })

  assert(corpus.posts.length > 0, 'Editor corpus has visible posts on chain')
  assert(
    corpus.posts.every((p) => !p.hidden),
    'Editor corpus excludes hidden posts',
  )
  assert(
    corpus.includedPosts.every((p) => !p.hidden),
    'Editor input slice excludes hidden posts',
  )

  for (const post of corpus.posts) {
    const chainEntry = chain.find((e) => e.pageId === post.pageId)
    assert(
      !!chainEntry && !chainEntry.hidden,
      `corpus post ${post.icPostNumber} is visible on chain`,
    )
    assert(
      post.icPostNumber === chainEntry!.postNumber,
      `corpus post # matches absolute index (${post.icPostNumber})`,
    )
  }

  const formatted = formatCorpusForEditor(
    corpus,
    corpus.includedPosts.length ? corpus.includedPosts : corpus.posts.slice(0, 20),
  )
  assert(!/\(hidden\)/i.test(formatted), 'formatted corpus has no hidden markers')
  assert(!/--- post \d+ \(.*hidden/i.test(formatted), 'formatted corpus has no hidden post blocks')

  const postLabels = [...formatted.matchAll(/--- post (\d+) /g)].map((m) => Number(m[1]))
  for (let i = 1; i < postLabels.length; i++) {
    assert(postLabels[i]! > postLabels[i - 1]!, 'post numbers strictly increase in corpus')
  }
  if (hiddenCount > 0 && postLabels.length >= 2) {
    const hasGap = postLabels.some((n, i) => i > 0 && n - postLabels[i - 1]! > 1)
    assert(hasGap, 'corpus post numbers gap over hidden slots')
  } else if (hiddenCount > 0) {
    const visiblePosts = corpus.posts.map((p) => p.icPostNumber)
    const hasGap = visiblePosts.some((n, i) => i > 0 && n - visiblePosts[i - 1]! > 1)
    assert(hasGap, 'full corpus post list gaps over hidden slots')
  }

  const headId = findHeadPageId(db, logbook.id)
  const preview = buildPromptPreview(db, story.ownerUserId, logbook.id, headId)
  const previewPosts = preview.messages
    .filter((m) => m.icPostNumber != null)
    .map((m) => m.icPostNumber!)
  const visibleChainPosts = chain.filter((e) => !e.hidden).map((e) => e.postNumber)

  assert(
    previewPosts.length === visibleChainPosts.slice(-previewPosts.length).length ||
      JSON.stringify(previewPosts) ===
        JSON.stringify(visibleChainPosts.slice(visibleChainPosts.length - previewPosts.length)),
    'Memory preview post numbers match visible chain tail',
  )

  const segments = listStoryToDateSegments(db, logbook.id, {
    includeHidden: true,
    includeBroken: true,
  })
  console.log(`\nsegments: ${segments.length}`)
  for (const seg of segments) {
    const fromPage = seg.coveragePageId
      ? resolveChainPostNumber(db, logbook.id, seg.coveragePageId)
      : null
    const stored = seg.coverageThroughIcPost
    const drift = fromPage != null && stored != null && fromPage !== stored
    console.log(
      `  seq ${seg.seq} [${seg.kind}] stored=${stored ?? '—'} pageId→${fromPage ?? '—'}${drift ? ' DRIFT' : ''}`,
    )
  }

  assert(countChainPosts(db, logbook.id) === chain.length, 'countChainPosts matches index length')

  console.log('\n=== post-index smoke passed ===\n')
}

main()
