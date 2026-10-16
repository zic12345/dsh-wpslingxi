/**
 * dsh-wpslingxi 客户端插件（浏览器侧）。
 *
 * 按用户要求，灵犀的设置**不占左侧独立图标**，而是收纳进 DSH 自带的
 * 「设置 → 插件（Plugins）」页：在该页的插件 Tab 里追加一个以本插件命名的
 * Tab（`settings.plugins.tab` 槽位），内容即智点余额 + 每日签到面板。
 *
 * 槽位机制（见 @deepseek-ai/dsh-client-ui-settings-plugins）：
 * - 内置「插件」设置区（settings.section id='plugins'）渲染所有
 *   `settings.plugins.tab` 注册项为 Tab；
 * - 各插件用 `id` 作为 Tab key、`label` 作为 Tab 标题、`order` 排序，
 *   组件在对应 tabpanel 内挂载；connection 经 register 的 inject 面注入；
 * - 注册经 `ctx.slots.inject(...)`：拥有槽位的条目就绪后才回调，
 *   外壳不提供该槽位时静默缺席，不拖垮 GUI 启动。
 *
 * 页面与宿主通信走 connection.rpc（/api/wpslingxi），见 panel.jsx / rpc.js。
 */
import * as React from 'react'
import { WpsLingxiPanel } from './panel.jsx'

export const name = 'dsh-wpslingxi-client'

/**
 * 需要的服务（fiber inject：等运行时就绪后才 apply）。
 * - slots：槽位注册表（renderer 拥有）；
 * - connection：调宿主 /api/wpslingxi RPC；
 * 不再需要 layout（已不注册中栏 main 面板/侧边栏图标）。
 */
export const inject = ['slots', 'connection']

/** 插件设置 Tab 的 id（槽位 list 内唯一即可）。 */
export const SETTINGS_TAB_ID = 'dsh-wpslingxi'

/** Tab 排序：内置「全部插件」清单是 order 10，本插件排在其后。 */
const TAB_ORDER = 100

/** 挂进插件设置页的页面组件；connection 由 register 的 inject 面注入。 */
function WpsLingxiSettingsPage({ connection }) {
  return <WpsLingxiPanel connection={connection} />
}

export function apply(ctx) {
  const slots = ctx.slots

  // 设置 → 插件 → 「WPS 灵犀」Tab。
  slots.inject('settings.plugins.tab', () =>
    slots.register(
      {
        name: 'settings.plugins.tab',
        id: SETTINGS_TAB_ID,
        order: TAB_ORDER,
        label: () => 'WPS 灵犀',
        inject: () => ({ connection: ctx.connection }),
      },
      WpsLingxiSettingsPage,
    ),
  )
}
