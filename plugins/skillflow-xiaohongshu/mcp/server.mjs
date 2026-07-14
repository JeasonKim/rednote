import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { ensureCodexBrowserRuntimeCompatibility } from './codex-browser-compat.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'assets', 'config.json'), 'utf8'))
const WORKFLOW = JSON.parse(readFileSync(join(ROOT, 'assets', 'workflow.json'), 'utf8'))
const PROFILE_SNAPSHOT = JSON.parse(readFileSync(join(ROOT, 'assets', 'creator.json'), 'utf8'))
const DATA_ROOT = process.env.SKILLFLOW_PLUGIN_DATA_ROOT?.trim() || join(homedir(), '.skillflow', 'codex', CONFIG.technicalName)
const TASK_DIR = join(DATA_ROOT, 'tasks')
const CREDENTIALS_PATH = join(DATA_ROOT, 'credentials.json')
const RUNTIME_PATH = join(DATA_ROOT, 'runtime.json')
const DASHBOARD_INDEX_PATH = join(ROOT, 'dashboard', 'index.html')
const LOGO_PATH = join(ROOT, 'assets', 'logo' + extname(CONFIG.logoPath))
const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }

mkdirSync(TASK_DIR, { recursive: true })
let profileCache = PROFILE_SNAPSHOT
let profileRefreshedAt = 0
let dashboardServer = null
let dashboardUrl = null

const server = new McpServer({ name: CONFIG.technicalName, version: CONFIG.version })

server.registerTool(
  'open_workflow_dashboard',
  {
    title: 'Open workflow dashboard',
    description: 'Idempotently start this plugin dashboard on 127.0.0.1 and return its URL. At the beginning of every plugin turn, use browser:control-in-app-browser to keep one dedicated Codex in-app Browser sidebar tab open at this URL; never close it when the turn ends.',
    inputSchema: {},
    annotations: readOnlyAnnotations
  },
  openWorkflowDashboard
)

server.registerTool(
  'skillflow_login',
  {
    title: 'Connect Skill Flow account',
    description: 'Report whether the Skill Flow account needed by this plugin is connected.',
    inputSchema: {},
    annotations: readOnlyAnnotations
  },
  async () => {
    const state = await refreshedDashboardState()
    if (CONFIG.monetizationMode !== 'commissioned') {
      return toolResult('This plugin does not require Skill Flow login.', { auth: state.auth })
    }
    return toolResult(
      state.auth.authenticated
        ? 'Skill Flow account is connected.'
        : 'Open the workflow dashboard in the Codex in-app Browser and complete Skill Flow phone login, then retry skillflow_login.',
      { auth: state.auth }
    )
  }
)

server.registerTool(
  'create_task',
  {
    title: 'Create workflow task',
    description: 'Create one new task from the bundled workflow.',
    inputSchema: { taskName: z.string(), requirement: z.string().optional() },
    annotations: writeAnnotations
  },
  createWorkflowTask
)

server.registerTool(
  'start_task',
  {
    title: 'Start workflow task',
    description: 'Return every DAG node currently ready for execution.',
    inputSchema: { taskCode: z.string() },
    annotations: writeAnnotations
  },
  startWorkflowTask
)

server.registerTool(
  'complete_node',
  {
    title: 'Complete workflow node',
    description: 'Mark a verified node complete and advance the task.',
    inputSchema: { taskCode: z.string(), nodeCode: z.string(), summary: z.string().optional() },
    annotations: writeAnnotations
  },
  completeWorkflowNode
)

server.registerTool(
  'get_task_status',
  {
    title: 'Get task status',
    description: 'Read the bundled workflow and one task state.',
    inputSchema: { taskCode: z.string() },
    annotations: readOnlyAnnotations
  },
  reportWorkflowTaskStatus
)

const transport = new StdioServerTransport()
await server.connect(transport)

function toolResult(text, payload) {
  return { content: [{ type: 'text', text }], structuredContent: payload }
}

async function openWorkflowDashboard() {
  ensureCodexBrowserRuntimeCompatibility()
  if (!dashboardServer) {
    dashboardServer = createServer((request, response) => {
      serveDashboardRequest(request, response).catch((error) => {
        console.error('[branded-skillflow] dashboard request failed method=' + request.method + ' url=' + request.url, error)
        if (!response.headersSent) sendHttpJson(response, 500, { message: 'Dashboard request failed.' })
        else response.destroy(error)
      })
    })
    await new Promise((resolveOpen, rejectOpen) => {
      function rejectDashboardOpen(error) {
        dashboardServer = null
        rejectOpen(error)
      }
      dashboardServer.once('error', rejectDashboardOpen)
      dashboardServer.listen(0, '127.0.0.1', () => {
        dashboardServer.off('error', rejectDashboardOpen)
        resolveOpen()
      })
    })
    const address = dashboardServer.address()
    if (!address || typeof address === 'string') throw new Error('Dashboard server did not expose a TCP port.')
    dashboardUrl = 'http://127.0.0.1:' + address.port + '/'
  }
  return toolResult(CONFIG.displayName + ' dashboard: ' + dashboardUrl, {
    url: dashboardUrl,
    auth: authSummary()
  })
}

async function serveDashboardRequest(request, response) {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    sendHttp(response, 200, 'text/html; charset=utf-8', readFileSync(DASHBOARD_INDEX_PATH))
    return
  }
  if (request.method === 'GET' && url.pathname === CONFIG.logoPath) {
    sendHttp(response, 200, logoMimeType(), readFileSync(LOGO_PATH))
    return
  }
  if (request.method === 'GET' && url.pathname === '/favicon.ico') {
    response.writeHead(204, { 'cache-control': 'no-store' })
    response.end()
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/state') {
    sendHttpJson(response, 200, await refreshedDashboardState())
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/send-code') {
    const body = await readDashboardRequestJson(request)
    sendHttpJson(response, 200, await sendCreatorLoginCode(body.phone))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/verify-code') {
    const body = await readDashboardRequestJson(request)
    sendHttpJson(response, 200, await verifyCreatorLoginCode(body.phone, body.code))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    sendHttpJson(response, 200, await signOutCreatorPlugin())
    return
  }
  sendHttpJson(response, 404, { message: 'Not found.' })
}

async function readDashboardRequestJson(request) {
  const chunks = []
  let byteLength = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteLength += buffer.length
    if (byteLength > 65536) throw new Error('Dashboard request body is too large.')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch (error) {
    console.warn('[branded-skillflow] dashboard request JSON parse failed url=' + request.url, error)
    throw new Error('Dashboard request body must be valid JSON.')
  }
}

function sendHttpJson(response, statusCode, payload) {
  sendHttp(response, statusCode, 'application/json; charset=utf-8', JSON.stringify(payload))
}

function sendHttp(response, statusCode, contentType, body) {
  response.writeHead(statusCode, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  response.end(body)
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
        id: String(credentials.user.id ?? ''),
        phone: String(credentials.user.phone ?? ''),
        role: String(credentials.user.role ?? 'normal')
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
    projectDir: CONFIG.displayName,
    rootDir: DATA_ROOT,
    auth: authSummary(),
    creator: { config: CONFIG, profile: profileCache },
    workflows: [{ workflow: WORKFLOW, tasks }]
  }
}

function dashboardTask(task) {
  initializeTaskWorkspace(task)
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
    ...task,
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
