import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function resolveCreatorPluginRuntimePaths({ serverModuleUrl, environment }) {
  const runtimeRoot = resolve(dirname(fileURLToPath(serverModuleUrl)), '..')
  const pluginRoot = resolve(environment.SKILLFLOW_CREATOR_PLUGIN_ROOT?.trim() || runtimeRoot)
  const dashboardDir = resolve(
    environment.SKILLFLOW_CREATOR_PLUGIN_DASHBOARD_DIR?.trim() || join(pluginRoot, 'dashboard')
  )
  return {
    runtimeRoot,
    pluginRoot,
    dashboardDir,
    dashboardIndexPath: join(dashboardDir, 'index.html')
  }
}
