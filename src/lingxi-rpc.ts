/**
 * 宿主侧管理 RPC：把「每日签到 / 余额 / 状态」暴露给左侧插件面板。
 *
 * 复用 DSH 的 connection.fetch 通道（与 codearts 母插件的 jet-hub RPC 同构）：
 *
 * - Host：`connection.fetch.register({ path:'/api/wpslingxi', methods:['POST'] })`；
 * - Client：`connection.rpc.call('/api', 'wpslingxi', { method, payload })`；
 * - 请求包络 `{ type:'client-request', rpcId, method:'wpslingxi',
 *    payload:{ method, payload } }`，响应 `{ type:'server-response', rpcId, result }`，
 *    result 统一为 `{ ok:true, value } | { ok:false, error:{ code, message } }`。
 *
 * 方法：
 * - `credits.balance`  → 智点余额；
 * - `checkin.status`   → 每日签到状态（不领奖）；
 * - `checkin.claim`    → 一键签到领奖（今天已签则返回 alreadyClaimed）。
 *
 * 三个方法都在调用时**实时提取桌面 SID**：cookie 失效（401）时强制重新从
 * Windows 登录态解密一次，避免面板长期持有过期 SID。
 */
import type { Context } from '@deepseek-ai/cordis'
import { extractWpsSid } from './lingxi-credential.js'
import { detectWsl, type WslEnvironment } from './lingxi-win32.js'
import {
  claimDailyCheckIn,
  getCreditsBalance,
  getDailyCheckIn,
  LingxiCloudError,
} from './lingxi-cloud.js'

const API_PATH = '/api/wpslingxi'
const ENDPOINT = 'wpslingxi'

/** 面板需要的环境前提探测结果（首包返回，供前端给出未就绪原因）。 */
export interface LingxiAvailability {
  readonly available: boolean
  readonly reason?: string
}

/** connection.fetch 的最小结构（dsh-client-connection 提供）。 */
interface FetchRegistry {
  register(options: {
    path: string
    methods: string[]
    requestBody: 'buffered'
    fetch(request: Request): Promise<Response>
  }): void
}

/** 统一成功/失败包络。 */
type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

/** 构造标准 RPC 响应。 */
function reply(rpcId: string, result: RpcResult<unknown>): Response {
  return Response.json({ type: 'server-response', rpcId, result })
}

/** 把任意异常规整成错误包络；401 用专门 code 让前端可提示重新登录。 */
function toErrorEnvelope(error: unknown): RpcResult<never> {
  if (error instanceof LingxiCloudError) {
    return {
      ok: false,
      error: {
        code: error.isUnauthorized ? 'UNAUTHORIZED' : (error.code ?? 'CLOUD_ERROR'),
        message: error.message,
      },
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, error: { code: 'LINGXI_ERROR', message } }
}

/**
 * 注册管理 RPC。在非 WSL / 无 connection 服务时静默跳过（面板会显示不可用原因）。
 */
export function registerLingxiRpc(ctx: Context, env?: WslEnvironment): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connection = (ctx as any).connection ?? safeGet(ctx)
  if (!connection || typeof connection.fetch?.register !== 'function') {
    ctx.logger?.warn?.('[lingxi] connection.fetch 不可用，签到/余额 RPC 未注册')
    return
  }
  const fetchRegistry = connection.fetch as FetchRegistry

  /** 实时取 SID（不做长缓存；credential 模块内部有进程缓存，401 时强制刷新）。 */
  async function resolveSid(force = false): Promise<string> {
    const environment = env ?? detectWsl()
    if (!environment) {
      throw new LingxiCloudError('当前不是 WSL 环境，无法读取 Windows 宿主的灵犀登录态', 0, 'NOT_WSL')
    }
    return extractWpsSid(environment, force)
  }

  /** 分派单个业务方法。 */
  async function handle(method: string): Promise<RpcResult<unknown>> {
    try {
      if (method === 'credits.balance') {
        const sid = await resolveSid()
        try {
          return { ok: true, value: await getCreditsBalance(sid) }
        } catch (error) {
          if (error instanceof LingxiCloudError && error.isUnauthorized) {
            return { ok: true, value: await getCreditsBalance(await resolveSid(true)) }
          }
          throw error
        }
      }

      if (method === 'checkin.status') {
        const sid = await resolveSid()
        try {
          return { ok: true, value: await getDailyCheckIn(sid) }
        } catch (error) {
          if (error instanceof LingxiCloudError && error.isUnauthorized) {
            return { ok: true, value: await getDailyCheckIn(await resolveSid(true)) }
          }
          throw error
        }
      }

      if (method === 'checkin.claim') {
        const sid = await resolveSid()
        try {
          return { ok: true, value: await claimDailyCheckIn(sid) }
        } catch (error) {
          if (error instanceof LingxiCloudError && error.isUnauthorized) {
            return { ok: true, value: await claimDailyCheckIn(await resolveSid(true)) }
          }
          throw error
        }
      }

      return { ok: false, error: { code: 'UNKNOWN_METHOD', message: `未知方法：${method}` } }
    } catch (error) {
      ctx.logger?.warn?.(`[lingxi] RPC ${method} 失败：${(error as Error).message}`)
      return toErrorEnvelope(error)
    }
  }

  fetchRegistry.register({
    path: API_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request: Request): Promise<Response> {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
      const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let message: Record<string, unknown>
      try {
        message = (await request.json()) as Record<string, unknown>
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
      const call = message.payload as Record<string, unknown> | undefined
      if (
        message.type !== 'client-request'
        || typeof message.rpcId !== 'string'
        || message.method !== ENDPOINT
        || !call
        || typeof call.method !== 'string'
        || !Object.prototype.hasOwnProperty.call(call, 'payload')
      ) {
        return reply(rpcId, {
          ok: false,
          error: { code: 'bad-request', message: 'Invalid wps-lingxi management request.' },
        })
      }

      const result = await handle(call.method)
      return reply(rpcId, result)
    },
  })

  ctx.logger?.info?.('[lingxi] 签到/余额管理 RPC 已注册（/api/wpslingxi）')
}

/** 宽松取 connection 服务（避免对未导出类型做强依赖）。 */
function safeGet(ctx: Context): { fetch?: FetchRegistry } | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (ctx as any).get?.('connection') as { fetch?: FetchRegistry } | undefined
  } catch {
    return undefined
  }
}
