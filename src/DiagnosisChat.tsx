import { useEffect, useRef, useState } from 'react'

export interface DiagnosisContext {
  ready: boolean
  running: boolean
  gatewayMs: number
  gatewayLoss: number
  httpMs: number
  httpOk: boolean
  dnsMs: number
  dnsOk: boolean
  dnsServer: string
  proxyOn: boolean
  proxyMode: string
  proxyListening: boolean
  wifiOn: boolean
  wifiRssi: number
  wifiBand: string
  extMs: number
  failed: string[]
}

type Symptom = 'slow' | 'blocked' | 'flaky' | 'local' | 'other'
type Scope = 'all' | 'this' | 'unknown'
type SegStatus = 'ok' | 'warn' | 'bad' | 'idle'

interface Segment {
  name: string
  value: string
  status: SegStatus
}

interface Msg {
  id: number
  from: 'bot' | 'user'
  text: string
  segments?: Segment[]
  steps?: string[]
  plan?: boolean
}

interface Chip {
  label: string
  symptom?: Symptom
  scope?: Scope
  resolve?: 'yes' | 'no'
}

const SYMPTOM_CHIPS: Chip[] = [
  { label: '网速慢、延迟高', symptom: 'slow' },
  { label: '网站或软件打不开', symptom: 'blocked' },
  { label: '时断时续', symptom: 'flaky' },
  { label: '只有这台电脑不行', symptom: 'local' },
]

const SCOPE_CHIPS: Chip[] = [
  { label: '其他设备也一样', scope: 'all' },
  { label: '只有这台不行', scope: 'this' },
  { label: '不确定', scope: 'unknown' },
]

const RESOLVE_CHIPS: Chip[] = [
  { label: '已经好了', resolve: 'yes' },
  { label: '还没有', resolve: 'no' },
]

function classify(text: string): Symptom {
  if (/打不开|无法访问|连不上|上不了|进不去/.test(text)) return 'blocked'
  if (/断|掉线|时好时坏|不稳定|断断续续/.test(text)) return 'flaky'
  if (/只有这台|就这台|只有我这/.test(text)) return 'local'
  if (/慢|卡|延迟|丢包|加载/.test(text)) return 'slow'
  return 'other'
}

function inferScope(text: string): Scope | null {
  if (/其他设备也|手机也|全都|所有设备|全家|别人也/.test(text)) return 'all'
  if (/只有这台|就这台|其他正常|别的设备正常|只有我这/.test(text)) return 'this'
  if (/不确定|不知道|没试/.test(text)) return 'unknown'
  return null
}

function tone(status: SegStatus) {
  if (status === 'ok') return '正常'
  if (status === 'warn') return '偏弱'
  if (status === 'bad') return '异常'
  return '待测'
}

function segmentsOf(ctx: DiagnosisContext): Segment[] {
  const gw = !ctx.ready
    ? { status: 'idle' as SegStatus, value: ctx.running ? '检测中' : '--' }
    : ctx.gatewayMs <= 0 || ctx.gatewayLoss > 50
      ? { status: 'bad' as SegStatus, value: ctx.gatewayMs > 0 ? `${Math.round(ctx.gatewayMs)}ms` : '超时' }
      : ctx.gatewayLoss > 0 || ctx.gatewayMs > 40 || (ctx.wifiOn && ctx.wifiRssi !== 0 && ctx.wifiRssi < -75)
        ? { status: 'warn' as SegStatus, value: `${Math.round(ctx.gatewayMs)}ms` }
        : { status: 'ok' as SegStatus, value: `${Math.round(ctx.gatewayMs)}ms` }

  const dns = !ctx.ready
    ? { status: 'idle' as SegStatus, value: ctx.running ? '检测中' : '--' }
    : !ctx.dnsOk || ctx.dnsMs > 1000
      ? { status: 'bad' as SegStatus, value: ctx.dnsMs > 0 && ctx.dnsMs < 9000 ? `${Math.round(ctx.dnsMs)}ms` : '失败' }
      : ctx.dnsMs > 200
        ? { status: 'warn' as SegStatus, value: `${Math.round(ctx.dnsMs)}ms` }
        : { status: 'ok' as SegStatus, value: `${Math.round(ctx.dnsMs)}ms` }

  const web = !ctx.ready
    ? { status: 'idle' as SegStatus, value: ctx.running ? '检测中' : '--' }
    : !ctx.httpOk
      ? { status: 'bad' as SegStatus, value: '失败' }
      : ctx.httpMs > 800
        ? { status: 'warn' as SegStatus, value: `${Math.round(ctx.httpMs)}ms` }
        : { status: 'ok' as SegStatus, value: ctx.httpMs > 0 ? `${Math.round(ctx.httpMs)}ms` : '正常' }

  const proxy = !ctx.proxyOn
    ? { status: 'ok' as SegStatus, value: '未启用' }
    : ctx.proxyListening
      ? { status: 'ok' as SegStatus, value: ctx.proxyMode || '已启用' }
      : { status: 'bad' as SegStatus, value: '端口未监听' }

  return [
    { name: '到路由器', ...gw },
    { name: 'DNS', ...dns },
    { name: '访问网页', ...web },
    { name: '代理', ...proxy },
  ]
}

function buildReport(symptom: Symptom, scope: Scope, ctx: DiagnosisContext, said: string) {
  const segments = segmentsOf(ctx)
  const gw = segments[0]
  const dns = segments[1]
  const web = segments[2]
  const weakWifi = ctx.wifiOn && ctx.wifiRssi !== 0 && ctx.wifiRssi < -75
  const steps: string[] = []
  let where = ''

  if (!ctx.ready) {
    where = '体检数字还没到齐，下面先按你的描述判断该先看哪一段。结果出来后可以再发一次。'
    steps.push('等首页体检结束，再把同样的现象发过来。')
  } else if (gw.status === 'bad') {
    where = '电脑到路由器这段就不稳定，后面的网页和 DNS 都会跟着失败。'
    steps.push(ctx.wifiOn ? '靠近路由器，或换到 5GHz 后再试。' : '把网线两端重新插紧。')
    steps.push('重启路由器，等大约 30 秒。')
  } else if (dns.status === 'bad') {
    where = `路由器是通的，但 DNS${ctx.dnsServer ? `（${ctx.dnsServer}）` : ''}没有正常解析。`
    steps.push('在系统网络设置里把 DNS 改成 223.5.5.5。')
    steps.push('改完后回首页重新体检。')
  } else if (web.status === 'bad' && ctx.proxyOn && !ctx.proxyListening) {
    where = '系统代理开着，但本机端口没有在监听，网页请求出不去。'
    steps.push('打开代理软件，或先在系统设置里关掉网页代理。')
  } else if (web.status === 'bad' && scope === 'all') {
    where = '这台电脑到路由器是通的，网页不通，而且其他设备也一样，更像宽带或光猫。'
    steps.push('重启光猫和路由器。')
    steps.push('仍然打不开时，联系运营商确认线路。')
  } else if (web.status === 'bad') {
    where = ctx.proxyOn
      ? '到路由器是通的，网页请求失败，而且代理开着。先分清是代理拦了，还是外网本身不通。'
      : '到路由器是通的，访问网页失败。问题在路由器外侧，不在这台电脑的网卡。'
    steps.push(ctx.proxyOn ? '暂时关掉代理后再打开一次网页。' : '重启路由器并重新拨号。')
  } else if (symptom === 'blocked') {
    const named = !/^(网站或软件打不开|只有这台不行|其他设备也一样|不确定)$/.test(said)
    where = ctx.proxyOn
      ? named
        ? `体检时百度是打开的。「${said}」更像被代理规则单独带走，而不是整台电脑上不了网。`
        : '体检时百度是打开的。如果只有个别网站或软件不行，优先看代理规则把这个地址带到了哪里。'
      : named
        ? `体检时网页是通的。「${said}」如果只是这一个地址，先看它是不是解析失败。`
        : '体检时网页是通的。打不开的如果只是某一个地址，把名字发过来，再判断是不是解析或权限问题。'
    steps.push(named
      ? (ctx.proxyOn ? `在代理规则里看「${said}」走的是代理还是直连。` : `再确认「${said}」是不是只有这一个地址打不开。`)
      : (ctx.proxyOn ? '补充打不开的网站或软件名。' : '补充具体打不开的地址。'))
  } else if (symptom === 'slow' && (gw.status === 'warn' || weakWifi)) {
    where = weakWifi
      ? `无线信号大约 ${ctx.wifiRssi} dBm${ctx.wifiBand ? `，${ctx.wifiBand}` : ''}，慢更可能出在空中这段，而不是宽带。`
      : `到路由器要 ${gw.value}，延迟先耗在局域网里。`
    steps.push(ctx.wifiOn ? '靠近路由器，或减少隔墙和 2.4GHz 干扰。' : '检查网线是否松动、交换机是否过热。')
  } else if (symptom === 'slow' && dns.status === 'warn') {
    where = `网页能开，但 DNS 要 ${dns.value}，打开新网站时会先卡一下。`
    steps.push('把 DNS 换成 223.5.5.5 或 1.1.1.1 后再对比。')
  } else if (symptom === 'slow') {
    const ext = ctx.extMs > 0 ? `，外网探测大约 ${Math.round(ctx.extMs)}ms` : ''
    where = gw.status === 'ok'
      ? `到路由器 ${gw.value}，这段不慢${ext}。变慢的位置在出网以后。`
      : `到路由器 ${gw.value}${ext}。`
    steps.push('如果只是某一个软件慢，补充它的名字。')
  } else if (symptom === 'flaky' && (gw.status !== 'ok' || weakWifi)) {
    where = weakWifi
      ? `信号 ${ctx.wifiRssi} dBm，断断续续很像无线不稳。`
      : `到路由器有丢包或偏慢（${gw.value}），中断会先出现在这一段。`
    steps.push('靠近路由器试几分钟。如果立刻稳定，就是信号或干扰。')
  } else if (symptom === 'flaky') {
    where = '到路由器这段目前是稳的。若仍会自己断开，更可疑的是宽带闪断，或代理进程在重启。'
    steps.push(ctx.proxyOn ? '看断开时代理软件是否掉线。' : '断开时看路由器的上网灯是否跟着灭。')
  } else if (symptom === 'local' || scope === 'this') {
    where = gw.status === 'ok'
      ? '其他设备正常时，路由器和宽带多半没问题。这台电脑要看 DNS 和代理有没有把流量带偏。'
      : '你标了只有这台电脑不行，但连路由器本身也不通，先把这台的无线或网线恢复。'
    if (ctx.proxyOn) steps.push(`当前代理是${ctx.proxyMode || '开启状态'}。先退出代理，看问题是否还在。`)
    else steps.push('在这台电脑上把网络改成自动获取 IP 和 DNS。')
  } else if (ctx.failed.length > 0) {
    where = `体检里需要留意的是：${ctx.failed.join('、')}。`
  } else {
    where = '到路由器、DNS 和网页这几段目前都正常。补充是哪个软件、什么时候开始的，范围还能再缩小。'
    steps.push('写上软件名或网站，以及是不是刚开始。')
  }

  if (weakWifi && !steps.some((s) => s.includes('靠近路由器'))) {
    steps.push(`信号 ${ctx.wifiRssi} dBm，可以先靠近路由器排除无线。`)
  }
  if (scope === 'all' && gw.status === 'ok' && !steps.some((s) => s.includes('光猫'))) {
    steps.push('其他设备也一样时，优先重启光猫和路由器，而不是重装这台电脑的系统。')
  }

  const leadParts = [`你说的是「${said}」。`]
  if (ctx.failed.length > 0) leadParts.push(`这次体检没通过的有：${ctx.failed.join('、')}。`)
  else if (ctx.ready) leadParts.push('这次体检没有失败项。')
  leadParts.push(where)

  return {
    text: leadParts.join(''),
    segments,
    steps: steps.slice(0, 3),
  }
}

interface Session {
  id: number
  title: string
  messages: Msg[]
  chips: Chip[]
  stage: 'symptom' | 'scope' | 'report'
  symptom: Symptom
  scope: Scope
  detail: string
}

interface Scene {
  title: string
  detail: string
  symptom?: Symptom
  plan?: boolean
}

const SCENES: Scene[] = [
  { title: '网卡、慢、延迟高', detail: '微信/视频转圈、下载慢、ping 高', symptom: 'slow' },
  { title: 'Wi-Fi 连不上、老掉线、信号弱', detail: '满格也断、隔墙就弱、连上了打不开', symptom: 'flaky' },
  { title: '某个网站 / 软件 / 内网设备打不开', detail: '能上微信却打不开网页、粘个网址帮你测', symptom: 'blocked' },
  { title: '我们公司有新的网络需求，帮我出个方案', detail: '增加设备、改善覆盖、梳理公司的网络需求', plan: true },
]

const PROMPT_KEY = 'lanwatch.custom-prompts'

function loadPrompts() {
  try {
    const raw = JSON.parse(localStorage.getItem(PROMPT_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((item) => typeof item === 'string' && item.trim()) as string[] : []
  } catch {
    return []
  }
}

function clipTitle(text: string) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 18 ? `${flat.slice(0, 18)}…` : flat
}

function blankSession(id: number): Session {
  return {
    id,
    title: '',
    messages: [],
    chips: [],
    stage: 'symptom',
    symptom: 'other',
    scope: 'unknown',
    detail: '',
  }
}

export interface PlanItem {
  title: string
  steps: string[]
}

type DeskNav = 'new' | 'commands' | 'plan'
type DeskPanel = 'pick' | 'thread' | 'commands' | 'plan'

export default function DiagnosisChat({
  ctx,
  plans,
  onHome,
  onToast,
}: {
  ctx: DiagnosisContext
  plans: PlanItem[]
  onHome: () => void
  onToast: (text: string) => void
}) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [panel, setPanel] = useState<DeskPanel>('pick')
  const [nav, setNav] = useState<DeskNav>('new')
  const [draft, setDraft] = useState('')
  const [shot, setShot] = useState('')
  const [prompts, setPrompts] = useState<string[]>(loadPrompts)
  const [promptDraft, setPromptDraft] = useState('')
  const idRef = useRef(1)
  const sessionIdRef = useRef(1)
  const activeIdRef = useRef<number | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const active = sessions.find((item) => item.id === activeId) ?? null

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [active?.messages, active?.chips, panel])

  function advance(session: Session, said: string, pick: Chip | undefined): Session {
    const user: Msg = { id: idRef.current++, from: 'user', text: said }
    const withUser: Session = {
      ...session,
      title: session.title || clipTitle(said),
      messages: [...session.messages, user],
    }
    const bot = (partial: Omit<Msg, 'id' | 'from'>): Msg => ({ id: idRef.current++, from: 'bot', ...partial })

    if (pick?.resolve === 'yes') {
      return {
        ...withUser,
        messages: [...withUser.messages, bot({ text: '好。这次先到这里。再出现的话，直接说是慢、打不开，还是断断续续。' })],
        chips: SYMPTOM_CHIPS,
        stage: 'symptom',
      }
    }
    if (pick?.resolve === 'no') {
      return {
        ...withUser,
        messages: [...withUser.messages, bot({
          text: '那按刚才的顺序处理。左侧「建议方案」里有对应步骤。如果已经试过，补充是哪个网站或软件，我再收窄。',
          plan: true,
        })],
        chips: [],
      }
    }

    if (session.stage === 'scope' && !pick?.symptom) {
      const nextScope = pick?.scope ?? inferScope(said) ?? 'unknown'
      const report = buildReport(session.symptom, nextScope, ctx, session.detail || said)
      return {
        ...withUser,
        scope: nextScope,
        messages: [...withUser.messages, bot({ text: report.text, segments: report.segments, steps: report.steps })],
        chips: RESOLVE_CHIPS,
        stage: 'report',
      }
    }

    if (session.stage === 'report' && !pick?.symptom) {
      const nextSymptom = classify(said)
      const implied = nextSymptom === 'local' ? 'this' : inferScope(said) ?? session.scope
      const report = buildReport(nextSymptom, implied, ctx, said)
      return {
        ...withUser,
        symptom: nextSymptom,
        scope: implied,
        detail: said,
        messages: [...withUser.messages, bot({ text: report.text, segments: report.segments, steps: report.steps })],
        chips: RESOLVE_CHIPS,
        stage: 'report',
      }
    }

    const nextSymptom = pick?.symptom ?? classify(said)
    const implied = nextSymptom === 'local' ? 'this' : pick?.scope ?? inferScope(said)
    if (implied) {
      const report = buildReport(nextSymptom, implied, ctx, said)
      return {
        ...withUser,
        symptom: nextSymptom,
        scope: implied,
        detail: said,
        messages: [...withUser.messages, bot({ text: report.text, segments: report.segments, steps: report.steps })],
        chips: RESOLVE_CHIPS,
        stage: 'report',
      }
    }
    return {
      ...withUser,
      symptom: nextSymptom,
      detail: said,
      stage: 'scope',
      chips: SCOPE_CHIPS,
      messages: [...withUser.messages, bot({ text: '同一网络下，手机或其他电脑也这样吗？这能分清是宽带的问题，还是只有这台电脑。' })],
    }
  }

  function begin(text: string, pick?: Chip) {
    const said = (text.trim() || pick?.label || '').trim()
    if (!said) return
    const continueThread = panel === 'thread' && activeIdRef.current != null
    const id = continueThread ? activeIdRef.current as number : sessionIdRef.current++
    if (!continueThread) {
      activeIdRef.current = id
      setActiveId(id)
    }
    setPanel('thread')
    setNav('new')
    setDraft('')
    setShot('')
    setSessions((prev) => {
      const list = prev.some((item) => item.id === id) ? prev : [blankSession(id), ...prev].slice(0, 20)
      return list.map((item) => (item.id === id ? advance(item, said, pick) : item))
    })
  }

  function fresh() {
    activeIdRef.current = null
    setActiveId(null)
    setPanel('pick')
    setNav('new')
    setDraft('')
    setShot('')
  }

  function openSession(id: number) {
    activeIdRef.current = id
    setActiveId(id)
    setPanel('thread')
    setNav('new')
  }

  function savePrompt() {
    const text = promptDraft.trim()
    if (!text) return
    const next = [text, ...prompts.filter((item) => item !== text)].slice(0, 20)
    setPrompts(next)
    setPromptDraft('')
    localStorage.setItem(PROMPT_KEY, JSON.stringify(next))
  }

  function removePrompt(text: string) {
    const next = prompts.filter((item) => item !== text)
    setPrompts(next)
    localStorage.setItem(PROMPT_KEY, JSON.stringify(next))
  }

  function sendDraft() {
    const note = shot ? `（附带截图 ${shot}，本机没有识别图片内容）` : ''
    const text = `${draft.trim()}${draft.trim() && note ? ' ' : ''}${note}`.trim()
    if (!text) {
      if (shot) onToast('图片还不能在本机识别，请把报错文字贴到输入框')
      return
    }
    begin(text)
  }

  const live = segmentsOf(ctx)

  return (
    <div className="desk">
      <div className="desk__drag" />
      <aside className="desk__side">
        <div className="desk__brand">
          <span className="desk__logo" aria-hidden>
            <PulseGlyph />
          </span>
          <span>
            <strong>局域网医生</strong>
            <small>本机网络诊断</small>
          </span>
        </div>

        <nav className="desk__nav" aria-label="诊断导航">
          <button className="nav-btn" type="button" onClick={onHome}>
            <HomeGlyph /> 网络概览
          </button>
          <button className={`nav-btn ${nav === 'new' ? 'is-on' : ''}`} type="button" onClick={fresh}>
            <PlusGlyph /> 新建诊断
          </button>
          <button
            className={`nav-btn ${nav === 'commands' ? 'is-on' : ''}`}
            type="button"
            onClick={() => { setPanel('commands'); setNav('commands') }}
          >
            <ListGlyph /> 自定义指令
          </button>
        </nav>

        <div className="desk__rule" />

        <div className="recent">
          <div className="recent__label">最近会话</div>
          {sessions.length === 0 && <p className="recent__empty">还没有会话</p>}
          {sessions.map((item) => (
            <button
              key={item.id}
              className={`recent__item ${panel === 'thread' && item.id === activeId ? 'is-on' : ''}`}
              type="button"
              onClick={() => openSession(item.id)}
            >
              {item.title || '未命名会话'}
            </button>
          ))}
        </div>

        <button
          className={`desk__support ${nav === 'plan' ? 'is-on' : ''}`}
          type="button"
          onClick={() => { setPanel('plan'); setNav('plan') }}
        >
          <span className="desk__support-icon" aria-hidden><PlanGlyph /></span>
          <span>
            <strong>建议方案</strong>
            <small>根据这次体检整理步骤</small>
          </span>
          <ChevronGlyph />
        </button>
      </aside>

      <div className="desk__main">
        <div className="desk__stage">
          {panel === 'pick' && (
            <div className="ask">
              <h1>今天想排查什么网络问题？</h1>
              <p>描述现象，或从下面选择一个常见场景开始诊断</p>
              <div className="scenes">
                {SCENES.map((scene) => (
                  <button
                    key={scene.title}
                    className="scene"
                    type="button"
                    onClick={() => {
                      if (scene.plan) {
                        setPanel('plan')
                        setNav('plan')
                        return
                      }
                      begin(scene.title, { label: scene.title, symptom: scene.symptom })
                    }}
                  >
                    <strong>{scene.title}</strong>
                    <span>{scene.detail}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {panel === 'thread' && active && (
            <div className="thread">
              <div className="ctxbar" aria-label="当前体检摘要">
                {live.map((seg) => (
                  <span key={seg.name} className={`ctxbar__item ctxbar__item--${seg.status}`}>
                    {seg.name} {seg.value}
                  </span>
                ))}
              </div>
              <div className="thread__log" role="log" aria-live="polite">
                {active.messages.map((msg) => (
                  <div key={msg.id} className={`bubble-row ${msg.from === 'user' ? 'bubble-row--user' : ''}`}>
                    {msg.from === 'bot' && <span className="bubble-avatar">诊</span>}
                    <div className={`bubble ${msg.from === 'user' ? 'bubble--user' : ''}`}>
                      <p>{msg.text}</p>
                      {msg.segments && (
                        <div className="seg-list">
                          {msg.segments.map((seg) => (
                            <div key={seg.name} className="seg">
                              <span>{seg.name}</span>
                              <b className={`seg__val seg__val--${seg.status}`}>{seg.value}</b>
                              <em>{tone(seg.status)}</em>
                            </div>
                          ))}
                        </div>
                      )}
                      {msg.steps && msg.steps.length > 0 && (
                        <ol className="bubble__steps">
                          {msg.steps.map((step) => <li key={step}>{step}</li>)}
                        </ol>
                      )}
                      {msg.plan && (
                        <button className="btn btn--quiet bubble__plan" type="button" onClick={() => { setPanel('plan'); setNav('plan') }}>
                          打开建议方案
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                <div ref={endRef} />
              </div>
              {active.chips.length > 0 && (
                <div className="chips">
                  {active.chips.map((chip) => (
                    <button key={chip.label} className="chip" type="button" onClick={() => begin(chip.label, chip)}>
                      {chip.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {panel === 'commands' && (
            <div className="ask ask--top">
              <h1>自定义指令</h1>
              <p>存一句常用的排查说法，点一下就按这句话开始。</p>
              <form
                className="prompt-add"
                onSubmit={(event) => {
                  event.preventDefault()
                  savePrompt()
                }}
              >
                <input
                  value={promptDraft}
                  onChange={(event) => setPromptDraft(event.target.value)}
                  placeholder="例如：公司 VPN 连上后内网打不开"
                  aria-label="新的自定义指令"
                />
                <button className="btn" type="submit">保存</button>
              </form>
              {prompts.length === 0 && <p className="recent__empty">还没有自定义指令</p>}
              <div className="prompt-list">
                {prompts.map((item) => (
                  <div key={item} className="prompt-row">
                    <button className="prompt-row__go" type="button" onClick={() => begin(item)}>{item}</button>
                    <button className="prompt-row__del" type="button" aria-label={`删除 ${item}`} onClick={() => removePrompt(item)}>×</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {panel === 'plan' && (
            <div className="ask ask--top plan-view">
              <h1>建议方案</h1>
              <p>根据这次体检整理，只针对这台电脑。改系统设置之前请自己确认。</p>
              <div className="plan-list">
                {plans.map((item) => (
                  <article key={item.title} className="note">
                    <h3>{item.title}</h3>
                    <ol>{item.steps.map((step) => <li key={step}>{step}</li>)}</ol>
                  </article>
                ))}
              </div>
            </div>
          )}
        </div>

        <form
          className="ask__form"
          onSubmit={(event) => {
            event.preventDefault()
            sendDraft()
          }}
        >
          <div className="ask__box">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  sendDraft()
                }
              }}
              placeholder="描述你的网络问题，或粘贴报错信息..."
              aria-label="描述网络问题"
              rows={2}
            />
            {shot && <div className="ask__file">截图 {shot}</div>}
            <div className="ask__tools">
              <button className="ask__clip" type="button" aria-label="附上截图" onClick={() => fileRef.current?.click()}>
                <ImageGlyph />
              </button>
              <button className="ask__send" type="submit" aria-label="发送" disabled={!draft.trim() && !shot}>
                <ArrowGlyph />
              </button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (!file) return
                setShot(file.name)
                onToast('图片留在本机，文字还识别不了，请把报错贴到输入框')
              }}
            />
          </div>
          <p className="ask__fine">根据这台电脑的体检做判断，修改网络设置前请自己确认</p>
        </form>
      </div>
    </div>
  )
}

function PulseGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <path d="M2 9h3l1.6-3.2L9.2 12l1.5-3H16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function HomeGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3 7.2 8 3l5 4.2V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  )
}

function PlusGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function ListGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 4.5h8M4 8h8M4 11.5h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function PlanGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M5 2.5h6a1 1 0 0 1 1 1V13l-4-2-4 2V3.5a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
}

function ChevronGlyph() {
  return (
    <svg className="desk__chevron" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M5 3.2 8.8 7 5 10.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ImageGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <rect x="2.2" y="3.2" width="13.6" height="11.6" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6.4" cy="7.1" r="1.1" fill="currentColor" />
      <path d="M3.4 12.4 7 9.2l2.2 2 2-1.6 3 2.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ArrowGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 12.5V3.8M4.6 7 8 3.6 11.4 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
