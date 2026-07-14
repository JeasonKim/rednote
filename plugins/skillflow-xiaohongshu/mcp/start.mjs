import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ensureCodexBrowserRuntimeCompatibility } from './codex-browser-compat.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REQUIRED_DEPENDENCIES = [
  '@modelcontextprotocol/sdk',
  'zod'
]

function dependencyPath(packageName) {
  return join(ROOT, 'node_modules', ...packageName.split('/'))
}

function missingDependencies() {
  return REQUIRED_DEPENDENCIES.filter((packageName) => !existsSync(dependencyPath(packageName)))
}

function npmInstallCommand() {
  if (process.platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm', 'install', '--omit=dev', '--no-audit', '--no-fund'] }
  }
  return { command: 'npm', args: ['install', '--omit=dev', '--no-audit', '--no-fund'] }
}

function installRuntimeDependencies(missingPackages) {
  console.warn('[branded-skillflow] installing missing MCP dependencies: ' + missingPackages.join(', '))
  const install = npmInstallCommand()
  const result = spawnSync(install.command, install.args, {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: '0' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.stdout) process.stderr.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('npm install failed while preparing the Skill Flow MCP server (exit ' + result.status + ').')
}

ensureCodexBrowserRuntimeCompatibility()
const missingPackages = missingDependencies()
if (missingPackages.length > 0) installRuntimeDependencies(missingPackages)

process.chdir(ROOT)
await import(pathToFileURL(join(ROOT, 'mcp', 'server.mjs')).href)
