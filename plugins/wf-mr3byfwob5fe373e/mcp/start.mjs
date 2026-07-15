import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const RUNTIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REQUIRED_DEPENDENCIES = [
  { packageName: '@modelcontextprotocol/ext-apps', importSpecifier: '@modelcontextprotocol/ext-apps/server' },
  { packageName: '@modelcontextprotocol/sdk', importSpecifier: '@modelcontextprotocol/sdk/server/mcp.js' },
  { packageName: 'zod', importSpecifier: 'zod' }
]

const options = parseRuntimeOptions(process.argv.slice(2))
const pluginRoot = resolve(options.pluginRoot ?? RUNTIME_ROOT)
if (options.dashboardDir) process.env.SKILLFLOW_CREATOR_PLUGIN_DASHBOARD_DIR = resolve(options.dashboardDir)
process.env.SKILLFLOW_CREATOR_PLUGIN_ROOT = pluginRoot

function missingDependencies() {
  const require = createRequire(import.meta.url)
  return REQUIRED_DEPENDENCIES.filter((dependency) => {
    try {
      require.resolve(dependency.importSpecifier)
      return false
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND') {
        console.warn('[branded-skillflow] dependency resolution failed package=' + dependency.packageName, error)
      }
      return true
    }
  }).map((dependency) => dependency.packageName)
}

function npmInstallCommand() {
  if (process.platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm', 'install', '--omit=dev', '--no-audit', '--no-fund'] }
  }
  return { command: 'npm', args: ['install', '--omit=dev', '--no-audit', '--no-fund'] }
}

function installRuntimeDependencies(missingPackages) {
  if (pluginRoot !== RUNTIME_ROOT) {
    throw new Error(
      'Missing creator plugin development dependencies: ' + missingPackages.join(', ') +
      '. Run pnpm install in the Skill Flow repository before starting the development plugin.'
    )
  }
  console.warn('[branded-skillflow] installing missing MCP dependencies: ' + missingPackages.join(', '))
  const install = npmInstallCommand()
  const result = spawnSync(install.command, install.args, {
    cwd: pluginRoot,
    env: { ...process.env, FORCE_COLOR: '0' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.stdout) process.stderr.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('npm install failed while preparing the Skill Flow MCP server (exit ' + result.status + ').')
}

function parseRuntimeOptions(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if ((name !== '--plugin-root' && name !== '--dashboard-dir') || !value) {
      throw new Error('Invalid creator plugin runtime arguments. Supported: --plugin-root, --dashboard-dir.')
    }
    values[name === '--plugin-root' ? 'pluginRoot' : 'dashboardDir'] = value
  }
  return values
}

const missingPackages = missingDependencies()
if (missingPackages.length > 0) installRuntimeDependencies(missingPackages)

process.chdir(pluginRoot)
await import(pathToFileURL(join(RUNTIME_ROOT, 'mcp', 'server.mjs')).href)
