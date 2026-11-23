/**
 * Baota (bt.cn) Linux panel API client.
 *
 * The panel authenticates every API call with a time-based signature instead of
 * a login cookie:
 *
 *   request_time  = floor(Date.now() / 1000)
 *   request_token = md5(request_time + md5(apiKey))
 *
 * Both fields travel as form data. The address must include the security
 * entrance path (`.../ghostxx`), and the panel must accept this machine's public
 * IP in 面板设置 → API 接口 → IP 白名单.
 */
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

const md5 = (value) => crypto.createHash('md5').update(String(value), 'utf8').digest('hex')

/**
 * The panel rejects clients whose User-Agent does not look like a browser
 * (`public.is_spider()` aborts with 404), so the plugin presents a browser UA.
 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Panel modules whose payload is a raw file body rather than JSON. */
const RAW_MODULES = new Set(['download'])

export class PanelError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'PanelError'
    Object.assign(this, details)
  }
}

export class BaotaClient {
  constructor(options = {}) {
    this.baseUrl = String(options.panelUrl ?? '').trim().replace(/\/+$/, '')
    this.apiKey = String(options.apiKey ?? '').trim()
    this.verifyTls = options.verifyTls === true
    this.timeoutMs = Number.isFinite(options.requestTimeoutMs) ? options.requestTimeoutMs : 20000
    this.cookies = new Map()
    this.agentCache = new Map()
    // Some panel routes (firewall, logs) validate the security entrance through
    // the Referer path, so remember it when the operator configured one.
    const entrance = String(options.securityEntrance ?? '').trim().replace(/^\/+|\/+$/g, '')
    this.securityEntrance = entrance
  }

  get configured() {
    return this.baseUrl !== '' && this.apiKey !== ''
  }

  #agent(url) {
    const secure = url.protocol === 'https:'
    const key = `${secure ? 'https' : 'http'}:${this.verifyTls ? 'verify' : 'loose'}`
    let agent = this.agentCache.get(key)
    if (agent === undefined) {
      const Agent = secure ? https.Agent : http.Agent
      agent = new Agent({ keepAlive: true, maxSockets: 8, rejectUnauthorized: this.verifyTls })
      this.agentCache.set(key, agent)
    }
    return agent
  }

  #cookieHeader() {
    if (this.cookies.size === 0) return undefined
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  #absorbCookies(setCookie) {
    for (const line of setCookie ?? []) {
      const pair = String(line).split(';', 1)[0]
      const index = pair.indexOf('=')
      if (index <= 0) continue
      const name = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      if (name === '') continue
      if (value === '' || /expires=thu, 01 jan 1970/i.test(String(line))) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }

  #send(url, body, method) {
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(body, 'utf8')
      const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': String(payload.byteLength),
        'User-Agent': BROWSER_UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      }
      const cookie = this.#cookieHeader()
      if (cookie !== undefined) headers.Cookie = cookie
      headers.Referer = this.securityEntrance === ''
        ? `${url.origin}/`
        : `${url.origin}/${this.securityEntrance}/`
      const request = (url.protocol === 'https:' ? https : http).request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port === '' ? undefined : url.port,
          path: `${url.pathname}${url.search}`,
          method,
          headers,
          agent: this.#agent(url),
          timeout: this.timeoutMs,
        },
        (response) => {
          this.#absorbCookies(response.headers['set-cookie'])
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              text: Buffer.concat(chunks).toString('utf8'),
            })
          })
        },
      )
      request.on('timeout', () => request.destroy(new PanelError(`面板请求超时（${this.timeoutMs}ms）`)))
      request.on('error', (error) => {
        const code = error?.code ?? ''
        const hint = code === 'ECONNREFUSED'
          ? '：面板端口未开放或被防火墙拦截'
          : code === 'ENOTFOUND'
            ? '：面板地址域名无法解析'
            : code === 'CERT_HAS_EXPIRED' || String(error?.message ?? '').includes('certificate')
              ? '：面板证书校验失败，可在设置中关闭证书校验'
              : ''
        reject(new PanelError(`无法连接宝塔面板（${url.origin}）：${error?.message ?? error}${hint}`, { cause: error }))
      })
      request.end(payload)
    })
  }

  /** Escape hatch for callers that need the untouched body. */
  async raw(moduleName, action, params = {}) {
    if (!this.configured) throw new PanelError('面板地址或接口密钥尚未配置')
    const now = Math.floor(Date.now() / 1000)
    const body = new URLSearchParams()
    body.set('request_time', String(now))
    body.set('request_token', md5(String(now) + md5(this.apiKey)))
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue
      body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
    }
    const url = new URL(`${this.baseUrl}/${String(moduleName).replace(/^\/+/, '')}`)
    url.searchParams.set('action', action)
    const response = await this.#send(url, body.toString(), 'POST')
    if (response.status === 401 || response.status === 403) {
      throw new PanelError(
        `面板拒绝了请求（HTTP ${response.status}）。常见原因：安全入口路径不正确，或该路径不是面板域名访问入口`,
        { status: response.status },
      )
    }
    if (response.status >= 400 && !RAW_MODULES.has(moduleName)) {
      throw new PanelError(`面板返回 HTTP ${response.status}：${response.text.slice(0, 200)}`, { status: response.status })
    }
    return response.text
  }

  /** Call one panel API action and return its decoded JSON envelope. */
  async call(moduleName, action, params = {}) {
    const text = await this.raw(moduleName, action, params)
    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw new PanelError(`面板返回了非 JSON 内容：${text.slice(0, 200)}`)
    }
    if (data && typeof data === 'object' && data.status === false) {
      throw new PanelError(explainPanelMessage(String(data.msg ?? '未知错误')), { payload: data })
    }
    return data
  }

  /** Try several actions in order and return the first accepted one. */
  async callFirst(candidates) {
    let lastError
    for (const candidate of candidates) {
      try {
        const [moduleName, action, params] = candidate
        return { module: moduleName, action, data: await this.call(moduleName, action, params ?? {}) }
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new PanelError('没有可用的面板接口')
  }
}

/** Turn the panel's Chinese failure messages into actionable text. */
function explainPanelMessage(message) {
  if (message.includes('IP校验失败')) {
    return `${message}。请在面板「设置 → 面板设置 → API接口 → IP白名单」加入该 IP，或填 * 允许全部 IP`
  }
  if (message.includes('密钥校验失败')) {
    return `${message}。接口密钥应填写面板「API接口配置」里显示的接口密钥`
  }
  if (message.includes('连续20次验证失败')) {
    return `${message}。请等待一小时后重试，或重启面板解除限制`
  }
  return message
}
