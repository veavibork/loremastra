import { getModel, listModels } from '../src/inference/featherless-models.js'
import { DEFAULT_AUTHOR_PROFILE, DEFAULT_WORKER_PROFILE } from '../src/config.js'

// Standalone dev script, not part of the app runtime — the app itself now reads each user's key
// from the DB, but this manual tool just wants a key to hit the API with.
const apiKey = process.env.FEATHERLESS_API_KEY
if (!apiKey) {
  console.error('set FEATHERLESS_API_KEY to run this script')
  process.exit(1)
}

async function main() {
  console.log('--- current author model ---')
  console.log(await getModel(apiKey!, DEFAULT_AUTHOR_PROFILE.model))

  console.log('--- current worker model ---')
  console.log(await getModel(apiKey!, DEFAULT_WORKER_PROFILE.model))

  console.log('--- models supporting tool-use, context >= 8000, on current plan ---')
  const candidates = await listModels(apiKey!, {
    requireToolUse: true,
    contextLengthMin: 8000,
    availableOnCurrentPlan: true,
    perPage: 200,
  })
  console.log(`found ${candidates.length}`)
  for (const m of candidates.slice(0, 30)) {
    console.log(
      `${m.id} | context=${m.contextLength} maxOut=${m.maxCompletionTokens ?? '?'} cost=${m.concurrencyCost ?? '?'} gated=${m.isGated}`,
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
