import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'

const DATA_DIR = path.resolve(process.cwd(), 'data')
const PID_FILE = path.join(DATA_DIR, 'mcp-dev-server.pid')
const STALE_LOG = path.join(DATA_DIR, 'mcp-dev-server-stale.log')

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Best-effort breadcrumb for the stale-instance log — a failed lookup (process already gone
 * between the liveness check and here, `Get-Process` unavailable, etc.) shouldn't block startup. */
function describeProcess(pid: number): string {
  try {
    return execSync(
      `powershell -NoProfile -Command "Get-Process -Id ${pid} -ErrorAction Stop | Select-Object Id, ProcessName, StartTime, Path | Format-List | Out-String"`,
      { encoding: 'utf8' },
    ).trim()
  } catch {
    return '(process details unavailable — it may have exited between the liveness check and this lookup)'
  }
}

/**
 * This process is always launched as `node .../src/mcp/dev-server.ts` (directly or via tsx) —
 * confirm the PID's command line still looks like that before killing it, in case the OS
 * reassigned the PID to an unrelated process between the previous instance exiting and now.
 * Uses CommandLine via Win32_Process (Get-Process doesn't expose it) rather than ProcessName,
 * since `node`/`tsx` alone is too generic to be an identity check.
 */
function isLoremasterDevServerProcess(pid: number): boolean {
  try {
    const commandLine = execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop).CommandLine"`,
      { encoding: 'utf8' },
    ).trim()
    return /mcp[\\/]dev-server\.(ts|m?js)/i.test(commandLine)
  } catch {
    return false
  }
}

/**
 * Only one loremaster-dev MCP server should ever be alive at once. A prior instance left running
 * (host respawn without killing the old one, editor reload, a crash that skipped cleanup, etc.)
 * holds every story DB it ever touched open indefinitely via getStoryDb()'s process-local cache,
 * which silently breaks story deletion elsewhere in the app (EBUSY on the .sqlite file — see
 * [[project_loremaster_mcp_dev_server_leak]]). This has come up more than once, so rather than
 * hunting it down manually each time: kill a still-alive previous instance at startup, log what
 * was found so repeat occurrences are traceable over time instead of one-off surprises, then claim
 * the PID file for this process and clean it up on a normal exit.
 */
export function ensureSingleInstance(): void {
  mkdirSync(DATA_DIR, { recursive: true })

  if (existsSync(PID_FILE)) {
    const prevPid = Number(readFileSync(PID_FILE, 'utf8').trim())
    if (Number.isFinite(prevPid) && prevPid !== process.pid && isAlive(prevPid)) {
      const info = describeProcess(prevPid)
      if (isLoremasterDevServerProcess(prevPid)) {
        const entry = `[${new Date().toISOString()}] Killing stale loremaster-dev MCP server PID ${prevPid} before starting PID ${process.pid}\n${info}\n\n`
        appendFileSync(STALE_LOG, entry)
        console.error(entry.trim())
        try {
          execSync(`taskkill /PID ${prevPid} /F`, { stdio: 'ignore' })
        } catch {
          // already gone
        }
      } else {
        // The PID file's owner no longer looks like a loremaster-dev MCP server — the OS likely
        // reassigned this PID to an unrelated process since the previous instance exited.
        // Don't kill it; just log and fall through to claim the PID file below.
        const entry = `[${new Date().toISOString()}] PID ${prevPid} from stale PID file is not a loremaster-dev MCP server — skipping kill, starting PID ${process.pid} anyway\n${info}\n\n`
        appendFileSync(STALE_LOG, entry)
        console.error(entry.trim())
      }
    }
  }

  writeFileSync(PID_FILE, String(process.pid))

  const cleanup = () => {
    try {
      if (readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) unlinkSync(PID_FILE)
    } catch {
      // already cleaned up, or never got this far
    }
  }
  process.on('exit', cleanup)
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
}
