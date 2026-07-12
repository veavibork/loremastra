import { rmSync } from 'node:fs'
import { killPort } from './lib/dev-utils.mjs'

killPort(process.env.PORT ?? '4114')
rmSync('data', { recursive: true, force: true })
console.log('Removed data/ directory')
