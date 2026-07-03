/**
 * Horde-specific connection details, kept isolated from config.ts the same way
 * featherless-config.ts is — see that file's header comment for why.
 */
try {
  // Idempotent with config.ts's/featherless-config.ts's own calls.
  process.loadEnvFile();
} catch {
  // no .env present; rely on process.env as-is
}

// Anonymous key is a valid, documented default for AI Horde (shared, kudos-deprioritized, but
// functional) — unlike Featherless, there's no "unset" sentinel to gate calls on here.
export const HORDE_API_KEY = process.env.HORDE_API_KEY ?? "0000000000";
export const HORDE_BASE_URL = "https://aihorde.net/api";
export const HORDE_USER_AGENT = "loremaster/0.1 (+https://github.com/local-dev)";
