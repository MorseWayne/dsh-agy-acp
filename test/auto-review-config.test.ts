import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import test from 'node:test'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { resolveConfig, sanitizePersistedConfigObject, validateConfigPatchInput } from '../src/common/config.ts'
import { PROVIDER_ID, type PluginConfig, type StatusSnapshot } from '../src/common/types.ts'
import { AcpAdapter, resolveAutoReviewRedirectOptions } from '../src/provider/adapter.ts'
import { AcpRunStore } from '../src/provider/run-store.ts'
import { fetchReviewModels } from '../src/client/panel-actions.ts'
import type { AcpSessionPool, AuxiliaryPromptParams } from '../src/runtime/session-pool.ts'
import { registerAcpRoutes, type ExactRouteSpec } from '../src/transport/sse.ts'

async function collectChunks(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const c of iterable) chunks.push(c)
  return chunks
}

test('auto-review config fields resolve, validate, and reject invalid combinations', () => {
  const defaults = resolveConfig({})
  assert.equal(defaults.autoReviewProvider, '')
  assert.equal(defaults.autoReviewModel, '')
  assert.equal(defaults.autoReviewEffort, '')

  const resolved = resolveConfig({
    autoReviewProvider: 'aisub2api',
    autoReviewModel: 'gpt-6.2-sol',
    autoReviewEffort: 'low',
  })
  assert.equal(resolved.autoReviewProvider, 'aisub2api')
  assert.equal(resolved.autoReviewModel, 'gpt-6.2-sol')
  assert.equal(resolved.autoReviewEffort, 'low')

  // Valid external provider + model
  const okExt = validateConfigPatchInput({
    autoReviewProvider: 'aisub2api',
    autoReviewModel: 'gpt-6.2-sol',
    autoReviewEffort: 'minimal',
  })
  assert.equal(okExt.ok, true)
  if (okExt.ok) {
    assert.deepEqual(okExt.patch, {
      autoReviewProvider: 'aisub2api',
      autoReviewModel: 'gpt-6.2-sol',
      autoReviewEffort: 'minimal',
    })
  }

  // External provider with explicit empty model in same patch is rejected
  const missingModel = validateConfigPatchInput({
    autoReviewProvider: 'aisub2api',
    autoReviewModel: '',
  })
  assert.equal(missingModel.ok, false)

  // Internal provider (empty or antigravity-acp) allows empty model (follow conversation model)
  assert.equal(validateConfigPatchInput({ autoReviewProvider: '', autoReviewModel: '' }).ok, true)
  assert.equal(validateConfigPatchInput({ autoReviewProvider: PROVIDER_ID, autoReviewModel: '' }).ok, true)

  // Invalid characters rejected
  assert.equal(validateConfigPatchInput({ autoReviewProvider: 'bad provider!' }).ok, false)
  assert.equal(validateConfigPatchInput({ autoReviewEffort: 'invalid effort!' }).ok, false)

  // Sanitization drops corrupted fields while retaining valid ones
  const sanitized = sanitizePersistedConfigObject({
    autoReviewProvider: 'bad provider!',
    autoReviewModel: 'gemini-3-flash',
    autoReviewEffort: 'low',
  })
  assert.deepEqual(sanitized, {
    autoReviewModel: 'gemini-3-flash',
    autoReviewEffort: 'low',
  })
})

test('resolveAutoReviewRedirectOptions redirects only antigravity-acp auto-review requests to external providers', () => {
  const baseOpts = {
    provider: PROVIDER_ID,
    model: 'gemini-4-neon',
    purpose: 'auto-review',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'check' }] }],
  } as unknown as GenerateOptions

  const extCfg = resolveConfig({
    enabled: true,
    autoReviewProvider: 'aisub2api',
    autoReviewModel: 'gpt-6.2-sol',
    autoReviewEffort: '',
  })
  const redirected = resolveAutoReviewRedirectOptions(baseOpts, extCfg)
  assert.ok(redirected)
  assert.equal(redirected.provider, 'aisub2api')
  assert.equal(redirected.model, 'gpt-6.2-sol')
  assert.equal(redirected.reasoningEffort, undefined)

  // Explicit effort is forwarded
  const withEffort = resolveAutoReviewRedirectOptions(baseOpts, { ...extCfg, autoReviewEffort: 'low' })
  assert.equal(withEffort?.reasoningEffort, 'low')

  // Non-auto-review purposes and normal turns are never redirected
  assert.equal(resolveAutoReviewRedirectOptions({ ...baseOpts, purpose: 'session-title' } as unknown as GenerateOptions, extCfg), null)
  assert.equal(resolveAutoReviewRedirectOptions({ ...baseOpts, purpose: undefined } as unknown as GenerateOptions, extCfg), null)

  // Already redirected (different provider) must not loop
  assert.equal(resolveAutoReviewRedirectOptions({ ...baseOpts, provider: 'aisub2api' } as unknown as GenerateOptions, extCfg), null)

  // Internal provider or missing model stays on ACP adapter
  assert.equal(resolveAutoReviewRedirectOptions(baseOpts, { ...extCfg, autoReviewProvider: '' }), null)
  assert.equal(resolveAutoReviewRedirectOptions(baseOpts, { ...extCfg, autoReviewProvider: PROVIDER_ID }), null)
  assert.equal(resolveAutoReviewRedirectOptions(baseOpts, { ...extCfg, autoReviewModel: '' }), null)
  assert.equal(resolveAutoReviewRedirectOptions(baseOpts, { ...extCfg, enabled: false }), null)
})

test('AcpAdapter.stream applies autoReviewModel/autoReviewEffort and auto-lowers effort for internal ACP auto-review', async () => {
  const calls: AuxiliaryPromptParams[] = []
  let cfg: PluginConfig = resolveConfig({ enabled: true })

  const mockPool = {
    runAuxiliaryPrompt: async (params: AuxiliaryPromptParams) => {
      calls.push(params)
      params.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"risk":"low","decision":"allow"}' } })
      return { stopReason: 'end_turn' }
    },
  } as unknown as AcpSessionPool

  const adapter = new AcpAdapter({
    getConfig: () => cfg,
    pool: mockPool,
    runs: new AcpRunStore(),
  })

  // 1. Default auto-review: follows session model and sets preferLowestEffort=true
  await collectChunks(
    adapter.stream({
      provider: PROVIDER_ID,
      model: 'gemini-4-neon',
      purpose: 'auto-review',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'review' }] }],
    } as unknown as GenerateOptions),
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.model, 'gemini-4-neon')
  assert.equal(calls[0]!.effort, undefined)
  assert.equal(calls[0]!.preferLowestEffort, true)

  // 2. Configured internal autoReviewModel + autoReviewEffort overrides model/effort
  cfg = resolveConfig({
    enabled: true,
    autoReviewProvider: '',
    autoReviewModel: 'gemini-3-flash',
    autoReviewEffort: 'low',
  })
  await collectChunks(
    adapter.stream({
      provider: PROVIDER_ID,
      model: 'gemini-4-neon',
      purpose: 'auto-review',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'review' }] }],
    } as unknown as GenerateOptions),
  )
  assert.equal(calls.length, 2)
  assert.equal(calls[1]!.model, 'gemini-3-flash')
  assert.equal(calls[1]!.effort, 'low')
  assert.equal(calls[1]!.preferLowestEffort, false)

  // 3. Non-auto-review auxiliary call (session-title) ignores autoReviewModel and preferLowestEffort
  await collectChunks(
    adapter.stream({
      provider: PROVIDER_ID,
      model: 'gemini-4-neon',
      purpose: 'session-title',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'title' }] }],
    } as unknown as GenerateOptions),
  )
  assert.equal(calls.length, 3)
  assert.equal(calls[2]!.model, 'gemini-4-neon')
  assert.equal(calls[2]!.effort, undefined)
  assert.equal(calls[2]!.preferLowestEffort, false)
})

test('HTTP routes serve /plugins/agy-acp/review-models and enforce cross-field external review validation', async () => {
  const routes = new Map<string, ExactRouteSpec['handler']>()
  const webServer = {
    register(route: ExactRouteSpec) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }

  let cfg = resolveConfig({ enabled: true })
  const emitter = new EventEmitter()
  const fakePool = Object.assign(emitter, {
    getStatus(): StatusSnapshot {
      return {
        providerId: PROVIDER_ID,
        enabled: cfg.enabled,
        connected: false,
        agentName: null,
        agentVersion: null,
        tierName: null,
        activeSessions: 0,
        sessions: [],
        mcpBridgeActive: false,
        usageTotals: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, reasoningTokens: 0 },
        accounts: [],
        models: [{ value: 'gemini-3-flash', name: 'Gemini 3 Flash', efforts: ['low', 'medium'] }],
        reviewProviders: [
          { id: PROVIDER_ID, name: 'Antigravity (ACP)' },
          { id: 'aisub2api', name: 'AISub2API' },
        ],
        config: {
          agyBin: cfg.agyBin,
          workspaceRoot: cfg.workspaceRoot,
          defaultModel: cfg.defaultModel,
          defaultEffort: cfg.defaultEffort,
          autoReviewProvider: cfg.autoReviewProvider,
          autoReviewModel: cfg.autoReviewModel,
          autoReviewEffort: cfg.autoReviewEffort,
          mcpBridge: cfg.mcpBridge,
          sessionIdleTtlMs: cfg.sessionIdleTtlMs,
          requestTimeoutMs: cfg.requestTimeoutMs,
          geoFenceMode: cfg.geoFenceMode,
        },
        lastError: null,
        updatedAt: 1,
      }
    },
    async updateConfig(patch: Partial<PluginConfig>) {
      cfg = { ...cfg, ...patch }
    },
    async resetConfig() {
      cfg = resolveConfig({ enabled: true })
    },
  }) as unknown as AcpSessionPool

  const dispose = registerAcpRoutes(webServer, fakePool, {
    listReviewModels: async (provider) => {
      if (provider === 'aisub2api') return [{ id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' }]
      return null
    },
  })

  const invoke = async (method: string, url: string, body?: unknown) => {
    const pathname = new URL(url, 'http://127.0.0.1').pathname
    const handler = routes.get(pathname)
    assert.ok(handler, `missing route ${pathname}`)
    const req = new EventEmitter() as IncomingMessage
    req.method = method
    req.url = url
    req.headers = body !== undefined ? { 'content-type': 'application/json' } : {}
    let statusCode = 200
    let payload = ''
    const res = {
      writeHead(code: number) { statusCode = code; return this },
      end(chunk?: string) { if (chunk) payload += chunk; return this },
    } as unknown as ServerResponse
    const p = Promise.resolve(handler(req, res))
    if (body !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    }
    req.emit('end')
    await p
    return { statusCode, json: JSON.parse(payload) as Record<string, unknown> }
  }

  try {
    // 1. External review models endpoint
    const extModels = await invoke('GET', '/plugins/agy-acp/review-models?provider=aisub2api')
    assert.equal(extModels.statusCode, 200)
    assert.deepEqual(extModels.json.models, [{ id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' }])

    // 2. Internal ACP models endpoint
    const acpModels = await invoke('GET', `/plugins/agy-acp/review-models?provider=${PROVIDER_ID}`)
    assert.equal(acpModels.statusCode, 200)
    assert.deepEqual(acpModels.json.models, [{ id: 'gemini-3-flash', name: 'Gemini 3 Flash' }])

    // 3. Unknown provider returns 404
    const missing = await invoke('GET', '/plugins/agy-acp/review-models?provider=unknown-provider')
    assert.equal(missing.statusCode, 404)

    // 4. Partial config patch setting external provider without model is rejected
    const badPatch = await invoke('POST', '/plugins/agy-acp/config', { autoReviewProvider: 'aisub2api' })
    assert.equal(badPatch.statusCode, 400)

    // 5. Complete external review config succeeds and reflects in status
    const okPatch = await invoke('POST', '/plugins/agy-acp/config', {
      autoReviewProvider: 'aisub2api',
      autoReviewModel: 'gpt-6.2-sol',
      autoReviewEffort: 'low',
    })
    assert.equal(okPatch.statusCode, 200)
    assert.equal(cfg.autoReviewProvider, 'aisub2api')
    assert.equal(cfg.autoReviewModel, 'gpt-6.2-sol')
    assert.equal(cfg.autoReviewEffort, 'low')
  } finally {
    dispose()
  }
})

test('fetchReviewModels parses valid model options and handles errors gracefully', async () => {
  const ok = await fetchReviewModels('aisub2api', async (url) => {
    assert.equal(url, '/plugins/agy-acp/review-models?provider=aisub2api')
    return {
      ok: true,
      json: async () => ({
        models: [
          { id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' },
          { id: '', name: 'Broken' },
        ],
      }),
    } as Response
  })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.models, [{ id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' }])

  const fail = await fetchReviewModels('missing', async () => ({
    ok: false,
    json: async () => ({ error: '未找到已注册的 Provider' }),
  }) as Response)
  assert.equal(fail.ok, false)
  assert.deepEqual(fail.models, [])
  assert.equal(fail.error, '未找到已注册的 Provider')
})
