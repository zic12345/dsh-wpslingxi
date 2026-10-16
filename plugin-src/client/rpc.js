/**
 * 调用宿主侧 /api/wpslingxi 管理 RPC。
 *
 * 与 codearts 母插件的 management-rpc 同构：
 * connection.rpc.call('/api', 'wpslingxi', { method, payload })。
 * 返回 { ok, value?, error? }；本函数在 ok=false 时抛错。
 */
export async function callWpsLingxi(connection, method, payload, signal) {
  const result = await connection.rpc.call(
    '/api',
    'wpslingxi',
    { method, payload: payload ?? {} },
    signal,
  )
  if (result && result.ok === true) return result.value
  if (result && result.ok === false) {
    const error = new Error(result.error?.message || '灵犀管理接口请求失败')
    error.code = result.error?.code
    throw error
  }
  // 某些连接实现直接解包为 value。
  return result
}
