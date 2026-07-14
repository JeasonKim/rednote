import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const KNOWN_CONFLICT_SOURCE = [
  '  globalThis.process = processShim;',
  '  globalThis.global = globalThis.global ?? globalThis;',
  '  globalThis.global.process = processShim;'
].join('\n')
const COMPATIBILITY_MARKER = 'Skill Flow compatibility: keep Browser process shims module-local.'
const COMPATIBLE_SOURCE = [
  '  // ' + COMPATIBILITY_MARKER,
  '  const process = processShim;',
  '  const global = Object.create(globalThis);',
  "  Object.defineProperty(global, 'process', {",
  '    configurable: true,',
  '    enumerable: true,',
  '    value: processShim,',
  '    writable: true',
  '  });',
  '  global.global = global;'
].join('\n')

export function ensureCodexBrowserRuntimeCompatibility(options = {}) {
  const codexHome = options.codexHome || process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  const warn = options.warn || console.warn
  const result = { patched: 0, compatible: 0, skipped: 0 }
  const browserCacheRoot = join(codexHome, 'plugins', 'cache', 'openai-bundled', 'browser')
  if (!existsSync(browserCacheRoot)) return result

  let browserVersions
  try {
    browserVersions = readdirSync(browserCacheRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    result.skipped += 1
    warn('[branded-skillflow] failed to inspect Codex Browser cache root=' + browserCacheRoot, error)
    return result
  }

  for (const browserVersion of browserVersions) {
    const browserClientPath = join(browserCacheRoot, browserVersion, 'scripts', 'browser-client.mjs')
    if (!existsSync(browserClientPath)) continue
    repairBrowserClient(browserClientPath, result, warn)
  }
  return result
}

function repairBrowserClient(browserClientPath, result, warn) {
  let source
  try {
    source = readFileSync(browserClientPath, 'utf8')
  } catch (error) {
    result.skipped += 1
    warn('[branded-skillflow] failed to read Codex Browser client path=' + browserClientPath, error)
    return
  }

  if (source.includes(COMPATIBILITY_MARKER)) {
    result.compatible += 1
    return
  }

  const knownConflictCount = source.split(KNOWN_CONFLICT_SOURCE).length - 1
  if (knownConflictCount === 1) {
    try {
      writeFileSync(browserClientPath, source.replace(KNOWN_CONFLICT_SOURCE, COMPATIBLE_SOURCE), 'utf8')
      result.patched += 1
      warn('[branded-skillflow] patched Codex Browser runtime compatibility path=' + browserClientPath)
    } catch (error) {
      result.skipped += 1
      warn('[branded-skillflow] failed to patch Codex Browser runtime compatibility path=' + browserClientPath, error)
    }
    return
  }

  const stillMutatesLockedProcess = source.includes('globalThis.process =')
    || source.includes('globalThis.global.process =')
  if (stillMutatesLockedProcess) {
    result.skipped += 1
    warn('[branded-skillflow] unsupported Browser client shape; kept source unchanged path=' + browserClientPath)
    return
  }

  result.compatible += 1
}
