import { useState, useEffect, ReactElement } from 'react'
import './App.css'

// --- Types ---
type Mode = 'basic' | 'advanced'
type Section = 'diagnose' | 'guided' | 'chat'
type CheckStatus = 'ok' | 'warning' | 'error' | 'pending' | 'running'
type DiagState = 'idle' | 'running' | 'done'

interface DiagCheck {
  name: string
  status: CheckStatus
  detail: string
  value?: string
}

interface ChatMsg {
  from: 'bot' | 'user'
  text: string
  time: string
}

// --- Mock Data ---
const mockChecks: DiagCheck[] = [
  { name: '网络接口', status: 'ok', detail: 'Wi-Fi 已连接，信号良好', value: '-52 dBm' },
  { name: '网关连通性', status: 'ok', detail: '到路由器的连接正常', value: '1.2 ms' },
  { name: 'DNS 解析', status: 'ok', detail: 'DNS 服务器响应正常', value: '12 ms' },
  { name: '外网连通性', status: 'warning', detail: '部分外网节点响应较慢', value: '156 ms' },
  { name: '局域网设备', status: 'ok', detail: '发现 5 台设备在线', value: '5 台' },
  { name: '带宽测试', status: 'ok', detail: '下载速度正常', value: '85 Mbps' },
]

const advancedChecks = [
  { cmd: 'ifconfig en0', result: 'inet 192.168.1.100 netmask 0xffffff00', status: 'ok' as CheckStatus },
  { cmd: 'ping -c 4 192.168.1.1', result: '4 packets transmitted, 0% loss, avg 1.2ms', status: 'ok' as CheckStatus },
  { cmd: 'nslookup example.com', result: 'Server: 192.168.1.1\nAddress: 93.184.216.34', status: 'ok' as CheckStatus },
  { cmd: 'ping -c 4 8.8.8.8', result: '4 packets transmitted, 25% loss, avg 156ms', status: 'warning' as CheckStatus },
  { cmd: 'arp -a', result: '5 entries in ARP table', status: 'ok' as CheckStatus },
]

// --- Icons ---
function Icon({ type, size = 18 }: { type: string; size?: number }) {
  const s = { width: size, height: size }
  const icons: Record<string, ReactElement> = {
    diagnose: (
      <svg style={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M9 3h6v4H9z" /><path d="M12 7v4" /><path d="M4 21h16" />
        <path d="M7 21V11a5 5 0 0110 0v10" />
      </svg>
    ),
    guided: (
      <svg style={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M9 12h6" /><path d="M12 9v6" /><circle cx="12" cy="12" r="9" />
      </svg>
    ),
    chat: (
      <svg style={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
      </svg>
    ),
    basic: (
      <svg style={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
    ),
    advanced: (
      <svg style={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
      </svg>
    ),
    wifi: (
      <svg style={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M5 12.55a11 11 0 0114.08 0" /><path d="M1.42 9a16 16 0 0121.16 0" />
        <path d="M8.53 16.11a6 6 0 016.95 0" /><circle cx="12" cy="20" r="1" fill="currentColor" />
      </svg>
    ),
  }
  return icons[type] || null
}

function StatusDot({ status }: { status: CheckStatus }) {
  const cls = status === 'ok' ? 'dot-ok' : status === 'warning' ? 'dot-warn' : status === 'error' ? 'dot-err' : 'dot-pend'
  return <span className={`dot ${cls}`} />
}

// --- Sub Components ---
function HealthRing({ state }: { state: DiagState }) {
  if (state === 'running') {
    return (
      <div className="health-ring health-ring--running">
        <div className="health-ring__core">
          <div className="health-ring__spinner" />
        </div>
      </div>
    )
  }
  if (state === 'done') {
    return (
      <div className="health-ring health-ring--ok">
        <div className="health-ring__core">
          <span className="health-ring__label">正常</span>
          <span className="health-ring__sub">网络健康</span>
        </div>
      </div>
    )
  }
  return (
    <div className="health-ring health-ring--idle">
      <div className="health-ring__core">
        <span className="health-ring__label">--</span>
        <span className="health-ring__sub">等待诊断</span>
      </div>
    </div>
  )
}

function CheckCard({ check, mode }: { check: DiagCheck; mode: Mode }) {
  return (
    <div className={`check-card check-card--${check.status}`}>
      <div className="check-card__header">
        <StatusDot status={check.status} />
        <span className="check-card__name">{check.name}</span>
        {check.value && <span className="check-card__value">{check.value}</span>}
      </div>
      <p className="check-card__detail">{check.detail}</p>
      {mode === 'advanced' && (
        <pre className="check-card__raw">raw data available</pre>
      )}
    </div>
  )
}

function DiagPanel({ state, mode, onStart }: { state: DiagState; mode: Mode; onStart: () => void }) {
  if (state === 'idle') {
    return (
      <div className="diag-idle">
        <HealthRing state={state} />
        <h2 className="diag-idle__title">网络诊断</h2>
        <p className="diag-idle__desc">检查网络连接、DNS、带宽等关键指标</p>
        <button className="btn btn--primary btn--lg" onClick={onStart}>
          开始诊断
        </button>
      </div>
    )
  }
  if (state === 'running') {
    return (
      <div className="diag-running">
        <HealthRing state={state} />
        <h2 className="diag-running__title">正在诊断...</h2>
        <div className="diag-running__steps">
          {mockChecks.map((c, i) => (
            <div key={i} className="diag-running__step" style={{ animationDelay: `${i * 0.3}s` }}>
              <StatusDot status="running" />
              <span>{c.name}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="diag-results">
      <div className="diag-results__header">
        <HealthRing state={state} />
        <div>
          <h2 className="diag-results__title">诊断完成</h2>
          <p className="diag-results__sub">发现 1 个潜在问题</p>
        </div>
      </div>

      <div className="check-grid">
        {mockChecks.map((c, i) => (
          <CheckCard key={i} check={c} mode={mode} />
        ))}
      </div>

      {mode === 'advanced' && (
        <div className="advanced-raw">
          <h3 className="advanced-raw__title">原始命令输出</h3>
          {advancedChecks.map((c, i) => (
            <div key={i} className={`raw-line raw-line--${c.status}`}>
              <code className="raw-line__cmd">$ {c.cmd}</code>
              <pre className="raw-line__out">{c.result}</pre>
            </div>
          ))}
        </div>
      )}

      <div className="fix-suggestions">
        <h3 className="fix-suggestions__title">建议操作</h3>
        <div className="fix-card fix-card--warn">
          <StatusDot status="warning" />
          <div>
            <p className="fix-card__title">外网延迟偏高</p>
            <p className="fix-card__desc">部分外网节点响应时间超过 100ms，可能是 ISP 高峰期或路由问题</p>
            <ul className="fix-card__steps">
              <li>重启路由器，等待 30 秒后重连</li>
              <li>尝试切换 DNS 服务器（推荐 8.8.8.8 或 1.1.1.1）</li>
              <li>如持续存在，联系 ISP 确认线路状态</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}

function GuidedPanel() {
  const [step, setStep] = useState(0)
  const steps: { q: string; options: string[] }[] = [
    {
      q: '你现在是完全不能上网，还是某些网站/App 不行？',
      options: ['完全不能上网', '部分网站打不开', '网速很慢', '时断时续'],
    },
    {
      q: '你的手机或其他设备能正常上网吗？',
      options: ['其他设备也上不了', '其他设备正常', '不确定'],
    },
    {
      q: '你用的是 Wi-Fi 还是有线连接？',
      options: ['Wi-Fi', '有线网线', '两者都有问题'],
    },
  ]

  if (step >= steps.length) {
    return (
      <div className="guided-done">
        <StatusDot status="warning" />
        <h3>根据你提供的信息，最可能的原因是：</h3>
        <div className="fix-card fix-card--warn">
          <div>
            <p className="fix-card__title">Wi-Fi 信号弱或干扰</p>
            <p className="fix-card__desc">建议靠近路由器或切换 Wi-Fi 信道</p>
          </div>
        </div>
        <button className="btn btn--ghost" onClick={() => setStep(0)}>重新开始</button>
      </div>
    )
  }

  const current = steps[step]
  return (
    <div className="guided-flow">
      <div className="guided-flow__progress">
        {steps.map((_, i) => (
          <span key={i} className={`guided-flow__dot ${i <= step ? 'guided-flow__dot--active' : ''}`} />
        ))}
      </div>
      <div className="guided-flow__q">
        <span className="guided-flow__avatar">D</span>
        <div className="guided-flow__bubble">{current.q}</div>
      </div>
      <div className="guided-flow__options">
        {current.options.map((opt, i) => (
          <button
            key={i}
            className="btn btn--outline"
            onClick={() => setStep(step + 1)}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  )
}

function ChatPanel() {
  const [msgs, setMsgs] = useState<ChatMsg[]>([
    { from: 'bot', text: '你好！我是网络诊断助手。描述你遇到的问题，我来帮你排查。', time: '23:30' },
  ])
  const [input, setInput] = useState('')

  function handleSend() {
    if (!input.trim()) return
    const userMsg: ChatMsg = { from: 'user', text: input, time: '23:31' }
    setMsgs((prev) => [...prev, userMsg])
    setInput('')
    setTimeout(() => {
      setMsgs((prev) => [
        ...prev,
        { from: 'bot', text: '我来帮你看看。先问一下，你的手机/电脑现在连着 Wi-Fi 吗？能连上但没网，还是根本连不上 Wi-Fi？', time: '23:31' },
      ])
    }, 600)
  }

  return (
    <div className="chat-panel">
      <div className="chat-panel__msgs">
        {msgs.map((m, i) => (
          <div key={i} className={`chat-msg chat-msg--${m.from}`}>
            {m.from === 'bot' && <span className="chat-msg__avatar">D</span>}
            <div className="chat-msg__body">
              <p>{m.text}</p>
              <span className="chat-msg__time">{m.time}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="chat-panel__input">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="描述你的网络问题..."
        />
        <button className="btn btn--primary" onClick={handleSend}>发送</button>
      </div>
    </div>
  )
}

function StatusBar() {
  const [time, setTime] = useState('')
  useEffect(() => {
    const tick = () => {
      const now = new Date()
      setTime(now.toLocaleTimeString('zh-CN', { hour12: false }))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="status-bar">
      <div className="status-bar__left">
        <Icon type="wifi" size={14} />
        <span>HomeNetwork</span>
        <span className="status-bar__sep">|</span>
        <span>192.168.1.100</span>
        <span className="status-bar__sep">|</span>
        <span className="status-bar__speed">
          <span className="dot dot-ok" /> 已连接
        </span>
      </div>
      <div className="status-bar__right">
        <span>{time}</span>
      </div>
    </div>
  )
}

// --- Main App ---
export default function App() {
  const [section, setSection] = useState<Section>('diagnose')
  const [mode, setMode] = useState<Mode>('basic')
  const [diagState, setDiagState] = useState<DiagState>('idle')

  const navItems: { id: Section; label: string; icon: string }[] = [
    { id: 'diagnose', label: '一键诊断', icon: 'diagnose' },
    { id: 'guided', label: '引导排查', icon: 'guided' },
    { id: 'chat', label: '智能问答', icon: 'chat' },
  ]

  function handleStartDiag() {
    setDiagState('running')
    setTimeout(() => setDiagState('done'), 3000)
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar__logo">
          <div className="sidebar__logo-icon">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
            </svg>
          </div>
          <span className="sidebar__logo-text">Lanwatch Doctor</span>
        </div>

        <nav className="sidebar__nav">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`sidebar__nav-item ${section === item.id ? 'sidebar__nav-item--active' : ''}`}
              onClick={() => { setSection(item.id); setDiagState('idle') }}
            >
              <Icon type={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar__mode">
          <button
            className={`sidebar__mode-btn ${mode === 'basic' ? 'sidebar__mode-btn--active' : ''}`}
            onClick={() => setMode('basic')}
          >
            <Icon type="basic" size={14} />
            <span>普通模式</span>
          </button>
          <button
            className={`sidebar__mode-btn ${mode === 'advanced' ? 'sidebar__mode-btn--active' : ''}`}
            onClick={() => setMode('advanced')}
          >
            <Icon type="advanced" size={14} />
            <span>专业模式</span>
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="main__header">
          <h1 className="main__title">
            {navItems.find((n) => n.id === section)?.label || ''}
          </h1>
          <span className="main__mode-tag">{mode === 'basic' ? '普通模式' : '专业模式'}</span>
        </header>

        <div className="main__content">
          {section === 'diagnose' && (
            <DiagPanel state={diagState} mode={mode} onStart={handleStartDiag} />
          )}
          {section === 'guided' && <GuidedPanel />}
          {section === 'chat' && <ChatPanel />}
        </div>
      </main>

      <StatusBar />
    </div>
  )
}
