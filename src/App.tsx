import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import DiagnosisChat, { type DiagnosisContext } from './DiagnosisChat'
import './App.css'

const APP_VERSION = '0.1.0'
const SPEEDTEST = 'https://www.speedtest.net/'
const USTC = 'https://test.ustc.edu.cn/'

type DiagState = 'idle' | 'running' | 'done'
type View = 'home' | 'advice' | 'plan'

interface WifiLink {
  connected: boolean
  rssi: number
  noise: number
  channel: number
  band: string
  tx_rate: number
}

interface NetworkInfo {
  wifi: WifiLink
  wired_connected: boolean
  interface: string
  ip: string
  gateway: string
  subnet_mask: string
  dns: string[]
  mac: string
  hardware_port: string
  wifi_name: string
}

interface CheckResult {
  name: string
  status: string
  value: string
  detail: string
}

interface AppLatency {
  name: string
  latency_ms: number
  status: string
}

interface DiagResult {
  overall: string
  checks: CheckResult[]
  app_latencies: AppLatency[]
  gateway_ping_ms: number
  gateway_loss: number
  external_ping_ms: number
  external_loss: number
  dns_ms: number
  ip_conflicts: { ip: string; macs: string[] }[]
  rogue_devices: { ip: string; mac: string; vendor: string; confidence: number }[]
}

interface ExitInfo {
  ip: string
  region: string
  city: string
  isp: string
  overseas: boolean
}

interface ProxyInsight {
  enabled: boolean
  mode: string
  service: string
  port: number
  address: string
  kind: string
  listening: boolean
  latency_ms: number
  process_name: string
  connection_count: number
  proxy_exit: ExitInfo
  direct_exit: ExitInfo
}

interface LatencyPoint {
  time: string
  gateway: number
  external: number
}

interface PingOnceResult {
  gateway_ms: number
  external_ms: number
  gateway_loss: number
  external_loss: number
}

const PREVIEW_NET: NetworkInfo = {
  wifi: { connected: true, rssi: -59, noise: -90, channel: 36, band: '5GHz', tx_rate: 1_200_000_000 },
  wired_connected: false,
  interface: 'en0',
  ip: '192.168.124.22',
  gateway: '192.168.124.1',
  subnet_mask: '255.255.255.0',
  dns: ['192.168.124.1'],
  mac: 'CE-73-B1-C0-16-07',
  hardware_port: 'Wi-Fi',
  wifi_name: '',
}

const PREVIEW_DIAG: DiagResult = {
  overall: 'ok',
  checks: [
    { name: '网关连通', status: 'ok', value: '6ms', detail: '192.168.124.1' },
    { name: '外网连通', status: 'ok', value: '316ms', detail: 'https://www.baidu.com' },
    { name: 'DNS 解析', status: 'ok', value: '正常', detail: '192.168.124.1' },
    { name: 'IP 配置', status: 'ok', value: '正常', detail: '192.168.124.22' },
    { name: '代理服务', status: 'ok', value: '正常', detail: '127.0.0.1:7897' },
    { name: '网页重定向', status: 'ok', value: '正常', detail: '重定向 0 次' },
  ],
  app_latencies: [
    { name: '百度', latency_ms: 180, status: 'ok' },
    { name: '淘宝', latency_ms: 210, status: 'ok' },
    { name: '腾讯', latency_ms: 160, status: 'ok' },
    { name: 'Google', latency_ms: 0, status: 'error' },
  ],
  gateway_ping_ms: 6,
  gateway_loss: 0,
  external_ping_ms: 78,
  external_loss: 0,
  dns_ms: 4,
  ip_conflicts: [],
  rogue_devices: [],
}

const PREVIEW_PROXY: ProxyInsight = {
  enabled: true,
  mode: '规则模式',
  service: 'Clash / Mihomo',
  port: 7897,
  address: '127.0.0.1:7897',
  kind: 'http',
  listening: true,
  latency_ms: 1,
  process_name: 'verge-mihomo',
  connection_count: 5,
  proxy_exit: { ip: '61.18.128.11', region: 'GB（英国）', city: '伦敦', isp: 'Example Net', overseas: true },
  direct_exit: { ip: '110.244.182.129', region: 'CN（中国）', city: '北京', isp: 'CHINA169-Backbone', overseas: false },
}

function previewSeries(): LatencyPoint[] {
  const pts: LatencyPoint[] = []
  for (let i = 0; i < 36; i++) {
    const spike = i === 5 ? 86 : 0
    pts.push({
      time: '',
      gateway: Math.max(2, 5 + spike * 0.4 + Math.sin(i / 3) * 1.5),
      external: 72 + Math.sin(i / 2.4) * 10 + (i === 5 ? 18 : 0),
    })
  }
  return pts
}

function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function nowTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

function checkOf(diag: DiagResult | null, name: string) {
  return diag?.checks.find((c) => c.name === name)
}

function statusWord(overall: string | undefined, running: boolean) {
  if (running) return '检测中'
  if (overall === 'ok') return '网络正常'
  if (overall === 'warning') return '需要留意'
  if (overall === 'error') return '网络异常'
  return '等待体检'
}

function bannerCopy(diag: DiagResult | null, running: boolean) {
  if (running) return { title: '正在体检…', desc: '正在检查网关、外网、DNS 和网页访问。' }
  if (!diag) return { title: '等待体检', desc: '点右上角「重新体检」，检查当前网络能不能正常用。' }
  if (diag.overall === 'ok') return { title: '网络连接正常', desc: '网关、外网与 DNS 均正常，网络可放心使用。' }
  if (diag.overall === 'warning') return { title: '发现潜在问题', desc: '部分检查项偏离正常范围，上网可能受影响。' }
  return { title: '发现网络故障', desc: '有检查项没有通过。打开「建议方案」可以看处理步骤。' }
}

const PENDING_CHECKS: CheckResult[] = [
  { name: '网关连通', status: 'pending', value: '--', detail: '' },
  { name: '外网连通', status: 'pending', value: '--', detail: '' },
  { name: 'DNS 解析', status: 'pending', value: '--', detail: '' },
  { name: 'IP 配置', status: 'pending', value: '--', detail: '' },
  { name: '代理服务', status: 'pending', value: '--', detail: '' },
  { name: '网页重定向', status: 'pending', value: '--', detail: '' },
]

const PENDING_APPS: AppLatency[] = ['百度', '淘宝', '腾讯', 'Google'].map((name) => ({
  name,
  latency_ms: 0,
  status: 'pending',
}))

function WifiGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M5 12.5a8 8 0 0114 0" />
      <path d="M8.5 16a4 4 0 017 0" />
      <circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

function EthGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="7" width="18" height="10" rx="1.5" />
      <path d="M7 12h2M11 12h2M15 12h2" />
    </svg>
  )
}

function Mark({ status }: { status: string }) {
  const cls = status === 'ok' ? 'mark mark--ok' : status === 'warning' ? 'mark mark--warn' : status === 'error' ? 'mark mark--err' : 'mark mark--pend'
  return (
    <span className={cls} aria-hidden>
      {status === 'ok' && (
        <svg viewBox="0 0 16 16" width="12" height="12"><path d="M3.5 8.2l2.8 2.8 6.2-6.4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
      )}
      {status === 'warning' && <span>!</span>}
      {status === 'error' && <span>×</span>}
    </span>
  )
}

function Tag({ status, children }: { status?: string; children: string }) {
  const cls = status === 'error' ? 'tag tag--err' : status === 'warning' ? 'tag tag--warn' : status === 'ok' ? 'tag tag--ok' : 'tag'
  return <span className={cls}>{children}</span>
}

function niceMax(values: number[]) {
  const peak = Math.max(10, ...values.filter((v) => v > 0))
  const step = peak > 200 ? 50 : peak > 80 ? 20 : 10
  return Math.ceil(peak / step) * step
}

function LatencyChart({ data }: { data: LatencyPoint[] }) {
  const w = 560
  const h = 150
  const padL = 34
  const padR = 38
  const padT = 8
  const padB = 6
  const innerW = w - padL - padR
  const innerH = h - padT - padB
  const gwMax = niceMax(data.map((d) => d.gateway))
  const extMax = niceMax(data.map((d) => d.external))

  function x(i: number) {
    if (data.length <= 1) return padL
    return padL + (i / (data.length - 1)) * innerW
  }
  function y(v: number, max: number) {
    return padT + innerH - (Math.max(0, v) / max) * innerH
  }
  function path(key: 'gateway' | 'external', max: number) {
    return data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d[key], max).toFixed(1)}`).join(' ')
  }

  const ticks = [1, 0.66, 0.33, 0]
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="chart" role="img" aria-label="最近一分钟的内网和外网延迟">
      {ticks.map((t) => {
        const yy = padT + innerH * (1 - t)
        return (
          <g key={t}>
            <line x1={padL} y1={yy} x2={w - padR} y2={yy} className="chart__grid" />
            <text x={padL - 6} y={yy + 3} className="chart__tick chart__tick--l" textAnchor="end">{Math.round(gwMax * t)}</text>
            <text x={w - padR + 6} y={yy + 3} className="chart__tick chart__tick--r">{Math.round(extMax * t)}</text>
          </g>
        )
      })}
      {data.length >= 2 && (
        <>
          <path d={path('external', extMax)} className="chart__line chart__line--ext" />
          <path d={path('gateway', gwMax)} className="chart__line chart__line--gw" />
        </>
      )}
    </svg>
  )
}

function LinkCard({ on, kind, title, state, ip }: { on: boolean; kind: 'wifi' | 'eth'; title: string; state: string; ip?: string }) {
  return (
    <div className={`link-card ${on ? 'link-card--on' : ''}`}>
      <div className="link-card__head">
        <span className={`link-card__icon ${on ? 'is-on' : ''}`}>{kind === 'wifi' ? <WifiGlyph /> : <EthGlyph />}</span>
        <span className="link-card__title">{title}</span>
        <i className={`dot ${on ? 'dot--on' : 'dot--off'}`} />
      </div>
      <div className={`link-card__state ${on ? 'is-on' : ''}`}>{state}</div>
      <div className="link-card__ip">{ip ? `IP ${ip}` : ''}</div>
    </div>
  )
}

function ExitBlock({ title, exit }: { title: string; exit: ExitInfo }) {
  if (!exit.ip) return null
  return (
    <div className="exit">
      <div className="exit__title">{title}</div>
      <div className="kv"><span>出口 IP</span><b>{exit.ip}</b></div>
      <div className="kv"><span>出口地区</span><b>{exit.region || '--'}</b></div>
      <div className="kv"><span>所在城市</span><b>{exit.city || '--'}</b></div>
      <div className="kv"><span>网络运营商</span><b>{exit.isp || '--'}</b></div>
    </div>
  )
}

function planItems(diag: DiagResult | null) {
  if (!diag) return [{ title: '先做一次体检', steps: ['回到首页，等快速体检结束，再看针对这次结果的步骤。'] }]
  const failed = diag.checks.filter((c) => c.status === 'error' || c.status === 'warning')
  const steps: { title: string; steps: string[] }[] = []
  for (const c of failed) {
    if (c.name === '网关连通') {
      steps.push({ title: '恢复到路由器的连接', steps: ['确认 Wi-Fi 已连接，或网线两端都插紧。', '重启路由器，等大约 30 秒后再试。', '开关一次无线，让电脑重新关联。'] })
    } else if (c.name === '外网连通') {
      steps.push({ title: '外网访问失败', steps: ['重启路由器并重新拨号。', '如果只有个别网站打不开，先看是不是代理把流量带偏了。', '仍然不行时，联系宽带运营商确认线路。'] })
    } else if (c.name === 'DNS 解析') {
      steps.push({ title: '更换 DNS', steps: ['在系统网络设置里把 DNS 改成 223.5.5.5 或 1.1.1.1。', '改完后重新体检，看解析耗时是否降下来。'] })
    } else if (c.name === 'IP 配置') {
      steps.push({ title: '检查 IP 设置', steps: ['把当前网络改成使用 DHCP 自动获取地址。', '确认默认网关和子网掩码不是空的。'] })
    } else if (c.name === '代理服务') {
      steps.push({ title: '检查代理端口', steps: ['系统代理指向了本机，但端口没有在监听。', '打开代理软件，或先在系统设置里关掉网页代理。'] })
    } else if (c.name === '网页重定向') {
      steps.push({ title: '网页被多次跳转', steps: ['暂时关闭代理或浏览器插件后再打开百度。', '如果仍被带到陌生页面，检查路由器管理页里有没有门户认证。'] })
    }
  }
  for (const conflict of diag.ip_conflicts) {
    steps.push({ title: `处理 IP 冲突 ${conflict.ip}`, steps: ['把占用这个地址的设备改成自动获取。', conflict.macs.join('、')] })
  }
  if (steps.length === 0) {
    steps.push({ title: '当前不用调整', steps: ['这次体检没有失败项。信号如果变弱，再靠近路由器即可。'] })
  }
  return steps
}

export default function App() {
  const tauri = isTauri()
  const [net, setNet] = useState<NetworkInfo | null>(tauri ? null : PREVIEW_NET)
  const [diag, setDiag] = useState<DiagResult | null>(tauri ? null : PREVIEW_DIAG)
  const [diagState, setDiagState] = useState<DiagState>(tauri ? 'idle' : 'done')
  const [proxy, setProxy] = useState<ProxyInsight | null>(tauri ? null : PREVIEW_PROXY)
  const [proxyLoading, setProxyLoading] = useState(tauri)
  const [latency, setLatency] = useState<LatencyPoint[]>(tauri ? [] : previewSeries())
  const [view, setView] = useState<View>('home')
  const [chatOn, setChatOn] = useState(false)
  const [toast, setToast] = useState('')
  const [checkedAt, setCheckedAt] = useState(tauri ? '' : '22:52:57')

  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(''), 2400)
    return () => window.clearTimeout(id)
  }, [toast])

  useEffect(() => {
    if (!tauri) return
    let cancel = false
    invoke<NetworkInfo>('get_network_info')
      .then((info) => {
        if (cancel) return
        setNet(info)
        setDiagState('running')
        invoke<DiagResult>('run_diagnosis', {
          gateway: info.gateway || '',
          dnsServer: info.dns[0] || '',
        })
          .then((result) => {
            if (cancel) return
            setDiag(result)
            setDiagState('done')
            setCheckedAt(nowTime())
          })
          .catch((err) => {
            if (cancel) return
            console.error(err)
            setDiagState('idle')
            setToast('体检没有完成，请再试一次')
          })
      })
      .catch((err) => {
        if (cancel) return
        console.error(err)
        setToast('没能读到本机网络信息')
      })
    invoke<ProxyInsight>('get_proxy_insight')
      .then((info) => {
        if (!cancel) setProxy(info)
      })
      .catch((err) => {
        if (cancel) return
        console.error(err)
        setToast('代理信息没有读到')
      })
      .finally(() => {
        if (!cancel) setProxyLoading(false)
      })
    return () => {
      cancel = true
    }
  }, [tauri])

  useEffect(() => {
    if (!tauri || !net?.gateway) return
    let stop = false
    let busy = false
    const tick = async () => {
      if (busy || stop) return
      busy = true
      try {
        const result = await invoke<PingOnceResult>('ping_once', { gateway: net.gateway })
        setLatency((prev) => {
          const next = [...prev, { time: nowTime(), gateway: result.gateway_ms, external: result.external_ms }]
          return next.length > 60 ? next.slice(-60) : next
        })
      } catch (err) {
        console.error(err)
      } finally {
        busy = false
      }
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => {
      stop = true
      window.clearInterval(id)
    }
  }, [tauri, net?.gateway])

  async function loadProxy() {
    if (!isTauri()) {
      setProxy(PREVIEW_PROXY)
      setProxyLoading(false)
      return
    }
    setProxyLoading(true)
    try {
      setProxy(await invoke<ProxyInsight>('get_proxy_insight'))
    } catch (err) {
      console.error(err)
      setToast('代理信息没有读到')
    } finally {
      setProxyLoading(false)
    }
  }

  async function runDiag(info: NetworkInfo) {
    if (!isTauri()) {
      setDiagState('running')
      window.setTimeout(() => {
        setDiag(PREVIEW_DIAG)
        setDiagState('done')
        setCheckedAt(nowTime())
      }, 700)
      return
    }
    setDiagState('running')
    try {
      const result = await invoke<DiagResult>('run_diagnosis', {
        gateway: info.gateway || '',
        dnsServer: info.dns[0] || '',
      })
      setDiag(result)
      setDiagState('done')
      setCheckedAt(nowTime())
    } catch (err) {
      console.error(err)
      setDiagState(diag ? 'done' : 'idle')
      setToast('体检没有完成，请再试一次')
    }
  }

  async function openExternal(url: string) {
    try {
      if (!isTauri()) {
        window.open(url, '_blank', 'noopener')
        return
      }
      await invoke('open_url', { url })
    } catch (err) {
      console.error(err)
      setToast('没能打开测速页面')
    }
  }

  const running = diagState === 'running'
  const overall = diag?.overall
  const copy = bannerCopy(diag, running)
  const checks = diag?.checks ?? PENDING_CHECKS
  const apps = diag?.app_latencies?.length ? diag.app_latencies : PENDING_APPS
  const dnsCheck = checkOf(diag, 'DNS 解析')
  const ipCheck = checkOf(diag, 'IP 配置')
  const last = latency[latency.length - 1]
  const gwMs = last?.gateway ?? 0
  const extMs = last?.external ?? 0
  const wifiOn = !!net?.wifi.connected
  const wiredOn = !!net?.wired_connected
  const sameExit = !!proxy?.proxy_exit.ip && proxy.proxy_exit.ip === proxy.direct_exit.ip
  const httpCheck = checkOf(diag, '外网连通')
  const dnsStatus = checkOf(diag, 'DNS 解析')?.status ?? ''
  const httpMs = Number((httpCheck?.value || '').replace(/[^\d.]/g, '')) || 0
  const chatCtx: DiagnosisContext = {
    ready: diagState === 'done' && !!diag,
    running,
    gatewayMs: diag?.gateway_ping_ms ?? 0,
    gatewayLoss: diag?.gateway_loss ?? 0,
    httpMs,
    httpOk: httpCheck?.status === 'ok' || httpCheck?.status === 'warning',
    dnsMs: diag?.dns_ms ?? 0,
    dnsOk: dnsStatus === 'ok' || dnsStatus === 'warning',
    dnsServer: net?.dns[0] || '',
    proxyOn: !!proxy?.enabled,
    proxyMode: proxy?.mode || '',
    proxyListening: !!proxy?.listening,
    wifiOn,
    wifiRssi: net?.wifi.rssi ?? 0,
    wifiBand: net?.wifi.band || '',
    extMs: diag?.external_ping_ms || extMs,
    failed: (diag?.checks ?? []).filter((c) => c.status === 'error' || c.status === 'warning').map((c) => c.name),
  }

  const nicRows: [string, string][] = []
  if (net) {
    nicRows.push(['名称', net.hardware_port || (wifiOn ? 'Wi-Fi' : '以太网')])
    nicRows.push(['MAC', net.mac || '--'])
    if (wifiOn && net.wifi.rssi !== 0) nicRows.push(['信号', `${net.wifi.rssi} dBm`])
    if (wifiOn && net.wifi.channel) {
      nicRows.push(['频段 / 信道', net.wifi.band ? `${net.wifi.band} · ${net.wifi.channel}` : `信道 ${net.wifi.channel}`])
    }
    nicRows.push(['连接方式', wifiOn ? '无线 (Wi-Fi) · 默认出口' : wiredOn ? '有线 · 默认出口' : '未连接'])
  }

  return (
    <div className={tauri ? 'app app--desktop' : 'app'}>
      {view !== 'advice' && <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden>
            <WifiGlyph />
          </span>
          <span className="brand__name">局域网医生</span>
          {!tauri && <span className="preview-flag">界面预览</span>}
        </div>
        <div className="topbar__right">
          <span className={`pill pill--${running ? 'run' : overall || 'idle'}`}>
            <i className={`dot ${overall === 'error' ? 'dot--off' : overall === 'warning' ? 'dot--warn' : 'dot--on'}`} />
            {statusWord(overall, running)}
          </span>
          <span className="muted">macOS</span>
          <span className="muted">v{APP_VERSION}</span>
          <button className="btn btn--ghost" type="button" onClick={() => setToast('还没有配置更新服务器')}>检查更新</button>
        </div>
      </header>}

      {view !== 'advice' && <div className="workspace">
        <aside className="side">
          <div className="link-row">
            <LinkCard
              kind="wifi"
              on={wifiOn}
              title={wifiOn ? `WiFi · ${net?.wifi_name || '默认'}` : 'WiFi'}
              state={wifiOn ? '已连接' : '未连接'}
              ip={wifiOn ? net?.ip : undefined}
            />
            <LinkCard
              kind="eth"
              on={wiredOn}
              title="有线"
              state={wiredOn ? '已连接' : '未连接'}
              ip={wiredOn ? net?.ip : undefined}
            />
          </div>

          <section className="card">
            <div className="split">
              <div>
                <div className="card__label">DNS</div>
                <div className="card__sub">解析耗时</div>
              </div>
              <div className="split__right">
                <div className="split__value">
                  {net?.dns[0] || '--'}
                  <Tag status={dnsCheck?.status}>{dnsCheck?.value || '待检查'}</Tag>
                </div>
                <div className="card__sub card__sub--right">
                  {diag && diag.dns_ms < 9000 ? `${Math.round(diag.dns_ms)}ms` : '--'}
                </div>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="split">
              <div className="card__label">IP</div>
              <div className="split__value">
                {net?.ip || '--'}
                <Tag status={ipCheck?.status || (net?.ip ? 'ok' : undefined)}>{ipCheck?.value || (net?.ip ? '正常' : '待检查')}</Tag>
              </div>
            </div>
            <div className="kv"><span>默认网关</span><b>{net?.gateway || '--'}</b></div>
            <div className="kv"><span>子网掩码</span><b>{net?.subnet_mask || '--'}</b></div>
          </section>

          <section className="card">
            <div className="split">
              <div className="card__label">代理服务</div>
              <Tag status={proxy?.enabled ? 'ok' : undefined}>{proxyLoading ? '读取中' : proxy?.enabled ? '启用' : '未启用'}</Tag>
            </div>
            {proxyLoading && <p className="hint">正在查看系统代理和本机常见端口…</p>}
            {!proxyLoading && !proxy?.enabled && <p className="hint">没有发现系统代理，也没有常见的本地代理端口。</p>}
            {!proxyLoading && proxy?.enabled && (
              <>
                {sameExit ? (
                  <ExitBlock title="当前出口" exit={proxy.direct_exit.ip ? proxy.direct_exit : proxy.proxy_exit} />
                ) : (
                  <>
                    <ExitBlock title={proxy.proxy_exit.overseas ? '海外站点' : '代理出口'} exit={proxy.proxy_exit} />
                    <ExitBlock title={proxy.direct_exit.overseas ? '直连出口' : '国内站点'} exit={proxy.direct_exit} />
                  </>
                )}
                {!proxy.proxy_exit.ip && !proxy.direct_exit.ip && <p className="hint">出口地址暂时没有查到。</p>}
              </>
            )}
          </section>

          <section className="card">
            <div className="card__label card__label--icon">
              <EthGlyph /> 网卡信息
            </div>
            {net ? nicRows.map(([k, v]) => (
              <div className="kv" key={k}><span>{k}</span><b>{v}</b></div>
            )) : <p className="hint">正在读取网卡…</p>}
          </section>

          <button className="ai-btn" type="button" onClick={() => { setChatOn(true); setView('advice') }}>智能诊断</button>

          <div className="side__foot">
            <div className="who">
              <span className="who__avatar">本</span>
              <span>
                <strong>本机诊断</strong>
                <small>结果只留在这台电脑</small>
              </span>
            </div>
            <button className="btn btn--quiet" type="button" onClick={() => setView('plan')}>建议方案</button>
          </div>
        </aside>

        <main className="main">
          {view === 'home' && (
            <>
              <section className="card">
                <div className="section-head">
                  <h2><span className="q">?</span> 快速体检与故障诊断</h2>
                  <div className="section-head__actions">
                    <span className="muted">{checkedAt ? `检查于 ${checkedAt}` : '尚未体检'}</span>
                    <button className="btn btn--ghost" type="button" disabled={!net || running} onClick={() => net && runDiag(net)}>
                      {running ? '体检中' : '重新体检'}
                    </button>
                  </div>
                </div>
                <div className={`banner banner--${running ? 'run' : overall || 'idle'}`}>
                  <Mark status={running ? 'pending' : overall || 'pending'} />
                  <div>
                    <div className="banner__title">{copy.title}</div>
                    <div className="banner__desc">{copy.desc}</div>
                  </div>
                </div>
                <div className="checks">
                  {checks.map((c) => (
                    <div className="check" key={c.name}>
                      <Mark status={c.status} />
                      <div className="check__text">
                        <span className="check__name">{c.name}</span>
                        {c.detail && <span className="check__detail">{c.detail}</span>}
                      </div>
                      <span className={`check__value check__value--${c.status}`}>{c.value}</span>
                    </div>
                  ))}
                </div>
                {diag && diag.ip_conflicts.length > 0 && (
                  <div className="alert">发现 IP 冲突：{diag.ip_conflicts.map((c) => c.ip).join('、')}</div>
                )}
                {diag && diag.rogue_devices.length > 0 && (
                  <div className="alert alert--warn">局域网里有路由品牌设备：{diag.rogue_devices.map((d) => `${d.vendor} ${d.ip}`).join('、')}</div>
                )}
              </section>

              <section className="card">
                <div className="section-head">
                  <h2>VPN 诊断</h2>
                  <button className="icon-btn" type="button" onClick={loadProxy} aria-label="刷新代理信息">↻</button>
                </div>
                <div className="vpn">
                  <div className="vpn__mode">代理模式 <strong>{proxy?.mode || (proxyLoading ? '读取中' : '未启用')}</strong></div>
                  {proxy?.enabled ? (
                    <div className="vpn__row">
                      <div>
                        <div className="vpn__service">
                          当前代理服务：<strong>{proxy.service || '本地代理'}</strong>
                          {proxy.port > 0 && <span className="port">端口 {proxy.port}</span>}
                        </div>
                        <div className="hint">
                          代理地址：{proxy.address || '--'}
                          <span className="dot-gap" />
                          端口监听：<b className={proxy.listening ? 'ok-text' : 'bad-text'}>{proxy.listening ? '正常' : '未监听'}</b>
                        </div>
                      </div>
                      <div className={proxy.listening ? 'vpn__lat' : 'vpn__lat vpn__lat--off'}>
                        {proxy.listening ? `正常连通 ${proxy.latency_ms > 0 ? proxy.latency_ms : '<1'} ms` : '未连通'}
                      </div>
                    </div>
                  ) : (
                    <p className="hint hint--pad">{proxyLoading ? '正在确认代理软件是否在监听…' : '当前没有可诊断的本地代理。'}</p>
                  )}
                </div>
              </section>

              <div className="pair">
                <section className="card">
                  <h2 className="h-quiet">使用代理的进程</h2>
                  <div className="pair__row">
                    <span>{proxy?.enabled ? (proxy.process_name || proxy.service || '—') : '—'}</span>
                    <span className="count">{proxy?.enabled ? `${proxy.connection_count} 个连接` : '0 个连接'}</span>
                  </div>
                </section>
                <section className="card">
                  <h2 className="h-quiet">应用体验度量</h2>
                  <p className="hint">典型应用体验（国内外路径）</p>
                  <div className="apps">
                    {apps.map((app) => (
                      <div key={app.name} className="apps__item">
                        <span>{app.name}</span>
                        <b className={`apps__ms apps__ms--${app.status}`}>{app.latency_ms > 0 ? `${app.latency_ms}ms` : '--'}</b>
                      </div>
                    ))}
                  </div>
                </section>
              </div>

              <section className="card chart-card">
                <div className="chart-card__grid">
                  <div>
                    <div className="section-head">
                      <h2>实时网络延迟</h2>
                      <div className="legend">
                        <span><i className="swatch swatch--gw" /> 内网（网关）</span>
                        <span><i className="swatch swatch--ext" /> 外网</span>
                        <span className="muted">最近 60s · 每秒刷新</span>
                      </div>
                    </div>
                    <div className="lat-nums">
                      <div>内网延迟 <strong className="num num--gw">{gwMs > 0 ? Math.round(gwMs) : '--'}</strong> <em>ms</em></div>
                      <div>外网延迟 <strong className="num num--ext">{extMs > 0 ? Math.round(extMs) : '--'}</strong> <em>ms</em></div>
                    </div>
                    {latency.length >= 2 ? <LatencyChart data={latency} /> : <div className="chart-empty">收集中…</div>}
                    <div className="probe">探测目标 223.5.5.5 · HTTP www.baidu.com</div>
                  </div>
                  <aside className="speed">
                    <h2>带宽测速</h2>
                    <p>如需了解上行和下行速度，可访问外部测速网站：</p>
                    <button className="speed__btn speed__btn--a" type="button" onClick={() => openExternal(SPEEDTEST)}>
                      Speedtest <span aria-hidden>↗</span>
                    </button>
                    <button className="speed__btn speed__btn--b" type="button" onClick={() => openExternal(USTC)}>
                      中科大测速 <span aria-hidden>↗</span>
                    </button>
                    <p className="fine">访问外部网站得到的结果仅供参考</p>
                  </aside>
                </div>
              </section>
            </>
          )}

          {view === 'plan' && (
            <section className="card sheet">
              <div className="section-head">
                <h2>建议方案</h2>
                <button className="btn btn--ghost" type="button" onClick={() => setView('home')}>返回体检</button>
              </div>
              <div className="stack">
                {planItems(diag).map((item) => (
                  <article key={item.title} className="note">
                    <h3>{item.title}</h3>
                    <ol>{item.steps.map((step) => <li key={step}>{step}</li>)}</ol>
                  </article>
                ))}
              </div>
            </section>
          )}
        </main>
      </div>}

      {chatOn && (
        <div className="desk-slot" hidden={view !== 'advice'}>
          <DiagnosisChat ctx={chatCtx} plans={planItems(diag)} onHome={() => setView('home')} onToast={setToast} />
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}
