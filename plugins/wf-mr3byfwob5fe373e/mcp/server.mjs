import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'assets', 'config.json'), 'utf8'))
const WORKFLOW = JSON.parse(readFileSync(join(ROOT, 'assets', 'workflow.json'), 'utf8'))
const PROFILE_SNAPSHOT = JSON.parse(readFileSync(join(ROOT, 'assets', 'creator.json'), 'utf8'))
const DATA_ROOT = process.env.SKILLFLOW_PLUGIN_DATA_ROOT?.trim() || join(homedir(), '.skillflow', 'codex', CONFIG.technicalName)
const TASK_DIR = join(DATA_ROOT, 'tasks')
const CREDENTIALS_PATH = join(DATA_ROOT, 'credentials.json')
const RUNTIME_PATH = join(DATA_ROOT, 'runtime.json')
const DASHBOARD_INDEX_PATH = join(ROOT, 'dashboard', 'index.html')
const LOGO_PATH = join(ROOT, 'assets', 'logo' + extname(CONFIG.logoPath))
const WIDGET_URI = 'ui://widget/' + CONFIG.technicalName + '/workflow-dashboard-' + encodeURIComponent(String(CONFIG.version)) + '.html'
const closedWorldReadAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const externalReadAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const localWriteAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
const commissionedTaskAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
const repairingReadAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const appOnlyMetadata = { ui: { visibility: ['app'] } }

mkdirSync(TASK_DIR, { recursive: true })
let profileCache = PROFILE_SNAPSHOT
let profileRefreshedAt = 0
let cachedMcpAppsGlobalScript = ''

const server = new McpServer({ name: CONFIG.technicalName, version: CONFIG.version })

registerWorkflowDashboardResource()

registerAppTool(
  server,
  'render_workflow_dashboard_widget',
  {
    title: 'Render workflow dashboard widget',
    description: 'Open this plugin workflow dashboard as a native Codex widget. Call on the first plugin use in a conversation or when the user explicitly asks to open or restore the dashboard; the widget polls state by itself after rendering.',
    inputSchema: {},
    annotations: closedWorldReadAnnotations,
    _meta: {
      ui: { resourceUri: WIDGET_URI, visibility: ['model', 'app'] },
      'openai/outputTemplate': WIDGET_URI,
      'openai/widgetAccessible': true,
      'openai/toolInvocation/invoking': 'Opening workflow dashboard...',
      'openai/toolInvocation/invoked': 'Workflow dashboard ready'
    }
  },
  async () => ({
    content: [{ type: 'text', text: 'Rendered workflow dashboard widget.' }],
    structuredContent: {
      version: 1,
      widget: 'skillflow-workflow-dashboard',
      title: CONFIG.displayName,
      preferredDisplayMode: 'fullscreen'
    },
    _meta: {
      'openai/outputTemplate': WIDGET_URI,
      widgetData: {
        title: CONFIG.displayName,
        preferredDisplayMode: 'fullscreen'
      }
    }
  })
)

server.registerTool(
  'skillflow_login',
  {
    title: 'Connect Skill Flow account',
    description: 'Report whether the Skill Flow account needed by this plugin is connected.',
    inputSchema: {},
    annotations: externalReadAnnotations
  },
  async () => {
    const state = await refreshedDashboardState()
    if (CONFIG.monetizationMode !== 'commissioned') {
      return toolResult('This plugin does not require Skill Flow login.', { auth: state.auth })
    }
    return toolResult(
      state.auth.authenticated
        ? 'Skill Flow account is connected.'
        : 'Open the native workflow dashboard and complete Skill Flow phone login, then retry skillflow_login.',
      { auth: state.auth }
    )
  }
)

server.registerTool(
  'create_task',
  {
    title: 'Create workflow task',
    description: CONFIG.monetizationMode === 'commissioned'
      ? 'Create one new task from the bundled workflow. This charges the configured Skill Flow task fee before local task creation.'
      : 'Create one new task from the bundled workflow without charging Skill Flow credits.',
    inputSchema: { taskName: z.string(), requirement: z.string().optional() },
    annotations: CONFIG.monetizationMode === 'commissioned' ? commissionedTaskAnnotations : localWriteAnnotations
  },
  createWorkflowTask
)

server.registerTool(
  'start_task',
  {
    title: 'Start workflow task',
    description: 'Return every DAG node currently ready for execution.',
    inputSchema: { taskCode: z.string() },
    annotations: localWriteAnnotations
  },
  startWorkflowTask
)

server.registerTool(
  'complete_node',
  {
    title: 'Complete workflow node',
    description: 'Mark a verified node complete and advance the task.',
    inputSchema: { taskCode: z.string(), nodeCode: z.string(), summary: z.string().optional() },
    annotations: localWriteAnnotations
  },
  completeWorkflowNode
)

server.registerTool(
  'get_task_status',
  {
    title: 'Get task status',
    description: 'Read the bundled workflow and one task state, restoring missing local task workspace folders when needed.',
    inputSchema: { taskCode: z.string() },
    annotations: repairingReadAnnotations
  },
  reportWorkflowTaskStatus
)

registerAppTool(
  server,
  'dashboard_state',
  {
    title: 'Read workflow dashboard state',
    description: 'Read creator, account, workflow, and task state for the native dashboard.',
    inputSchema: {},
    annotations: externalReadAnnotations,
    _meta: appOnlyMetadata
  },
  async () => toolResult('Workflow dashboard state refreshed.', await refreshedDashboardState())
)

registerAppTool(
  server,
  'skillflow_send_login_code',
  {
    title: 'Send Skill Flow login code',
    description: 'Send a Skill Flow phone verification code requested from the native dashboard.',
    inputSchema: { phone: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _meta: appOnlyMetadata
  },
  async ({ phone }) => toolResult('Skill Flow login code sent.', await sendCreatorLoginCode(phone))
)

registerAppTool(
  server,
  'skillflow_verify_login_code',
  {
    title: 'Verify Skill Flow login code',
    description: 'Verify the phone code, store the local Skill Flow session, and register this plugin install.',
    inputSchema: { phone: z.string(), code: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: appOnlyMetadata
  },
  async ({ phone, code }) => toolResult('Skill Flow account connected.', await verifyCreatorLoginCode(phone, code))
)

registerAppTool(
  server,
  'skillflow_logout',
  {
    title: 'Sign out of Skill Flow',
    description: 'Revoke the current Skill Flow session when possible and remove local plugin credentials.',
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    _meta: appOnlyMetadata
  },
  async () => toolResult('Skill Flow account signed out.', await signOutCreatorPlugin())
)

const transport = new StdioServerTransport()
await server.connect(transport)

function toolResult(text, payload) {
  return { content: [{ type: 'text', text }], structuredContent: payload }
}

function registerWorkflowDashboardResource() {
  const description = 'Native task dashboard for ' + CONFIG.displayName + ', including creator profile, login, DAG progress, and outputs.'
  registerAppResource(
    server,
    CONFIG.displayName + ' workflow dashboard',
    WIDGET_URI,
    {
      title: CONFIG.displayName,
      description,
      _meta: widgetResourceMetadata(description)
    },
    async () => {
      await refreshProfile()
      const metadata = widgetResourceMetadata(description)
      return {
        contents: [{
          uri: WIDGET_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: workflowDashboardWidgetHtml(),
          _meta: metadata
        }]
      }
    }
  )
}

function widgetResourceMetadata(description) {
  const resourceDomains = ['data:']
  const avatarOrigin = trustedHttpsOrigin(profileCache?.avatarUrl)
  if (avatarOrigin) resourceDomains.push(avatarOrigin)
  return {
    ui: {
      prefersBorder: false,
      csp: {
        connectDomains: [],
        resourceDomains
      }
    },
    'openai/widgetDescription': description,
    'openai/widgetPrefersBorder': false,
    'openai/widgetCSP': {
      connect_domains: [],
      resource_domains: resourceDomains
    }
  }
}

function trustedHttpsOrigin(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:') {
      console.warn('[branded-skillflow] creator avatar URL is not HTTPS; widget will not load it url=' + raw)
      return null
    }
    return url.origin
  } catch (error) {
    console.warn('[branded-skillflow] creator avatar URL is invalid; widget will not load it url=' + raw, error)
    return null
  }
}

function workflowDashboardWidgetHtml() {
  const html = readFileSync(DASHBOARD_INDEX_PATH, 'utf8')
  const bridge = [
    '<script id="skillflowPluginBrand">',
    'window.__SKILLFLOW_PLUGIN_LOGO_DATA_URL__=' + JSON.stringify(pluginLogoDataUrl()) + ';',
    '</script>',
    '<script id="skillflowMcpAppsBundle">',
    escapeInlineScript(mcpAppsGlobalScript()),
    '</script>',
    '<script id="skillflowMcpHostBridge">',
    mcpHostBridgeScript(),
    '</script>'
  ].join('\n')
  if (html.includes('</head>')) return html.replace('</head>', () => bridge + '\n</head>')
  console.warn('[branded-skillflow] dashboard HTML has no closing head tag; MCP bridge prepended')
  return bridge + '\n' + html
}

function pluginLogoDataUrl() {
  return 'data:' + logoMimeType() + ';base64,' + readFileSync(LOGO_PATH).toString('base64')
}

function mcpAppsGlobalScript() {
  if (cachedMcpAppsGlobalScript) return cachedMcpAppsGlobalScript
  const sourcePath = require.resolve('@modelcontextprotocol/ext-apps/app-with-deps')
  const source = readFileSync(sourcePath, 'utf8')
  const exportStart = source.lastIndexOf('export{')
  if (exportStart === -1) throw new Error('Could not find ext-apps browser export block.')
  const exportBlock = source.slice(exportStart).match(/^export\{([^}]+)\};?\s*$/s)
  if (!exportBlock) throw new Error('Could not parse ext-apps browser export block.')
  const exportMap = parseBrowserExportMap(exportBlock[1])
  const requiredExports = ['App', 'applyDocumentTheme', 'applyHostFonts', 'applyHostStyleVariables']
  for (const name of requiredExports) {
    if (!exportMap.has(name)) throw new Error('Missing ext-apps browser export: ' + name)
  }
  cachedMcpAppsGlobalScript = [
    source.slice(0, exportStart),
    ';globalThis.__SKILLFLOW_MCP_APPS__={',
    requiredExports.map((name) => JSON.stringify(name) + ':' + exportMap.get(name)).join(','),
    '};'
  ].join('')
  return cachedMcpAppsGlobalScript
}

function parseBrowserExportMap(body) {
  const exportMap = new Map()
  for (const rawEntry of body.split(',')) {
    const entry = rawEntry.trim()
    if (!entry) continue
    const parts = entry.split(/\s+as\s+/)
    const local = parts[0]?.trim()
    const exported = (parts[1] || parts[0])?.trim()
    if (local && exported) exportMap.set(exported, local)
  }
  return exportMap
}

function escapeInlineScript(source) {
  return source.replace(/<\/script/gi, '<\\/script')
}

function mcpHostBridgeScript() {
  return [
    '(() => {',
    '  "use strict";',
    '  const apps = globalThis.__SKILLFLOW_MCP_APPS__;',
    '  if (!apps || typeof apps.App !== "function") {',
    '    console.error("[skillflow-widget] MCP Apps browser bundle is unavailable.");',
    '    return;',
    '  }',
    '  let mcpApp = null;',
    '  let bridgeReady = null;',
    '  function applyHostContext(context) {',
    '    if (!context) return;',
    '    try {',
    '      if (context.theme) apps.applyDocumentTheme(context.theme);',
    '      if (context.styles?.variables) apps.applyHostStyleVariables(context.styles.variables);',
    '      if (context.styles?.css?.fonts) apps.applyHostFonts(context.styles.css.fonts);',
    '    } catch (error) {',
    '      console.warn("[skillflow-widget] failed to apply host theme; dashboard theme continues", error);',
    '    }',
    '  }',
    '  function bridgeError(error) {',
    '    return error instanceof Error ? error : new Error(String(error || "Skill Flow MCP Apps bridge is unavailable."));',
    '  }',
    '  const bridge = {',
    '    async callServerTool(request, options) {',
    '      try {',
    '        await bridgeReady;',
    '        return await mcpApp.callServerTool(request, options);',
    '      } catch (error) {',
    '        throw bridgeError(error);',
    '      }',
    '    },',
    '    async openExternal(url) {',
    '      try {',
    '        await bridgeReady;',
    '        return await mcpApp.openLink({ url: String(url) });',
    '      } catch (error) {',
    '        throw bridgeError(error);',
    '      }',
    '    },',
    '    dispose() {',
    '      if (!mcpApp || typeof mcpApp.close !== "function") return;',
    '      const closing = mcpApp.close();',
    '      if (closing?.catch) closing.catch((error) => console.warn("[skillflow-widget] failed to close MCP Apps bridge", error));',
    '    }',
    '  };',
    '  window.skillflowMcp = bridge;',
    '  try {',
    '    mcpApp = new apps.App(',
    '      ' + JSON.stringify({ name: String(CONFIG.technicalName), version: String(CONFIG.version) }) + ',',
    '      { availableDisplayModes: ["inline", "fullscreen"] },',
    '      { autoResize: true }',
    '    );',
    '    mcpApp.addEventListener("hostcontextchanged", applyHostContext);',
    '    bridgeReady = mcpApp.connect().then(async () => {',
    '      applyHostContext(mcpApp.getHostContext && mcpApp.getHostContext());',
    '      if (typeof mcpApp.requestDisplayMode === "function") {',
    '        try {',
    '          await mcpApp.requestDisplayMode({ mode: "fullscreen" });',
    '        } catch (error) {',
    '          console.warn("[skillflow-widget] host kept the default display mode", error);',
    '        }',
    '      }',
    '    }).catch((error) => {',
    '      console.error("[skillflow-widget] failed to connect MCP Apps bridge", error);',
    '      throw error;',
    '    });',
    '  } catch (error) {',
    '    bridgeReady = Promise.reject(error);',
    '    bridgeReady.catch((connectError) => console.error("[skillflow-widget] failed to initialize MCP Apps bridge", connectError));',
    '  }',
    '})();'
  ].join('\n')
}

function logoMimeType() {
  const extension = extname(LOGO_PATH).toLowerCase()
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  return 'image/png'
}

async function createWorkflowTask(args) {
  // 为每次用户请求生成独立任务，并在收费模式下先完成扣费授权。
  const taskCode = 'task_' + randomUUID().replace(/-/g, '').slice(0, 16)
  const createdAt = new Date().toISOString()
  const task = {
    code: taskCode,
    name: required(args.taskName, 'taskName'),
    requirement: String(args.requirement ?? ''),
    workflow_code: WORKFLOW.code,
    workflow_version: WORKFLOW.version ?? 1,
    status: 'pending',
    createdAt,
    created_at: createdAt,
    updated_at: createdAt,
    executionToken: null,
    nodes: Object.fromEntries(WORKFLOW.nodes.map((node) => [node.code, {
      status: 'pending',
      summary: '',
      workspace_key: node.workspace_key,
      require_review: false,
      review_skipped: false,
      verification_items: []
    }]))
  }
  if (CONFIG.monetizationMode === 'commissioned') {
    credentialsOrThrow()
    const installationKey = required(runtime().installationKey, 'installationKey')
    const body = await authenticatedApi('/creator-commission/codex-plugins/task-executions', {
      technicalName: CONFIG.technicalName,
      version: CONFIG.version,
      installationKey,
      clientTaskId: taskCode
    })
    task.executionToken = required(body.execution?.executionToken, 'executionToken')
  }
  try {
    initializeTaskWorkspace(task)
    writeTask(task)
  } catch (error) {
    if (task.executionToken) {
      console.error('[branded-skillflow] charged task persistence failed task=' + taskCode + '; fixed fee is not refunded automatically.', error)
    }
    throw error
  }
  return toolResult('Created task ' + taskCode + '.', { task, workflow: WORKFLOW, executionToken: task.executionToken })
}

async function startWorkflowTask(args) {
  const task = readTask(required(args.taskCode, 'taskCode'))
  const readyNodes = WORKFLOW.nodes
    .filter((node) => task.nodes[node.code]?.status === 'pending' && incoming(node.code).every((source) => task.nodes[source]?.status === 'completed'))
    .map((node) => nodeExecutionContext(task, node))
  for (const node of readyNodes) task.nodes[node.code].status = 'running'
  if (readyNodes.length > 0) task.status = 'running'
  else if (Object.values(task.nodes).every((node) => node.status === 'completed')) task.status = 'completed'
  task.updated_at = new Date().toISOString()
  writeTask(task)
  return toolResult('Task has ' + readyNodes.length + ' ready node(s).', { task, readyNodes, executionToken: task.executionToken })
}

async function completeWorkflowNode(args) {
  const task = readTask(required(args.taskCode, 'taskCode'))
  const nodeCode = required(args.nodeCode, 'nodeCode')
  if (!task.nodes[nodeCode]) throw new Error('Unknown node: ' + nodeCode)
  const summary = String(args.summary ?? '')
  task.nodes[nodeCode] = {
    ...task.nodes[nodeCode],
    status: 'completed',
    summary,
    verification_items: summary ? [summary] : []
  }
  if (Object.values(task.nodes).every((node) => node.status === 'completed')) task.status = 'completed'
  task.updated_at = new Date().toISOString()
  writeTask(task)
  return toolResult('Completed node ' + nodeCode + '.', { task })
}

async function reportWorkflowTaskStatus(args) {
  const task = readTask(required(args.taskCode, 'taskCode'))
  return toolResult('Task ' + task.code + ' status=' + task.status + '.', { workflow: WORKFLOW, task })
}

function required(value, name) {
  const normalized = String(value ?? '').trim()
  if (!normalized) throw new Error(name + ' is required')
  return normalized
}

function validLoginPhone(value) {
  const phone = required(value, 'phone')
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new Error('手机号格式不正确')
  return phone
}

function validLoginCode(value) {
  const code = required(value, 'code')
  if (!/^\d{6}$/.test(code)) throw new Error('验证码必须是 6 位数字')
  return code
}

function runtime() {
  return existsSync(RUNTIME_PATH) ? JSON.parse(readFileSync(RUNTIME_PATH, 'utf8')) : {}
}

function hasCredentials() {
  return existsSync(CREDENTIALS_PATH)
}

function credentialsOrThrow() {
  if (!hasCredentials()) throw new Error('Login required. Call skillflow_login first.')
  return JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8'))
}

function taskPath(code) {
  return join(TASK_DIR, validTaskCode(code) + '.json')
}

function validTaskCode(value) {
  const code = String(value ?? '').trim()
  if (!/^task_[a-f0-9]{16}$/.test(code)) throw new Error('Invalid task code')
  return code
}

function readTask(code) {
  const path = taskPath(code)
  if (!existsSync(path)) throw new Error('Task not found: ' + code)
  const task = JSON.parse(readFileSync(path, 'utf8'))
  initializeTaskWorkspace(task)
  return task
}

function writeTask(task) {
  writeJson(taskPath(task.code), task)
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
}

function incoming(code) {
  return WORKFLOW.edges.filter((edge) => edge.target === code).map((edge) => edge.source)
}

function initializeTaskWorkspace(task) {
  const taskDir = join(TASK_DIR, task.code)
  mkdirSync(taskDir, { recursive: true })
  const taskRequirementPath = join(taskDir, 'requirement.md')
  if (!existsSync(taskRequirementPath)) writeFileSync(taskRequirementPath, String(task.requirement ?? ''), 'utf8')
  for (const node of WORKFLOW.nodes) {
    const taskNodeDir = join(taskDir, 'nodes', node.workspace_key)
    const contextDir = join(taskNodeDir, 'Context')
    const bundledContextDir = join(ROOT, 'workflow', 'nodes', node.workspace_key, 'Context')
    const shouldRestoreContext = !existsSync(contextDir)
    if (shouldRestoreContext) mkdirSync(contextDir, { recursive: true })
    mkdirSync(join(taskNodeDir, 'outputs'), { recursive: true })
    if (shouldRestoreContext && existsSync(bundledContextDir)) cpSync(bundledContextDir, contextDir, { recursive: true })
  }
}

function nodeExecutionContext(task, node) {
  const taskNodeDir = join(TASK_DIR, task.code, 'nodes', node.workspace_key)
  const contextDir = join(taskNodeDir, 'Context')
  const nodeDefinitionDir = join(ROOT, 'workflow', 'nodes', node.workspace_key)
  return {
    ...node,
    taskNodeDir,
    outputsDir: join(taskNodeDir, 'outputs'),
    contextDir,
    contextPaths: contextPaths(contextDir),
    requirementPath: join(TASK_DIR, task.code, 'requirement.md'),
    missionPath: join(nodeDefinitionDir, 'Mission.md'),
    verificationPath: join(nodeDefinitionDir, 'Verification.md')
  }
}

function contextPaths(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !isSystemMetadataFile(entry.name))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
}

function isSystemMetadataFile(fileName) {
  const normalized = String(fileName).toLowerCase()
  return normalized === '.ds_store' || normalized === 'thumbs.db'
}

async function requestBackend(path, options = {}) {
  const response = await fetch(CONFIG.apiBase + path, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(options.headers ?? {})
    },
    body: JSON.stringify(options.body ?? {})
  })
  const payload = await response.json().catch((error) => {
    console.warn('[branded-skillflow] response JSON parse failed path=' + path, error)
    return {}
  })
  if (!response.ok) {
    const apiError = new Error(payload.message ?? payload.error?.message ?? payload.error ?? ('Skill Flow API HTTP ' + response.status))
    apiError.httpStatus = response.status
    throw apiError
  }
  return payload
}

async function authenticatedApi(path, body) {
  let credentials = await refreshCredentials(false)
  try {
    return await requestBackend(path, { headers: authenticationHeaders(credentials), body })
  } catch (error) {
    if (error?.httpStatus !== 401 || credentials.apiKey) throw error
    console.warn('[branded-skillflow] access token rejected; refreshing once path=' + path)
    credentials = await refreshCredentials(true)
    return await requestBackend(path, { headers: authenticationHeaders(credentials), body })
  }
}

function authenticationHeaders(credentials) {
  if (credentials.apiKey && credentials.clientId) {
    return { authorization: 'Bearer ' + credentials.apiKey, 'x-skillflow-client-id': credentials.clientId }
  }
  return { authorization: 'Bearer ' + required(credentials.accessToken, 'accessToken') }
}

async function refreshCredentials(force) {
  const credentials = credentialsOrThrow()
  if (credentials.apiKey && credentials.clientId) return credentials
  const expiresAt = Number(credentials.expiresAt)
  if (!force && Number.isFinite(expiresAt) && expiresAt > Date.now() + 300000) return credentials
  const payload = await requestBackend('/auth/refresh', {
    body: { refreshToken: required(credentials.refreshToken, 'refreshToken') }
  })
  const refreshed = {
    ...credentials,
    accessToken: required(payload.accessToken, 'accessToken'),
    refreshToken: required(payload.refreshToken, 'refreshToken'),
    expiresAt: Date.now() + Number(payload.accessTokenExpiresInSeconds) * 1000
  }
  writeJson(CREDENTIALS_PATH, refreshed)
  return refreshed
}

function normalizeLoginSession(payload) {
  const expiresInSeconds = Number(payload.accessTokenExpiresInSeconds)
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) throw new Error('accessTokenExpiresInSeconds is invalid')
  const user = payload.user && typeof payload.user === 'object' ? payload.user : null
  if (!user) throw new Error('user is required')
  return {
    provider: 'phone',
    accessToken: required(payload.accessToken, 'accessToken'),
    refreshToken: required(payload.refreshToken, 'refreshToken'),
    expiresAt: Date.now() + expiresInSeconds * 1000,
    user: {
      id: required(user.id, 'user.id'),
      phone: required(user.phone, 'user.phone'),
      role: String(user.role ?? 'normal')
    }
  }
}

function ensureInstallationKey() {
  const state = runtime()
  if (state.installationKey) return state.installationKey
  const installationKey = randomUUID()
  writeJson(RUNTIME_PATH, { ...state, installationKey })
  return installationKey
}

async function registerCommissionedInstall() {
  const installationKey = ensureInstallationKey()
  await authenticatedApi('/creator-commission/codex-plugins/install', {
    technicalName: CONFIG.technicalName,
    version: CONFIG.version,
    installationKey
  })
}

function authSummary() {
  if (CONFIG.monetizationMode !== 'commissioned') return { required: false, authenticated: true, user: null }
  if (!hasCredentials()) return { required: true, authenticated: false, user: null }
  try {
    const credentials = credentialsOrThrow()
    return {
      required: true,
      authenticated: true,
      user: credentials.user ? {
        phone: String(credentials.user.phone ?? '')
      } : null
    }
  } catch (error) {
    console.warn('[branded-skillflow] credentials state invalid; reporting signed out', error)
    return { required: true, authenticated: false, user: null }
  }
}

async function sendCreatorLoginCode(phoneValue) {
  requireCommissionedPlugin()
  const phone = validLoginPhone(phoneValue)
  await requestBackend('/auth/send-verification', { body: { phone } })
  return { success: true }
}

async function verifyCreatorLoginCode(phoneValue, codeValue) {
  requireCommissionedPlugin()
  // 验证成功后保存本机登录态，并登记当前插件安装归因。
  const phone = validLoginPhone(phoneValue)
  const code = validLoginCode(codeValue)
  const payload = await requestBackend('/auth/verify-and-login', { body: { phone, code } })
  writeJson(CREDENTIALS_PATH, normalizeLoginSession(payload))
  await registerCommissionedInstall()
  return { auth: authSummary() }
}

async function signOutCreatorPlugin() {
  // 后端退出失败时仍清理本机凭证，避免用户在插件中继续处于伪登录状态。
  const credentials = hasCredentials() ? credentialsOrThrow() : null
  if (credentials?.refreshToken) {
    try {
      await requestBackend('/auth/logout', { body: { refreshToken: credentials.refreshToken } })
    } catch (error) {
      console.warn('[branded-skillflow] backend logout failed; local logout continues', error)
    }
  }
  rmSync(CREDENTIALS_PATH, { force: true })
  return { auth: authSummary() }
}

function requireCommissionedPlugin() {
  if (CONFIG.monetizationMode !== 'commissioned') throw new Error('This plugin does not require Skill Flow login')
}

async function refreshedDashboardState() {
  await refreshProfile()
  return dashboardState()
}

function dashboardState() {
  const tasks = readdirSync(TASK_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => dashboardTask(JSON.parse(readFileSync(join(TASK_DIR, name), 'utf8'))))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  return {
    mode: 'creator',
    auth: authSummary(),
    creator: {
      config: {
        displayName: CONFIG.displayName,
        shortDescription: CONFIG.shortDescription,
        brandColor: CONFIG.brandColor
      },
      profile: {
        displayName: profileCache.displayName,
        avatarUrl: profileCache.avatarUrl,
        bio: profileCache.bio,
        links: Array.isArray(profileCache.links) ? profileCache.links : []
      }
    },
    workflows: [{ workflow: WORKFLOW, tasks }]
  }
}

function dashboardTask(task) {
  const visibleTask = { ...task }
  delete visibleTask.executionToken
  const createdAt = task.created_at ?? task.createdAt ?? new Date().toISOString()
  const nodes = Object.fromEntries(WORKFLOW.nodes.map((workflowNode) => {
    const taskNode = task.nodes?.[workflowNode.code] ?? {}
    const summary = String(taskNode.summary ?? '')
    return [workflowNode.code, {
      ...taskNode,
      status: taskNode.status ?? 'pending',
      summary,
      workspace_key: taskNode.workspace_key ?? workflowNode.workspace_key,
      require_review: taskNode.require_review === true,
      review_skipped: taskNode.review_skipped === true,
      verification_items: Array.isArray(taskNode.verification_items)
        ? taskNode.verification_items
        : (summary ? [summary] : [])
    }]
  }))
  return {
    ...visibleTask,
    workflow_code: task.workflow_code ?? WORKFLOW.code,
    workflow_version: task.workflow_version ?? WORKFLOW.version ?? 1,
    createdAt,
    created_at: createdAt,
    updated_at: task.updated_at ?? createdAt,
    nodes
  }
}

async function refreshProfile() {
  if (Date.now() - profileRefreshedAt < 60000) return
  profileRefreshedAt = Date.now()
  try {
    const response = await fetch(CONFIG.apiBase + CONFIG.profileEndpoint)
    if (!response.ok) throw new Error('HTTP ' + response.status)
    const payload = await response.json()
    if (payload.profile) profileCache = payload.profile
  } catch (error) {
    console.warn('[branded-skillflow] creator profile refresh failed; using package snapshot endpoint=' + CONFIG.profileEndpoint, error)
  }
}
