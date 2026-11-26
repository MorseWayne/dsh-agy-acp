import type { StatusSnapshot } from '../common/types.ts'
import { isValidSnapshot } from './status-store.ts'

interface PostJsonResult {
  ok: boolean
  status?: StatusSnapshot
  error?: string
}

export async function postJson(url: string, body: Record<string, unknown>, request = fetch): Promise<PostJsonResult> {
  try {
    const res = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    let data: { status?: StatusSnapshot; error?: string } = {}
    try {
      data = (await res.json()) as { status?: StatusSnapshot; error?: string }
    } catch {
      // ignore non-JSON body
    }
    return {
      ok: res.ok,
      ...(isValidSnapshot(data.status) ? { status: data.status } : {}),
      ...(typeof data.error === 'string' && data.error.trim() ? { error: data.error.trim() } : {}),
    }
  } catch {
    return { ok: false, error: '未能连接到插件，请重试' }
  }
}

export type SessionResetTarget = { kind: 'one'; sessionKey: string } | { kind: 'all' }

/** The legacy empty-body wire command is reserved for the explicit all-sessions confirmation. */
export async function resetSessions(target: SessionResetTarget, request = fetch): Promise<{ message: string; status?: StatusSnapshot }> {
  let body: Record<string, unknown>
  let success: string
  if (target?.kind === 'all') {
    body = {}
    success = '已重置全部会话及恢复索引。'
  } else if (target?.kind === 'one' && typeof target.sessionKey === 'string' && target.sessionKey.trim()) {
    body = { sessionKey: target.sessionKey }
    success = `已关闭会话 ${target.sessionKey}`
  } else {
    return { message: '未能识别此会话，未执行关闭。' }
  }
  const res = await postJson('/plugins/agy-acp/sessions/reset', body, request)
  if (!res.ok || !res.status) return { message: '会话操作未完成，请检查插件连接后重试。' }
  return { status: res.status, message: success }
}
