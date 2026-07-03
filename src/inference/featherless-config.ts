/**
 * Featherless-specific connection details, kept inside src/inference/ rather than the shared
 * config.ts — loremaster.md's Provider Abstraction section wants the provider module written as
 * its own component rather than inlined into agent logic. AgentProfile/DEFAULT_*_PROFILE in
 * config.ts are provider-agnostic (model id, temperature, token limits); nothing about how to
 * reach a specific provider's API belongs alongside them.
 */
try {
  // Idempotent with config.ts's own call — this module must not depend on import order to see .env.
  process.loadEnvFile();
} catch {
  // no .env present; rely on process.env as-is
}

export const FEATHERLESS_BASE_URL = "https://api.featherless.ai/v1";
// Node's default fetch User-Agent gets silently blocked by Featherless's Cloudflare WAF (returns a fake 404 "Gone" instead of a 403) — every request needs a real one.
export const FEATHERLESS_USER_AGENT = "loremaster/0.1 (+https://github.com/local-dev)";
