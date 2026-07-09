import { copyFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDir, '..')

const primaryPolicy = resolve(root, 'packages/contracts/transcript-quality-policy.json')
const defaultPolicy = resolve(root, 'packages/contracts/default-policy.json')
const feDefaults = resolve(root, 'FE-Audiomind/src/config/transcriptQualityDefaults.json')
const feFallback = resolve(root, 'FE-Audiomind/src/config/fallback-policy.ts')
const processingPrimary = resolve(
  root,
  'demoRecordAUDIOMID/processing-service/src/main/resources/transcript-quality-policy.json',
)
const processingDefault = resolve(root, 'demoRecordAUDIOMID/processing-service/src/main/resources/default-policy.json')

for (const policyPath of [primaryPolicy, defaultPolicy]) {
  if (!existsSync(policyPath)) {
    console.error(`Missing ${policyPath}`)
    process.exit(1)
  }
}

await mkdir(dirname(feDefaults), { recursive: true })
await mkdir(dirname(processingPrimary), { recursive: true })

await copyFile(primaryPolicy, processingPrimary)
await copyFile(defaultPolicy, processingDefault)
await copyFile(defaultPolicy, feDefaults)

const fallbackResult = spawnSync(
  process.execPath,
  [resolve(root, 'scripts/generate-fallback-policy.mjs'), defaultPolicy, feFallback],
  { stdio: 'inherit' },
)

if (fallbackResult.status !== 0) {
  process.exit(fallbackResult.status ?? 1)
}

console.log('Synced transcript quality policy:')
console.log('  primary -> processing-service/transcript-quality-policy.json')
console.log('  default -> processing-service/default-policy.json + FE bundle + fallback-policy.ts')
