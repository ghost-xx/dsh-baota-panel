/**
 * Host half of dsh-baota-panel.
 *
 * Two faces over one set of panel operations:
 *  - Agent tools (`ctx.tools`) so the model can inspect and change any configured panel.
 *  - A `baota` Host service exposed to the browser half through the typert
 *    Remote channel (`ctx.remote.baota.*`), which drives the sidebar panel.
 *
 * Multiple panels: `config.panels` is a list. Every tool and Remote method takes
 * an optional `panel` (id or name) and defaults to the active panel.
 *
 * Endpoint notes (verified against Baota Linux panel 13.2.0):
 *  - The API lives at the panel root; the security entrance is only needed as a
 *    Referer for a few session-guarded routes, never as a URL prefix.
 *  - Website/database/log lists come from `/data?action=getData&table=...`.
 *  - `/firewall` and `/logs` route handlers demand a browser login session on
 *    some builds; those tools report the panel's own message instead of hiding it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BaotaClient } from './bt-api.js'

export const name = 'dsh-baota-panel'
export const inject = ['tools']

const MAX_FILE_CHARS = 200000
const MAX_LOG_CHARS = 20000

/* ------------------------------------------------------------------ */
/* Remote contract — the browser half repeats these descriptors.       */
/* ------------------------------------------------------------------ */

const jsonCodec = (symbol) => ({
  mode: 'strict',
  typeSymbol: `dsh-baota-panel#${symbol}`,
  create: () => ({ parse: (value) => value }),
})

const optionalString = (value) => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('Expected a string')
  return value
}

const remoteMethod = (method, parameters = []) => ({
  id: `dsh-baota-panel#baota/${method}`,
  service: 'baota',
  namespace: 'baota',
  method,
  invocation: { kind: 'direct' },
  result: jsonCodec('Result'),
  parameters: parameters.map((parameter) => ({
    name: parameter.wire,
    wire: parameter.wire,
    source: 'json',
    codec: jsonCodec(parameter.symbol),
  })),
})

export const BAOTA_DESCRIPTORS = Object.freeze([
  remoteMethod('config'),
  remoteMethod('overview', [{ wire: 'panel', symbol: 'PanelRef' }]),
  remoteMethod('sites', [{ wire: 'panel', symbol: 'PanelRef' }]),
  remoteMethod('databases', [{ wire: 'panel', symbol: 'PanelRef' }]),
  remoteMethod('services', [{ wire: 'panel', symbol: 'PanelRef' }]),
  remoteMethod('refresh'),
  remoteMethod('addPanel', [{ wire: 'panel', symbol: 'PanelInput' }]),
  remoteMethod('updatePanel', [{ wire: 'request', symbol: 'PanelUpdate' }]),
  remoteMethod('removePanel', [{ wire: 'id', symbol: 'PanelId' }]),
  remoteMethod('activatePanel', [{ wire: 'id', symbol: 'PanelId' }]),
  remoteMethod('setShowInSidebar', [{ wire: 'value', symbol: 'Flag' }]),
  remoteMethod('trace', [{ wire: 'message', symbol: 'Text' }]),
])

const BAOTA_REMOTE = Object.freeze({ package: 'dsh-baota-panel', descriptors: BAOTA_DESCRIPTORS })

/* ------------------------------------------------------------------ */
/* Normalisation helpers                                               */
/* ------------------------------------------------------------------ */

const num = (value) => {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : value
  return Number.isFinite(parsed) ? parsed : undefined
}

const percent = (used, total) => {
  const u = num(used)
  const t = num(total)
  if (u === undefined || t === undefined || t <= 0) return undefined
  return Math.round((u / t) * 1000) / 10
}

/** `page` is an HTML pagination fragment such as `…共4条…`; pull the total out. */
const pageTotal = (page) => {
  if (typeof page !== 'string') return undefined
  const match = /共\s*(\d+)\s*条/.exec(page)
  return match === null ? undefined : Number.parseInt(match[1], 10)
}

const rows = (payload) => (Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [])

function normalizeSites(payload) {
  return rows(payload).map((row) => ({
    id: row.id ?? undefined,
    name: row.name ?? '',
    path: row.path ?? '',
    status: String(row.status) === '1',
    ps: row.ps ?? '',
    addtime: row.addtime ?? '',
    projectType: row.project_type ?? '',
  }))
}

function normalizeDatabases(payload) {
  return rows(payload).map((row) => ({
    id: row.id ?? undefined,
    name: row.name ?? '',
    username: row.username ?? '',
    type: row.type ?? '',
    ps: row.ps ?? '',
  }))
}

function normalizeLogs(payload) {
  return rows(payload).map((row) => ({
    id: row.id ?? undefined,
    user: row.username ?? '',
    type: row.type ?? '',
    log: row.log ?? '',
    at: row.addtime ?? '',
  }))
}

/** Crontab rows carry ~40 columns; keep the ones an operator reads. */
function normalizeCrontab(payload) {
  return rows(payload).map((row) => ({
    id: row.id ?? undefined,
    name: row.name ?? '',
    type: row.type ?? '',
    cycle: row.cycle ?? row.type_zh ?? '',
    command: row.sBody ?? '',
    shellType: row.sType ?? '',
    status: Number(row.status) === 1,
    at: row.addtime ?? '',
  }))
}

/** The panel exposes installed software through GetConcifInfo; drop secrets. */
function normalizeServices(conf) {
  const list = []
  const web = conf?.web
  if (web && web.setup !== false) {
    list.push({ name: web.type ?? conf?.webserver ?? 'web', version: String(web.version ?? ''), running: web.status === true })
  }
  const mysql = conf?.mysql
  if (mysql && mysql.setup !== false) {
    list.push({ name: 'mysql', version: String(mysql.version ?? ''), running: mysql.status === true })
  }
  for (const php of Array.isArray(conf?.php) ? conf.php : []) {
    if (php?.setup === false) continue
    list.push({ name: `php-${php.version}`, version: String(php.version ?? ''), running: php.status === true })
  }
  return list
}

/* ------------------------------------------------------------------ */
/* Panel list                                                          */
/* ------------------------------------------------------------------ */

const slug = (value, fallback) => {
  const base = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base === '' ? fallback : base.slice(0, 32)
}

/** Read the configured panels, accepting the single-panel shape older rows used. */
function readPanels(raw) {
  const normalize = (panel, index) => {
    const panelUrl = String(panel.panelUrl ?? '').trim().replace(/\/+$/, '')
    const name = String(panel.name ?? '').trim()
    return {
      id: String(panel.id ?? '').trim() || slug(name, `panel-${index + 1}`),
      name: name === '' ? panelUrl : name,
      panelUrl,
      apiKey: String(panel.apiKey ?? '').trim(),
      securityEntrance: String(panel.securityEntrance ?? '').trim(),
      verifyTls: panel.verifyTls === true,
    }
  }
  if (Array.isArray(raw.panels) && raw.panels.length > 0) return raw.panels.map(normalize)
  if (String(raw.panelUrl ?? '').trim() !== '') {
    return [normalize({ id: 'default', name: raw.name ?? '默认面板', panelUrl: raw.panelUrl, apiKey: raw.apiKey, securityEntrance: raw.securityEntrance, verifyTls: raw.verifyTls }, 0)]
  }
  return []
}

const describePanel = (panel) => ({
  id: panel.id,
  name: panel.name,
  panelUrl: panel.panelUrl,
  panelHost: (() => {
    try {
      return new URL(panel.panelUrl).host
    } catch {
      return ''
    }
  })(),
  hasApiKey: panel.apiKey !== '',
  apiKeyTail: panel.apiKey === '' ? '' : panel.apiKey.slice(-4),
  securityEntrance: panel.securityEntrance,
  verifyTls: panel.verifyTls,
  configured: panel.panelUrl !== '' && panel.apiKey !== '',
})

/* ------------------------------------------------------------------ */
/* Plugin state                                                        */
/* ------------------------------------------------------------------ */

/**
 * The panel list lives in a plugin-owned state file, not in the profile's
 * `cordis.patch.yml`: writing an ordinary config field restarts the plugin, and
 * an editor that saves on every add/edit must not tear its own Remote channel
 * down mid-request. Reads are synchronous and cheap; writes are atomic.
 */
const stateFile = () => {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'baota-panel', 'state.json')
}

function loadState(rawConfig) {
  const file = stateFile()
  try {
    const text = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object') {
      return {
        panels: readPanels({ panels: Array.isArray(parsed.panels) ? parsed.panels : [] })
          .filter((panel) => panel.panelUrl !== ''),
        activePanel: typeof parsed.activePanel === 'string' ? parsed.activePanel : '',
        showInSidebar: parsed.showInSidebar !== false,
      }
    }
  } catch {
    // Missing or unreadable state falls back to the row config (first run).
  }
  // Drafts without an address are client-side only; a stored one is debris from
  // an interrupted edit, so it never survives a restart.
  const seeded = readPanels(rawConfig).filter((panel) => panel.panelUrl !== '')
  return {
    panels: seeded,
    activePanel: String(rawConfig.activePanel ?? ''),
    showInSidebar: rawConfig.showInSidebar !== false,
  }
}

function writeState(state) {
  const file = stateFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8')
  fs.renameSync(temporary, file)
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

export function apply(ctx, rawConfig = {}) {
  const state = loadState(rawConfig)
  const config = {
    panels: state.panels,
    activePanel: state.activePanel,
    showInSidebar: state.showInSidebar,
    requestTimeoutMs: Number.isFinite(rawConfig.requestTimeoutMs) ? rawConfig.requestTimeoutMs : 20000,
  }
  const clients = new Map()
  const overviewCaches = new Map()

  const activeOf = () => config.panels.find((panel) => panel.id === config.activePanel) ?? config.panels[0]

  const resolvePanel = (ref) => {
    if (config.panels.length === 0) {
      throw new Error('尚未配置宝塔面板：请在「设置 → 宝塔面板」添加，或调用 bt_config action=add')
    }
    if (ref === undefined || ref === null || ref === '') return activeOf()
    const wanted = String(ref).trim()
    const found =
      config.panels.find((panel) => panel.id === wanted) ??
      config.panels.find((panel) => panel.name === wanted) ??
      config.panels.find((panel) => panel.panelUrl === wanted) ??
      config.panels.find((panel) => panel.name.toLowerCase() === wanted.toLowerCase())
    if (found === undefined) {
      throw new Error(`未找到面板 ${wanted}；可用：${config.panels.map((panel) => `${panel.id}(${panel.name})`).join('、')}`)
    }
    return found
  }

  const clientFor = (panel) => {
    let client = clients.get(panel.id)
    if (client === undefined || client.panelUrl !== panel.panelUrl || client.apiKey !== panel.apiKey) {
      client = new BaotaClient({
        panelUrl: panel.panelUrl,
        apiKey: panel.apiKey,
        securityEntrance: panel.securityEntrance,
        verifyTls: panel.verifyTls,
        requestTimeoutMs: config.requestTimeoutMs,
      })
      clients.set(panel.id, client)
    }
    return client
  }

  const call = (panelRef, moduleName, action, params) => clientFor(resolvePanel(panelRef)).call(moduleName, action, params)

  /** Panel payloads carry secrets (TLS private keys, DB root password); never forward them. */
  const SECRET_KEYS = new Set(['mysql_root', 'key', 'csr', 'cert', 'password', 'privateKey', 'private_key'])
  const stripSecrets = (value, depth = 0) => {
    if (depth > 4 || value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map((item) => stripSecrets(item, depth + 1))
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEYS.has(key)) {
        out[key] = typeof item === 'string' && item !== '' ? '***' : item
        continue
      }
      out[key] = stripSecrets(item, depth + 1)
    }
    return out
  }

  const panelOps = (panelRef) => {
    const panel = resolvePanel(panelRef)
    const callOn = (moduleName, action, params) => clientFor(panel).call(moduleName, action, params)
    return {
      panel,
      call: callOn,
      system: () => callOn('system', 'GetSystemTotal'),
      load: () => callOn('system', 'GetLoadAverage'),
      disk: () => callOn('system', 'GetDiskInfo'),
      network: () => callOn('system', 'GetNetWork'),
      conf: async () => stripSecrets(await callOn('system', 'GetConcifInfo')),
      async sites() {
        const payload = await callOn('data', 'getData', { table: 'sites', p: 1, limit: 200, type: -1, order: 'id desc' })
        return { items: normalizeSites(payload), total: pageTotal(payload?.page) ?? rows(payload).length }
      },
      async databases() {
        const payload = await callOn('data', 'getData', { table: 'databases', p: 1, limit: 200 })
        return { items: normalizeDatabases(payload), total: pageTotal(payload?.page) ?? rows(payload).length }
      },
      async logs(limit = 50) {
        const payload = await callOn('data', 'getData', { table: 'logs', p: 1, limit })
        return { items: normalizeLogs(payload), total: pageTotal(payload?.page) ?? rows(payload).length }
      },
      async services() {
        return normalizeServices(await callOn('system', 'GetConcifInfo'))
      },
      restartService: (serviceName) => callOn('system', 'ServiceAdmin', { name: serviceName, type: 'restart' }),
      siteAction: (action, params) => callOn('site', action, params),
      crontabList: async () => normalizeCrontab(await callOn('crontab', 'GetCrontab', { p: 1, limit: 200 })),
    }
  }

  /** Aggregated view for one panel; each source degrades on its own. */
  const overview = async (panelRef) => {
    const ops = panelOps(panelRef)
    const cacheKey = ops.panel.id
    const cached = overviewCaches.get(cacheKey)
    if (cached !== undefined && Date.now() - cached.at < 5000) return cached.value
    const settle = async (label, promise) => {
      try {
        return { ok: true, value: await promise }
      } catch (error) {
        return { ok: false, error: `${label}：${error instanceof Error ? error.message : String(error)}` }
      }
    }
    const [system, disk, sites, databases, services, load, network, conf] = await Promise.all([
      settle('系统状态', ops.system()),
      settle('磁盘', ops.disk()),
      settle('网站', ops.sites()),
      settle('数据库', ops.databases()),
      settle('服务', ops.services()),
      settle('负载', ops.load()),
      settle('网络', ops.network()),
      settle('面板信息', ops.conf()),
    ])
    const sys = system.ok ? system.value : undefined
    const disks = (disk.ok && Array.isArray(disk.value) ? disk.value : []).map((row) => {
      const size = Array.isArray(row.size) ? row.size : []
      return {
        path: row.path ?? '/',
        filesystem: row.filesystem ?? '',
        total: num(row.byte_size?.[0]) ?? 0,
        used: num(row.byte_size?.[1]) ?? 0,
        available: num(row.byte_size?.[2]) ?? 0,
        usedPercent: num(size[3]) ?? percent(row.byte_size?.[1], row.byte_size?.[0]) ?? 0,
        totalLabel: size[0] ?? '',
        usedLabel: size[1] ?? '',
      }
    })
    const eth = network.ok ? network.value?.network?.eth0 ?? Object.values(network.value?.network ?? {})[0] : undefined
    const value = {
      ok: system.ok || disk.ok || sites.ok,
      panel: { id: ops.panel.id, name: ops.panel.name, host: describePanel(ops.panel).panelHost },
      crawledAt: new Date().toISOString(),
      system: sys === undefined
        ? undefined
        : {
            cpuNum: num(sys.cpuNum),
            cpuUsedPercent: num(sys.cpuRealUsed),
            memTotal: num(sys.memTotal),
            memUsed: num(sys.memRealUsed),
            memUsedPercent: percent(sys.memRealUsed, sys.memTotal),
            memTotalLabel: sys.memNewTotal ?? '',
            memUsedLabel: sys.memNewRealUsed ?? '',
            system: sys.system ?? '',
            version: sys.version ?? '',
          },
      load: load.ok
        ? { one: num(load.value?.one), five: num(load.value?.five), fifteen: num(load.value?.fifteen), limit: num(load.value?.limit) }
        : undefined,
      network: eth === undefined ? undefined : { up: num(eth.up), down: num(eth.down), upTotal: num(eth.upTotal), downTotal: num(eth.downTotal) },
      stack: conf.ok
        ? { webserver: conf.value?.webserver ?? '', sitesPath: conf.value?.sites_path ?? '', backupPath: conf.value?.backup_path ?? '' }
        : undefined,
      disks,
      sites: sites.ok
        ? {
            total: sites.value.total,
            running: sites.value.items.filter((site) => site.status).length,
            items: sites.value.items.slice(0, 12),
          }
        : { error: sites.error, total: 0, running: 0, items: [] },
      databases: databases.ok
        ? { total: databases.value.total, items: databases.value.items.slice(0, 12) }
        : { error: databases.error, total: 0, items: [] },
      services: services.ok ? services.value : [],
      errors: [system, disk, sites, databases, services, load, network, conf]
        .filter((entry) => !entry.ok)
        .map((entry) => entry.error),
    }
    overviewCaches.set(cacheKey, { at: Date.now(), value })
    return value
  }

  /* ---------------- configuration writes ---------------- */

  const describeConfig = () => {
    const active = activeOf()
    return {
      panels: config.panels.map(describePanel),
      activePanel: active === undefined ? '' : active.id,
      showInSidebar: config.showInSidebar,
      configured: config.panels.some((panel) => describePanel(panel).configured),
    }
  }

  /** Apply a mutation, persist it, and return the new config description. */
  const mutate = (change) => {
    const next = change({
      panels: config.panels.map((panel) => ({ ...panel })),
      activePanel: config.activePanel,
      showInSidebar: config.showInSidebar,
    })
    config.panels = next.panels
    config.activePanel = next.activePanel
    config.showInSidebar = next.showInSidebar
    if (config.activePanel === '' || !config.panels.some((panel) => panel.id === config.activePanel)) {
      config.activePanel = config.panels[0]?.id ?? ''
    }
    try {
      writeState({ panels: config.panels, activePanel: config.activePanel, showInSidebar: config.showInSidebar })
    } catch (error) {
      return { ok: false, error: `状态写入失败：${error instanceof Error ? error.message : String(error)}`, config: describeConfig() }
    }
    overviewCaches.clear()
    clients.clear()
    return { ok: true, config: describeConfig() }
  }

  const nextPanelId = (name, panelUrl) => {
    const base = slug(name !== '' ? name : panelUrl, 'panel')
    let candidate = base
    let index = 2
    while (config.panels.some((panel) => panel.id === candidate)) {
      candidate = `${base}-${index}`
      index += 1
    }
    return candidate
  }

  const addPanel = (input) =>
    mutate((current) => {
      const id = nextPanelId(String(input.name ?? ''), String(input.panelUrl ?? ''))
      current.panels.push({
        id,
        name: String(input.name ?? '').trim() || String(input.panelUrl ?? '').trim(),
        panelUrl: String(input.panelUrl ?? '').trim().replace(/\/+$/, ''),
        apiKey: String(input.apiKey ?? '').trim(),
        securityEntrance: String(input.securityEntrance ?? '').trim(),
        verifyTls: input.verifyTls === true,
      })
      if (current.activePanel === '') current.activePanel = id
      return current
    })

  const updatePanel = (id, patch) =>
    mutate((current) => {
      current.panels = current.panels.map((panel) =>
        panel.id === id
          ? {
              ...panel,
              name: typeof patch.name === 'string' ? patch.name.trim() || panel.panelUrl : panel.name,
              panelUrl: typeof patch.panelUrl === 'string' ? patch.panelUrl.trim().replace(/\/+$/, '') : panel.panelUrl,
              apiKey: typeof patch.apiKey === 'string' && patch.apiKey.trim() !== '' ? patch.apiKey.trim() : panel.apiKey,
              securityEntrance: typeof patch.securityEntrance === 'string' ? patch.securityEntrance.trim() : panel.securityEntrance,
              verifyTls: typeof patch.verifyTls === 'boolean' ? patch.verifyTls : panel.verifyTls,
            }
          : panel,
      )
      return current
    })

  const removePanel = (id) =>
    mutate((current) => {
      current.panels = current.panels.filter((panel) => panel.id !== id)
      if (current.activePanel === id) current.activePanel = current.panels[0]?.id ?? ''
      return current
    })

  const activatePanel = (id) =>
    mutate((current) => {
      if (current.panels.some((panel) => panel.id === id)) current.activePanel = id
      return current
    })

  const setShowInSidebar = (value) =>
    mutate((current) => {
      current.showInSidebar = value === true
      return current
    })

  /* ---------------- Browser-facing Remote service ---------------- */

  ctx.inject(['typert'], (typertCtx) => {
    /** Temporary trace: Remote calls land in the DSH host log for diagnosis. */
    const trace = (name, detail) => {
      try {
        console.log(`[dsh-baota] remote ${name} ${detail}`)
      } catch {
        // logging must never break a call
      }
    }
    const service = {
      config: async () => describeConfig(),
      overview: async (panel) => overview(optionalString(panel)),
      sites: async (panel) => panelOps(optionalString(panel)).sites(),
      databases: async (panel) => panelOps(optionalString(panel)).databases(),
      services: async (panel) => ({ items: await panelOps(optionalString(panel)).services() }),
      refresh: async () => {
        overviewCaches.clear()
        return describeConfig()
      },
      addPanel: async (input) => {
        if (input === null || typeof input !== 'object') throw new Error('Expected a panel object')
        const result = addPanel(input)
        return result.ok ? { ...result, panelId: result.config.activePanel } : result
      },
      updatePanel: async (request) => {
        if (request === null || typeof request !== 'object' || typeof request.id !== 'string') {
          throw new Error('Expected { id, patch }')
        }
        return updatePanel(request.id, request.patch !== null && typeof request.patch === 'object' ? request.patch : {})
      },
      removePanel: async (id) => removePanel(optionalString(id) ?? ''),
      activatePanel: async (id) => activatePanel(optionalString(id) ?? ''),
      setShowInSidebar: async (value) => setShowInSidebar(value === true),
      trace: async (message) => {
        console.log(`[dsh-baota:client] ${String(message).slice(0, 500)}`)
        return { ok: true }
      },
    }
    for (const [methodName, method] of Object.entries(service)) {
      if (typeof method !== 'function') continue
      service[methodName] = async (...args) => {
        trace(methodName, JSON.stringify(args ?? []).slice(0, 400))
        try {
          const value = await method(...args)
          trace(`${methodName} ->`, JSON.stringify(value ?? null).slice(0, 400))
          return value
        } catch (error) {
          trace(`${methodName} !!`, error instanceof Error ? error.message : String(error))
          throw error
        }
      }
    }
    // The Gateway resolves a Service through this visible binding; without it a
    // Remote call that is not claimed by a strict generated descriptor fails with
    // `Service "baota" has no visible typertRemote binding`.
    service.typertRemote = Object.freeze({ service, serviceKey: 'baota', namespace: 'baota' })
    typertCtx.provide('baota', service)
    typertCtx.typert.register({
      package: 'dsh-baota-panel',
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: BAOTA_DESCRIPTORS,
    })
  })

  /* ----------------------- Agent tools --------------------------- */

  const detail = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  const asResult = () => ({ schema: { type: 'json' }, render: (_args, output) => detail(output) })
  const jsonSafe = (value) => JSON.parse(JSON.stringify(value ?? null))

  /** The id the last addPanel created, for the diagnostic round trip. */
  const createdPanelId = (result) => {
    const panels = Array.isArray(result?.config?.panels) ? result.config.panels : []
    const probe = panels.find((panel) => panel.name.startsWith('__selftest'))
    return probe === undefined ? '' : probe.id
  }

  const tool = (options) =>
    ctx.tools.register(
      defineTool({
        ...options,
        async execute(args, exec) {
          return jsonSafe(await options.execute(args, exec))
        },
        output: asResult(),
      }),
    )

  const panelParam = { type: 'string', description: '面板 id 或名称；留空使用当前面板（bt_panels 可列出）。' }

  tool({
    name: 'bt_panels',
    description: 'List the Baota panels this plugin is configured for: id, name, host, and whether the address and API key are set.',
    parameters: {},
    async execute() {
      const active = activeOf()
      return { ok: true, activePanel: active === undefined ? '' : active.id, panels: config.panels.map(describePanel) }
    },
  })

  tool({
    name: 'bt_system',
    description:
      'Read one Baota panel host status: CPU/memory totals, disk usage, load average, network traffic, or the installed software stack. Call it before recommending any cleanup or restart.',
    parameters: {
      action: { type: 'string', required: true, description: 'overview (default summary), disk, load, network, panel (webserver, paths, installed software), or raw.' },
      panel: panelParam,
    },
    async execute(args) {
      const ops = panelOps(args.panel)
      switch (args.action) {
        case 'disk':
          return { ok: true, action: 'disk', panel: ops.panel.id, disk: await ops.disk() }
        case 'load':
          return { ok: true, action: 'load', panel: ops.panel.id, load: await ops.load() }
        case 'network':
          return { ok: true, action: 'network', panel: ops.panel.id, network: await ops.network() }
        case 'panel':
          return { ok: true, action: 'panel', panel: ops.panel.id, panelInfo: await ops.conf(), services: await ops.services() }
        case 'raw':
          return { ok: true, action: 'raw', panel: ops.panel.id, system: await ops.system() }
        default: {
          const summary = await overview(args.panel)
          return { ok: summary.ok, action: 'overview', panel: summary.panel, summary }
        }
      }
    },
  })

  tool({
    name: 'bt_site',
    description:
      'Websites on one Baota panel: list, add, start, stop, delete, read access logs, read/switch the PHP version, list/add/remove domains, inspect or close SSL, toggle forced HTTPS, list rewrite templates, and create/list backups. Deleting a site removes its record and web server configuration, so confirm the exact name first.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description:
          'list | add | start | stop | delete | logs | php | php-set | domains | domain-add | domain-delete | ssl | ssl-close | https | rewrite | backup | backups',
      },
      id: { type: 'string', description: 'Site id from bt_site list.' },
      name: { type: 'string', description: 'Site name (webname): required for logs, php, php-set, domains, ssl, domain-delete, backup.' },
      path: { type: 'string', description: 'For add: site root, for example /www/wwwroot/example.com' },
      phpVersion: { type: 'string', description: 'For add/php-set: PHP version such as 82 or 00 for static.' },
      ps: { type: 'string', description: 'For add: remark.' },
      domain: { type: 'string', description: 'For domain-add: the domain to bind.' },
      domainId: { type: 'string', description: 'For domain-delete: the domain row id from bt_site domains.' },
      port: { type: 'string', description: 'For domain-delete: the domain port, usually 80.' },
      on: { type: 'boolean', description: 'For https: true forces HTTPS, false closes it.' },
      limit: { type: 'integer', description: 'For logs: how many recent lines (default 200).' },
      panel: panelParam,
    },
    async execute(args) {
      const ops = panelOps(args.panel)
      const panelId = ops.panel.id
      const siteName = args.name
      const needName = () => {
        if (!siteName) throw new Error(`${args.action} 需要站点名 name`)
        return siteName
      }
      switch (args.action) {
        case 'list':
          return { ok: true, panel: panelId, ...(await ops.sites()) }
        case 'logs': {
          const name = needName()
          const limit = Number.isFinite(args.limit) ? Math.min(Math.max(args.limit, 10), 2000) : 200
          const payload = await ops.siteAction('GetSiteLogs', { siteName: name, limit })
          const text = typeof payload?.msg === 'string' ? payload.msg : ''
          const lines = text.split(/\r?\n/).filter((line) => line !== '')
          const tail = lines.slice(-limit).join('\n')
          const clipped = tail.length > MAX_LOG_CHARS ? tail.slice(-MAX_LOG_CHARS) : tail
          return {
            ok: payload?.status !== false,
            panel: panelId,
            site: name,
            returnedLines: lines.slice(-limit).length,
            totalLines: lines.length,
            truncated: lines.length > limit || tail.length > MAX_LOG_CHARS,
            log: clipped,
          }
        }
        case 'add': {
          if (!args.name) throw new Error('add 需要站点名 name')
          if (!args.path) throw new Error('add 需要站点目录 path')
          const payload = await ops.siteAction('AddSite', {
            webname: args.name,
            path: args.path,
            type: 'PHP',
            type_id: '0',
            version: args.phpVersion ?? '00',
            ps: args.ps ?? '',
            ftp: 'false',
            sql: 'false',
          })
          return { ok: payload?.status !== false, panel: panelId, result: stripSecrets(payload) }
        }
        case 'start':
        case 'stop': {
          if (!args.id) throw new Error(`${args.action} 需要站点 id`)
          const payload = await ops.siteAction(args.action === 'start' ? 'SiteStart' : 'SiteStop', { id: args.id })
          return { ok: payload?.status !== false, panel: panelId, result: payload }
        }
        case 'delete': {
          if (!args.id) throw new Error('delete 需要站点 id')
          if (!args.name) throw new Error('delete 需要站点名 name（webname）')
          const payload = await ops.siteAction('DeleteSite', { id: args.id, webname: args.name })
          return { ok: payload?.status !== false, panel: panelId, result: payload }
        }
        case 'php': {
          const name = needName()
          const current = await ops.siteAction('GetSitePHPVersion', { siteName: name })
          const versions = await ops.siteAction('GetPHPVersion', {})
          return { ok: true, panel: panelId, site: name, current, available: versions }
        }
        case 'php-set': {
          const name = needName()
          if (!args.phpVersion) throw new Error('php-set 需要 phpVersion，例如 82')
          const payload = await ops.siteAction('SetPHPVersion', { siteName: name, version: args.phpVersion })
          return { ok: payload?.status !== false, panel: panelId, result: payload }
        }
        case 'domains': {
          const name = needName()
          const site = (await ops.sites()).items.find((item) => item.name === name)
          if (site === undefined || site.id === undefined) throw new Error(`未找到站点 ${name}`)
          const payload = await ops.siteAction('GetSiteDomains', { id: site.id })
          return { ok: true, panel: panelId, site: name, domains: stripSecrets(payload?.domains ?? []) }
        }
        case 'domain-add': {
          const name = needName()
          if (!args.domain) throw new Error('domain-add 需要 domain')
          const payload = await ops.siteAction('AddDomain', { webname: name, domain: args.domain, port: args.port ?? '80' })
          return { ok: payload?.status !== false, panel: panelId, result: payload }
        }
        case 'domain-delete': {
          const name = needName()
          if (!args.domainId) throw new Error('domain-delete 需要 domainId（先从 bt_site domains 取）')
          const payload = await ops.siteAction('DelDomain', {
            id: args.domainId,
            domain: args.domain ?? '',
            port: args.port ?? '80',
          })
          return { ok: payload?.status !== false, panel: panelId, result: payload }
        }
        case 'ssl': {
          const name = needName()
          const payload = await ops.siteAction('GetSSL', { siteName: name })
          return {
            ok: true,
            panel: panelId,
            site: name,
            enabled: payload?.status === true || payload?.status === 1 || payload?.status === '1',
            domains: (payload?.domain ?? []).map((item) => item?.name ?? item),
            notAfter: payload?.notAfter ?? payload?.end_time ?? undefined,
            // the certificate, key and csr are deliberately dropped
          }
        }
        case 'ssl-close': {
          const name = needName()
          const payload = await ops.siteAction('CloseSSLConf', { siteName: name })
          return { ok: payload?.status !== false, panel: panelId, result: payload }
        }
        case 'https': {
          const name = needName()
          const payload = await ops.siteAction(args.on === false ? 'CloseToHttps' : 'HttpToHttps', { siteName: name })
          return { ok: payload?.status !== false, panel: panelId, site: name, forced: args.on !== false, result: payload }
        }
        case 'rewrite': {
          const name = needName()
          const payload = await ops.siteAction('GetRewriteList', { siteName: name })
          return { ok: true, panel: panelId, site: name, templates: payload?.rewrite ?? payload }
        }
        case 'backup': {
          const site = args.id === undefined
            ? (await ops.sites()).items.find((item) => item.name === siteName)
            : { id: args.id }
          if (site?.id === undefined) throw new Error('backup 需要站点 id 或 name')
          const payload = await ops.siteAction('ToBackup', { id: site.id })
          return { ok: payload?.status !== false, panel: panelId, result: payload }
        }
        case 'backups': {
          const payload = await ops.call('data', 'getData', { table: 'backup', p: 1, limit: 20 })
          return {
            ok: true,
            panel: panelId,
            total: pageTotal(payload?.page) ?? rows(payload).length,
            items: rows(payload).map((row) => ({
              id: row.id ?? undefined,
              name: row.name ?? '',
              at: row.addtime ?? '',
              size: row.size ?? row.filename ?? '',
              type: row.type ?? '',
            })),
          }
        }
        default:
          throw new Error(`未知操作 ${args.action}`)
      }
    },
  })

  tool({
    name: 'bt_database',
    description:
      'Databases on one Baota panel: list, create, delete, reset a password, or create a backup. Deleting a database drops it and resetting a password breaks existing clients, so confirm with the user first.',
    parameters: {
      action: { type: 'string', required: true, description: 'list | add | delete | password | backup' },
      name: { type: 'string', description: 'Database name.' },
      username: { type: 'string', description: 'For add: database user (defaults to the database name).' },
      password: { type: 'string', description: 'For add/password: the account password.' },
      id: { type: 'string', description: 'Database id from bt_database list.' },
      ps: { type: 'string', description: 'For add: remark.' },
      panel: panelParam,
    },
    async execute(args) {
      const ops = panelOps(args.panel)
      const panelId = ops.panel.id
      const need = (field, label) => {
        if (!args[field]) throw new Error(`${args.action} 需要 ${label}`)
        return args[field]
      }
      switch (args.action) {
        case 'list':
          return { ok: true, panel: panelId, ...(await ops.databases()) }
        case 'add': {
          const name = need('name', '数据库名 name')
          const payload = await ops.call('database', 'AddDatabase', {
            name,
            codeing: 'utf8mb4',
            db_user: args.username ?? name,
            password: args.password ?? '',
            ps: args.ps ?? '',
            sid: '0',
            type: 'MySQL',
          })
          return { ok: payload?.status !== false, panel: panelId, result: stripSecrets(payload) }
        }
        case 'delete': {
          const name = need('name', '数据库名 name')
          const payload = await ops.call('database', 'DeleteDatabase', { name, id: args.id ?? '' })
          return { ok: payload?.status !== false, panel: panelId, result: payload }
        }
        case 'password': {
          const name = need('name', '数据库名 name')
          const password = need('password', '新密码 password')
          const database = (await ops.databases()).items.find((item) => item.name === name)
          const payload = await ops.call('database', 'ResDatabasePassword', {
            name: database?.username ?? name,
            data_name: name,
            id: args.id ?? database?.id ?? '',
            password,
          })
          return { ok: payload?.status !== false, panel: panelId, result: payload }
        }
        case 'backup': {
          const name = need('name', '数据库名 name')
          const database = (await ops.databases()).items.find((item) => item.name === name)
          const payload = await ops.call('database', 'ToBackup', { id: args.id ?? database?.id ?? '', name })
          return { ok: payload?.status !== false, panel: panelId, result: payload }
        }
        default:
          throw new Error(`未知操作 ${args.action}`)
      }
    },
  })

  tool({
    name: 'bt_ftp',
    description: 'FTP accounts on one Baota panel (requires Pure-FTPd): list, add, delete, reset password, or enable/disable an account.',
    parameters: {
      action: { type: 'string', required: true, description: 'list | add | delete | password | status' },
      username: { type: 'string', description: 'FTP user name.' },
      password: { type: 'string', description: 'FTP password.' },
      path: { type: 'string', description: 'For add: directory the account may use.' },
      ps: { type: 'string', description: 'Remark.' },
      id: { type: 'string', description: 'Row id from bt_ftp list.' },
      enabled: { type: 'boolean', description: 'For status: true enables, false disables.' },
      panel: panelParam,
    },
    async execute(args) {
      const ops = panelOps(args.panel)
      const panelId = ops.panel.id
      switch (args.action) {
        case 'list': {
          const payload = await ops.call('data', 'getData', { table: 'ftps', p: 1, limit: 100 })
          return {
            ok: true,
            panel: panelId,
            total: pageTotal(payload?.page) ?? rows(payload).length,
            items: rows(payload).map((row) => ({
              id: row.id ?? undefined,
              username: row.name ?? row.username ?? '',
              path: row.path ?? '',
              status: String(row.status) === '1',
              ps: row.ps ?? '',
            })),
          }
        }
        case 'add': {
          if (!args.username || !args.password) throw new Error('add 需要 username 与 password')
          const payload = await ops.call('ftp', 'AddUser', {
            ftp_username: args.username,
            ftp_password: args.password,
            path: args.path ?? '/www/wwwroot',
            ps: args.ps ?? '',
          })
          return { ok: payload?.status !== false, panel: panelId, result: stripSecrets(payload) }
        }
        case 'delete': {
          if (!args.username) throw new Error('delete 需要 username')
          const payload = await ops.call('ftp', 'DeleteUser', { username: args.username, id: args.id ?? '' })
          return { ok: payload?.status !== false, panel: panelId, result: payload }
        }
        case 'password': {
          if (!args.username || !args.password) throw new Error('password 需要 username 与 password')
          const payload = await ops.call('ftp', 'SetUserPassword', {
            username: args.username,
            new_password: args.password,
            id: args.id ?? '',
          })
          return { ok: payload?.status !== false, panel: panelId, result: payload }
        }
        case 'status': {
          if (!args.username) throw new Error('status 需要 username')
          const payload = await ops.call('ftp', 'SetStatus', {
            username: args.username,
            status: args.enabled === false ? '0' : '1',
            id: args.id ?? '',
          })
          return { ok: payload?.status !== false, panel: panelId, result: payload }
        }
        default:
          throw new Error(`未知操作 ${args.action}`)
      }
    },
  })

  tool({
    name: 'bt_file',
    description:
      'Browse and edit files on one panel server: list a directory, read a text file, write a text file, create a directory, or delete a path. Paths are absolute, for example /www/wwwroot/site/index.html.',
    parameters: {
      action: { type: 'string', required: true, description: 'list, read, write, mkdir, or delete.' },
      path: { type: 'string', required: true, description: 'Absolute path on the panel server.' },
      content: { type: 'string', description: 'File body for write.' },
      panel: panelParam,
    },
    async execute(args) {
      const panel = resolvePanel(args.panel)
      const onPanel = (moduleName, action, params) => clientFor(panel).call(moduleName, action, params)
      switch (args.action) {
        case 'list':
          return { ok: true, panel: panel.id, path: args.path, listing: await onPanel('files', 'GetDirNew', { path: args.path, p: 1, showRow: 200, limit: 200 }) }
        case 'read': {
          const payload = await onPanel('files', 'GetFileBody', { path: args.path })
          const text = typeof payload?.data === 'string' ? payload.data : ''
          const truncated = text.length > MAX_FILE_CHARS
          return {
            ok: true,
            panel: panel.id,
            path: args.path,
            size: payload?.size,
            encoding: payload?.encoding ?? 'utf-8',
            truncated,
            content: truncated ? text.slice(0, MAX_FILE_CHARS) : text,
          }
        }
        case 'write':
          return {
            ok: true,
            panel: panel.id,
            path: args.path,
            result: await onPanel('files', 'SaveFileBody', { path: args.path, data: args.content ?? '', encoding: 'utf-8' }),
          }
        case 'mkdir':
          return { ok: true, panel: panel.id, path: args.path, result: await onPanel('files', 'CreateDir', { path: args.path }) }
        case 'delete':
          return { ok: true, panel: panel.id, path: args.path, result: await onPanel('files', 'DeleteFile', { path: args.path }) }
        default:
          throw new Error(`未知操作 ${args.action}`)
      }
    },
  })

  tool({
    name: 'bt_crontab',
    description: 'List, add, or delete scheduled tasks (crontab) on one Baota panel.',
    parameters: {
      action: { type: 'string', required: true, description: 'list, add, or delete.' },
      id: { type: 'string', description: 'Task id from bt_crontab list (delete).' },
      name: { type: 'string', description: 'Task name (add).' },
      type: { type: 'string', description: 'Task type for add: day, hour, minute, week, or month (default day).' },
      where1: { type: 'string', description: 'Schedule expression, for example 3 for 03:00 in type=day.' },
      sBody: { type: 'string', description: 'Shell command or URL to run (add).' },
      sType: { type: 'string', description: 'Shell (default) or Url for add.' },
      panel: panelParam,
    },
    async execute(args) {
      const ops = panelOps(args.panel)
      if (args.action === 'list') return { ok: true, panel: ops.panel.id, crontab: await ops.crontabList() }
      if (args.action === 'delete') {
        if (!args.id) throw new Error('delete 需要任务 id')
        return { ok: true, panel: ops.panel.id, result: await call(args.panel, 'crontab', 'DelCrontab', { id: args.id }) }
      }
      if (args.action === 'add') {
        const result = await call(args.panel, 'crontab', 'AddCrontab', {
          name: args.name ?? 'dsh task',
          type: args.type ?? 'day',
          where1: args.where1 ?? '3',
          sType: args.sType ?? 'Shell',
          sBody: args.sBody ?? '',
          save: 1,
          backupTo: 'localhost',
        })
        return { ok: true, panel: ops.panel.id, result }
      }
      throw new Error(`未知操作 ${args.action}`)
    },
  })

  tool({
    name: 'bt_firewall',
    description:
      'Inspect or change firewall rules on one Baota panel: list current rules, open a TCP port, or close one. Some panel builds only serve these routes to a logged-in browser session; the panel message is returned unchanged in that case.',
    parameters: {
      action: { type: 'string', required: true, description: 'list, allow (open a port), or deny (close a port).' },
      port: { type: 'string', description: 'Port or range such as 8080 or 3000-3010.' },
      ps: { type: 'string', description: 'Rule remark.' },
      id: { type: 'string', description: 'Rule id from bt_firewall list (deny).' },
      panel: panelParam,
    },
    async execute(args) {
      const panel = resolvePanel(args.panel)
      if (args.action === 'list') {
        return { ok: true, panel: panel.id, rules: await clientFor(panel).call('firewall', 'GetList', { p: 1, limit: 200 }) }
      }
      if (args.action === 'allow') {
        if (!args.port) throw new Error('allow 需要端口号')
        return { ok: true, panel: panel.id, result: await clientFor(panel).call('firewall', 'AddAcceptPort', { port: args.port, ps: args.ps ?? 'dsh-baota-panel', type: 'accept' }) }
      }
      if (args.action === 'deny') {
        if (!args.port) throw new Error('deny 需要端口号')
        return { ok: true, panel: panel.id, result: await clientFor(panel).call('firewall', 'DelAcceptPort', { port: args.port, id: args.id ?? '', type: 'accept' }) }
      }
      throw new Error(`未知操作 ${args.action}`)
    },
  })

  tool({
    name: 'bt_service',
    description:
      'One panel\'s software stack (web server, MySQL, PHP) and its service controls: list, restart or reload a service, reload the panel web service, or free memory.',
    parameters: {
      action: { type: 'string', required: true, description: 'list | restart | reload | panel-reload | free-memory' },
      name: { type: 'string', description: 'Service name, for example nginx, mysql, or php-82.' },
      panel: panelParam,
    },
    async execute(args) {
      const ops = panelOps(args.panel)
      const panelId = ops.panel.id
      switch (args.action) {
        case 'list':
          return { ok: true, panel: panelId, services: await ops.services() }
        case 'restart':
        case 'reload': {
          if (!args.name) throw new Error(`${args.action} 需要服务名`)
          const name = String(args.name).startsWith('php-') ? 'php-fpm' : args.name
          return { ok: true, panel: panelId, service: name, action: args.action, result: await ops.restartService(name) }
        }
        case 'panel-reload':
          // Reloads the panel's own web service; sites keep running.
          return { ok: true, panel: panelId, result: await ops.call('system', 'ReWeb', { type: 'reload' }) }
        case 'free-memory':
          return { ok: true, panel: panelId, result: await ops.call('system', 'ReMemory', {}) }
        default:
          throw new Error(`未知操作 ${args.action}`)
      }
    },
  })

  tool({
    name: 'bt_logs',
    description: 'Read one panel\'s operation log (who did what, newest first) — useful for auditing recent changes.',
    parameters: {
      limit: { type: 'integer', description: 'How many entries to return; defaults to 30.' },
      panel: panelParam,
    },
    async execute(args) {
      const ops = panelOps(args.panel)
      const limit = Number.isFinite(args.limit) ? Math.min(Math.max(args.limit, 1), 200) : 30
      return { ok: true, panel: ops.panel.id, ...(await ops.logs(limit)) }
    },
  })

  tool({
    name: 'bt_config',
    description:
      'Manage the panels this plugin connects to and whether the sidebar entry shows. Actions: list, add, update, remove, activate, sidebar.',
    parameters: {
      action: { type: 'string', required: true, description: 'list, add, update, remove, activate, or sidebar.' },
      panel: { type: 'string', description: 'Panel id or name for update/remove/activate.' },
      name: { type: 'string', description: 'Display name for the panel.' },
      panelUrl: { type: 'string', description: 'Panel root address including the port, for example https://panel.example.com:4439' },
      apiKey: { type: 'string', description: '面板设置 → API 接口 → 接口密钥. Omit or leave empty to keep the stored key.' },
      securityEntrance: { type: 'string', description: 'Optional 安全入口, for example ghostxx' },
      verifyTls: { type: 'boolean', description: 'Verify the panel certificate; the panel is self-signed by default.' },
      showInSidebar: { type: 'boolean', description: 'Whether the 宝塔面板 entry appears in the sidebar panel list (sidebar action only).' },
    },
    async execute(args) {
      switch (args.action) {
        case 'list':
          return { ok: true, ...describeConfig() }
        case 'add': {
          if (!args.panelUrl) throw new Error('add 需要 panelUrl')
          const result = addPanel({
            name: args.name ?? '',
            panelUrl: args.panelUrl,
            apiKey: args.apiKey ?? '',
            securityEntrance: args.securityEntrance ?? '',
            verifyTls: args.verifyTls === true,
          })
          return { ...result, panelId: result.config?.panels?.at(-1)?.id }
        }
        case 'update': {
          const target = resolvePanel(args.panel)
          return updatePanel(target.id, {
            ...(args.name === undefined ? {} : { name: args.name }),
            ...(args.panelUrl === undefined ? {} : { panelUrl: args.panelUrl }),
            ...(args.apiKey === undefined ? {} : { apiKey: args.apiKey }),
            ...(args.securityEntrance === undefined ? {} : { securityEntrance: args.securityEntrance }),
            ...(args.verifyTls === undefined ? {} : { verifyTls: args.verifyTls }),
          })
        }
        case 'remove': {
          const target = resolvePanel(args.panel)
          return { ...removePanel(target.id), removed: target.id }
        }
        case 'activate': {
          const target = resolvePanel(args.panel)
          return { ...activatePanel(target.id), activePanel: target.id }
        }
        case 'sidebar': {
          if (typeof args.showInSidebar !== 'boolean') throw new Error('sidebar 需要 showInSidebar 布尔值')
          return setShowInSidebar(args.showInSidebar)
        }
        default:
          throw new Error(`未知操作 ${args.action}`)
      }
    },
  })

  tool({
    name: 'bt_selftest',
    description:
      'Diagnostic: invoke the baota Remote namespace through the typert gateway exactly as the browser half does (config, overview, write, or a full add/update/remove round trip).',
    parameters: {
      method: { type: 'string', required: true, description: 'config, overview, write, or roundtrip.' },
    },
    async execute(args) {
      const gateway = ctx.get('typertGateway')
      const connection = ctx.get('connection')
      if (gateway === undefined || connection === undefined) {
        throw new Error('typertGateway 或 connection 服务不可用')
      }
      const peer = connection.createPeer({ principal: { kind: 'owner' } })
      try {
        if (args.method === 'config') {
          return jsonSafe(await gateway.invoke({ namespace: 'baota', method: 'config', args: {}, peer }))
        }
        if (args.method === 'overview') {
          const active = activeOf()
          return jsonSafe(await gateway.invoke({ namespace: 'baota', method: 'overview', args: { panel: active === undefined ? '' : active.id }, peer }))
        }
        if (args.method === 'write') {
          return jsonSafe(
            await gateway.invoke({
              namespace: 'baota',
              method: 'setShowInSidebar',
              args: { value: config.showInSidebar },
              peer,
            }),
          )
        }
        if (args.method === 'roundtrip') {
          const added = await gateway.invoke({
            namespace: 'baota',
            method: 'addPanel',
            args: { panel: { name: '__selftest__', panelUrl: 'https://selftest.invalid:8888', apiKey: '' } },
            peer,
          })
          const created = createdPanelId(added)
          const updated = created === ''
            ? undefined
            : await gateway.invoke({
                namespace: 'baota',
                method: 'updatePanel',
                args: { request: { id: created, patch: { name: '__selftest_edited__', verifyTls: true } } },
                peer,
              })
          const removed = created === ''
            ? undefined
            : await gateway.invoke({ namespace: 'baota', method: 'removePanel', args: { id: created }, peer })
          return jsonSafe({ added: created, updated, removed })
        }
        throw new Error(`未知自检方法 ${args.method}`)
      } finally {
        await peer.dispose()
      }
    },
  })

  tool({
    name: 'bt_api',
    description:
      'Call any Baota panel API action directly when no other bt_* tool covers it. Example: module "site", action "GetSiteDomains", params {"id":1}. Use bt_system/bt_site/... first.',
    parameters: {
      module: { type: 'string', required: true, description: 'Panel module, for example system, site, database, files, crontab, firewall, config, data.' },
      action: { type: 'string', required: true, description: 'Panel action name, for example GetSystemTotal.' },
      params: { type: 'json', description: 'Extra form parameters as an object.' },
      panel: panelParam,
    },
    async execute(args) {
      const params = args.params !== null && typeof args.params === 'object' ? args.params : {}
      const panel = resolvePanel(args.panel)
      const data = await clientFor(panel).call(String(args.module).replace(/^\/+/, ''), String(args.action), params)
      return { ok: true, panel: panel.id, module: args.module, action: args.action, data }
    },
  })

  ctx.effect(() => () => {
    overviewCaches.clear()
    clients.clear()
  }, 'dsh-baota-panel: cache reset')

  return { remote: BAOTA_REMOTE }
}
