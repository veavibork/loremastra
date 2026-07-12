import { execSync } from 'node:child_process'

export function killPort(port) {
  let output
  try {
    output = execSync('netstat -ano', { encoding: 'utf8' })
  } catch {
    return
  }

  const pids = new Set()
  for (const line of output.split('\n')) {
    if (line.includes(`:${port} `) && line.includes('LISTENING')) {
      const parts = line.trim().split(/\s+/)
      const pid = parts[parts.length - 1]
      if (pid && pid !== '0') pids.add(pid)
    }
  }

  for (const pid of pids) {
    try {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' })
      console.log(`Killed PID ${pid} on port ${port}`)
    } catch {
      // already gone
    }
  }
}
