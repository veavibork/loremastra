import { Hono } from 'hono'
import { getPromptCatalog } from '../services/prompt-catalog.js'

export const promptsRoute = new Hono()

promptsRoute.get('/', (c) => {
  return c.json({ prompts: getPromptCatalog() })
})
