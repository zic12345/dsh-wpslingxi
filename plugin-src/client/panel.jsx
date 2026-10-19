/**
 * 「WPS 灵犀」设置面板：智点余额 + 一键每日签到 + 积分明细/到期预警。
 *
 * 纯 React + 内联样式实现，避免依赖 dsh-client-ui-primitives 的具体导出
 * （不同版本可用图标名会变；内联样式保证面板在各版本都能渲染）。
 *
 * 数据全部来自宿主 RPC（/api/wpslingxi）：
 * - credits.balance  余额
 * - credits.detail   赠送池有效期 + 近3天到期统计 + 最近流水
 * - checkin.status   签到状态
 * - checkin.claim    一键签到
 */
import * as React from 'react'
import { callWpsLingxi } from './rpc.js'

const COLORS = {
  primary: '#1a73e8',
  primaryDark: '#1558b0',
  text: 'var(--dsh-color-text, #1f2329)',
  sub: 'var(--dsh-color-text-secondary, #8a8f99)',
  border: 'var(--dsh-color-border, #e5e6eb)',
  bg: 'var(--dsh-color-bg, transparent)',
  card: 'var(--dsh-color-bg-raised, #f7f8fa)',
  danger: '#d93026',
  warning: '#e8871e',
  success: '#1a9c53',
}

/** 简单的卡片容器。 */
function Card({ children, style }) {
  return (
    <div
      style={{
        background: COLORS.card,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 12,
        padding: 16,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/** 主面板（挂在「设置 → 插件 → WPS 灵犀」Tab 内，inject 注入 { connection }）。 */
export function WpsLingxiPanel({ connection }) {
  const [balance, setBalance] = React.useState(null)
  const [detail, setDetail] = React.useState(null)
  const [checkin, setCheckin] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [claiming, setClaiming] = React.useState(false)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')

  const refresh = React.useCallback(async () => {
    if (!connection) {
      setError('连接服务不可用（connection 缺失），无法与宿主通信。')
      setLoading(false)
      return
    }
    setError('')
    try {
      const [bal, det, status] = await Promise.all([
        callWpsLingxi(connection, 'credits.balance', {}),
        callWpsLingxi(connection, 'credits.detail', {}).catch(() => null),
        callWpsLingxi(connection, 'checkin.status', {}),
      ])
      setBalance(bal)
      setDetail(det)
      setCheckin(status)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setLoading(false)
    }
  }, [connection])

  React.useEffect(() => {
    refresh()
  }, [refresh])

  /**
   * 一键签到。
   *
   * 【交互修复】按钮**不**在「今日已签到」后禁用：用户仍可点击以刷新状态、
   * 查看连签天数与今日奖励（host 侧 claimDailyCheckIn 对已签到是幂等的，
   * 返回 alreadyClaimed=true，不会重复领奖）。
   */
  const onClaim = React.useCallback(async () => {
    setClaiming(true)
    setError('')
    setNotice('')
    try {
      const result = await callWpsLingxi(connection, 'checkin.claim', {})
      if (result.alreadyClaimed) {
        setNotice(`今天已经签到过了（连签第 ${result.todayDay} 天），本次不重复领取。`)
      } else {
        setNotice(`签到成功！获得 ${result.rewardAmount} 智点（连签第 ${result.todayDay} 天）。`)
      }
      // 领奖后刷新余额与明细。
      await refresh()
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setClaiming(false)
    }
  }, [connection, refresh])

  return (
    <div
      style={{
        // 设置页 Tab 容器自带标题与滚动；这里不锁死高度，避免双滚动条。
        maxWidth: 620,
        padding: '4px 0 24px',
        color: COLORS.text,
        fontSize: 14,
        lineHeight: 1.6,
        boxSizing: 'border-box',
      }}
    >
      <div style={{ color: COLORS.sub, marginBottom: 16 }}>
        数据来自 Windows 宿主上已登录的「WPS 灵犀」桌面版，模型对话也使用同一份登录态。
      </div>

      {loading && <Card>正在读取灵犀账号信息…</Card>}

      {!loading && error && (
        <Card style={{ borderColor: COLORS.danger, color: COLORS.danger }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>暂时无法连接灵犀</div>
          <div style={{ color: COLORS.text, whiteSpace: 'pre-wrap' }}>{error}</div>
          <button style={buttonStyle('secondary')} onClick={refresh}>重试</button>
        </Card>
      )}

      {!loading && !error && (
        <>
          {/* 余额卡片 */}
          <Card style={{ marginBottom: 14 }}>
            <div style={{ color: COLORS.sub, fontSize: 12 }}>当前智点余额</div>
            <div style={{ fontSize: 34, fontWeight: 700, margin: '2px 0' }}>
              {balance ? formatNumber(balance.totalBalance) : '—'}
            </div>
            {balance && balance.totalPurchased > 0 && (
              <div style={{ color: COLORS.sub, fontSize: 12 }}>
                其中赠送 {formatNumber(balance.totalBonus)} · 购买 {formatNumber(balance.totalPurchased)}
              </div>
            )}

            {/* 近3天到期预警 */}
            {detail && detail.expiringSoonTotal > 0 && (
              <div
                style={{
                  marginTop: 10,
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: 'rgba(232,135,30,0.1)',
                  color: COLORS.warning,
                  fontSize: 13,
                }}
              >
                ⚠️ 近 {detail.expiringWindowDays} 天将到期智点：
                <strong> {formatNumber(detail.expiringSoonTotal)}</strong>
                （{detail.expiringSoon.length} 笔），请及时使用。
              </div>
            )}
          </Card>

          {/* 签到卡片 */}
          <Card style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 600 }}>每日签到</div>
                {checkin && (
                  <div style={{ color: COLORS.sub, fontSize: 12, marginTop: 2 }}>
                    已连签 {checkin.consecutiveDays} 天 · 今日奖励 {checkin.todayReward} 智点
                  </div>
                )}
              </div>
              {/*
                修复点：不再 disabled={checkin?.claimedToday}。已签到后按钮仍可点击，
                点击会走一次幂等查询并刷新状态/给提示，避免「签完就没有任何可点的东西」。
              */}
              <button
                style={buttonStyle(checkin?.claimedToday ? 'secondary' : 'primary')}
                disabled={claiming}
                onClick={onClaim}
              >
                {claiming ? '查询中…' : checkin?.claimedToday ? '今日已签到（点击刷新）' : '一键签到'}
              </button>
            </div>
            {notice && (
              <div
                style={{
                  marginTop: 10,
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: 'rgba(26,156,83,0.1)',
                  color: COLORS.success,
                  fontSize: 13,
                }}
              >
                {notice}
              </div>
            )}
            {checkin?.days?.length > 0 && <CheckInDays days={checkin.days} />}
          </Card>

          {/* 积分明细：赠送池有效期清单 */}
          {detail && detail.bonusPools.length > 0 && (
            <Card style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>
                赠送智点明细（{detail.bonusPools.length} 笔，按到期先后排序）
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {detail.bonusPools.map((pool, idx) => (
                  <PoolRow key={idx} pool={pool} windowDays={detail.expiringWindowDays} />
                ))}
              </div>
            </Card>
          )}

          {/* 最近流水 */}
          {detail && detail.recentTransactions.length > 0 && (
            <Card style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>最近积分流水</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {detail.recentTransactions.slice(0, 12).map((tx, idx) => (
                  <TxRow key={idx} tx={tx} />
                ))}
              </div>
            </Card>
          )}

          <button style={buttonStyle('secondary')} onClick={refresh}>刷新</button>
        </>
      )}
    </div>
  )
}

/** 一笔赠送池的展示行：余额 + 到期倒计时。 */
function PoolRow({ pool, windowDays }) {
  const soon = pool.balance > 0 && daysUntil(pool.expireTime) <= windowDays
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontSize: 13,
        padding: '6px 8px',
        borderRadius: 6,
        background: soon ? 'rgba(232,135,30,0.08)' : 'transparent',
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600, color: soon ? COLORS.warning : COLORS.text }}>
          {formatNumber(pool.balance)} 智点
        </div>
        <div style={{ color: COLORS.sub, fontSize: 12 }}>
          入账 {formatShortDate(pool.effectTime)} · 到期 {formatShortDate(pool.expireTime)}
          {soon && pool.balance > 0 ? `（${daysUntil(pool.expireTime)} 天后到期）` : ''}
          {pool.balance <= 0 ? '（已用完）' : ''}
        </div>
      </div>
    </div>
  )
}

/** 一笔流水的展示行。 */
function TxRow({ tx }) {
  const isIncome = tx.amount >= 0
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
      <div style={{ minWidth: 0, flex: 1, paddingRight: 12 }}>
        <div
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={tx.taskName}
        >
          {tx.taskName || tx.remark || (isIncome ? '智点赠送' : '消费')}
        </div>
        <div style={{ color: COLORS.sub, fontSize: 12 }}>
          {formatDateTime(tx.time)}
          {tx.source ? ` · ${tx.source}` : ''}
        </div>
      </div>
      <div style={{ fontWeight: 600, color: isIncome ? COLORS.success : COLORS.text }}>
        {isIncome ? '+' : ''}{formatNumber(tx.amount)}
      </div>
    </div>
  )
}

/** 连签日历（7 格）。 */
function CheckInDays({ days }) {
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
      {days.map((day) => (
        <div
          key={day.day}
          title={`${day.date} · ${day.reward} 智点`}
          style={{
            width: 40,
            padding: '6px 0',
            textAlign: 'center',
            borderRadius: 8,
            border: `1px solid ${day.status === 'claimed' ? COLORS.success : COLORS.border}`,
            background: day.status === 'claimed' ? 'rgba(26,156,83,0.08)' : 'transparent',
            color: day.status === 'locked' ? COLORS.sub : COLORS.text,
            fontSize: 12,
          }}
        >
          <div>第{day.day}天</div>
          <div style={{ fontWeight: 600 }}>{day.reward}</div>
        </div>
      ))}
    </div>
  )
}

/* --------------------------------- 工具函数 --------------------------------- */

function buttonStyle(kind) {
  const base = {
    border: 'none',
    borderRadius: 8,
    padding: '8px 16px',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: 10,
  }
  if (kind === 'primary') {
    return { ...base, background: COLORS.primary, color: '#fff' }
  }
  return {
    ...base,
    background: 'transparent',
    color: COLORS.sub,
    border: `1px solid ${COLORS.border}`,
  }
}

function formatNumber(value) {
  try {
    return Number(value).toLocaleString('zh-CN')
  } catch {
    return String(value)
  }
}

/** ISO 时间 → 'MM-DD HH:mm'（本地时区）。 */
function formatDateTime(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const p = (n) => String(n).padStart(2, '0')
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  } catch {
    return iso
  }
}

/** ISO 时间 → 'YYYY-MM-DD'（本地时区）。 */
function formatShortDate(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  } catch {
    return iso
  }
}

/** 距离到期还有几天（向下取整；负数表示已过期）。 */
function daysUntil(iso) {
  if (!iso) return Infinity
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return Infinity
  return Math.floor((ms - Date.now()) / (24 * 60 * 60 * 1000))
}

/** 把宿主错误翻译成可操作的中文提示。 */
function friendlyError(err) {
  const code = err?.code || ''
  const message = err?.message || String(err)
  if (code === 'UNAUTHORIZED') {
    return '灵犀登录态已失效，请在 Windows 宿主打开「WPS 灵犀」桌面版重新登录后再点刷新。'
  }
  if (code === 'NOT_WSL' || /not.*wsl|非 WSL/i.test(message)) {
    return '当前 DSH 不在 WSL 中运行，无法读取 Windows 宿主的灵犀登录态。'
  }
  if (code === 'NETWORK') {
    return `网络不可达：${message}\n请确认 WSL 能访问 https://lingxi.wps.cn 且宿主联网。`
  }
  if (/cookie|DPAPI|Cookies|encrypted/i.test(message)) {
    return `读取桌面登录态失败：${message}\n请确认已安装并登录「WPS 灵犀」桌面版。`
  }
  return message
}
