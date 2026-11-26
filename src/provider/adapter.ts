import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId, type ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { AcpProcessExitError, AcpRpcError, AcpTimeoutError } from '../acp/client.ts'
import type { AcpToolCallUpdate } from '../acp/protocol.ts'
import {
  createTurnOutcomeWatcher,
  evaluateInlineWarningFallback,
  extractResetAtMs,
  isInvalidThinkingSignatureError,
} from '../acp/turn-outcome.ts'
import { mapContextUsage } from '../acp/usage.ts'
import { callUsageToTokenUsage, TranscriptUsageTailer } from '../acp/transcript-usage.ts'
import { defaultEffort, effortLabel } from '../common/effort.ts'
import { isGeoUnsupportedError } from '../common/geo.ts'
import {
  MIRROR_TOOL_NAME,
  PROVIDER_ID,
  WRAPPER_TOOL_NAME,
  type PluginConfig,
} from '../common/types.ts'
import { isQuotaOrRateLimitError, isTosViolationError } from '../runtime/account-pool.ts'
import { policyKey, SessionPolicyChangedError } from '../runtime/permission-manager.ts'
import { EgressBlockedError } from '../runtime/egress-guard.ts'
import type { AcpSessionPool, ManagedAcpSession } from '../runtime/session-pool.ts'
import { createPreEditLocator, compactDisplayInput } from './mirror-tool.ts'
import {
  buildAuxiliaryPromptBlocks,
  buildPromptBlocksWithAttachments,
  type ReadPromptImage,
  type ReadPromptFile,
  buildSystemPromptBlock,
  prepareAuxiliarySystemPrompt,
  prepareSystemPrompt,
  type PromptMessage,
} from './prompt-builder.ts'
import {
  AcpRunRecording,
  decodeMirrorCallId,
  encodeMirrorCallId,
  normalizeLocations,
  type AcpRunStore,
  type MergedToolCall,
} from './run-store.ts'

export interface AcpAdapterDeps {
  getConfig: () => PluginConfig
  pool: AcpSessionPool
  runs: AcpRunStore
  readImage?: ReadPromptImage
  readFileStream?: ReadPromptFile
  log?: (msg: string) => void
}

export class AcpAdapter extends LlmAdapter {
  constructor(private readonly deps: AcpAdapterDeps) {
    super()
  }

  private inputModalities(): ('text' | 'image')[] {
    return this.deps.readImage && this.deps.pool.supportsImageInput() ? ['text', 'image'] : ['text']
  }

  override providerInfo(_provider: string): LlmProviderInfo {
    return { id: PROVIDER_ID, name: 'Antigravity (ACP)' }
  }

  override async listModels(_provider: string): Promise<LlmModelInfo[]> {
    const models = await this.deps.pool.refreshModels()
    return models.filter(m => !m.variantOf).map((m) => ({
      provider: PROVIDER_ID, id: m.value, name: m.name, inputModalities: this.inputModalities(),
    }))
  }

  override async resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const models = await this.deps.pool.refreshModels().catch(() => [])
    const matched = models.find((m) => m.value === model)
    const contextWindow = this.deps.pool.contextWindowFor(model)
    const effort = defaultEffort(matched, this.deps.getConfig().defaultEffort)
    return {
      provider: PROVIDER_ID,
      id: model,
      name: matched?.name ?? model,
      inputModalities: this.inputModalities(),
      ...(contextWindow ? { context: { contextWindow } } : {}),
      ...(matched && effort
        ? {
            reasoning: {
              defaultEffort: ReasoningEffortId(effort),
              efforts: matched.efforts.map((e) => ({
                id: ReasoningEffortId(e),
                name: effortLabel(e),
              })),
            },
          }
        : {}),
    }
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: LlmResolvedModelInfo
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  }> {
    if (signal?.aborted) throw signal.reason ?? new LlmError('aborted', 'ABORTED')
    const modelInfo = await this.resolveModel(provider, model)
    return {
      model: modelInfo,
      stream: (options) => this.stream({ ...options, signal: options.signal ?? signal }),
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const cfg = this.deps.getConfig()
    if (!cfg.enabled) {
      throw new LlmError('dsh-agy-acp is disabled by config', 'PROVIDER_DISABLED')
    }

    if (options.purpose) {
      yield* this.streamAuxiliary(options)
      return
    }

    const sessionKey = options.sessionId
    if (!sessionKey) {
      throw new Error('Antigravity requires an identified DSH conversation turn; auxiliary calls cannot execute native tools')
    }

    const hasMirrorTool = Boolean(options.tools?.some((t) => t.name === MIRROR_TOOL_NAME))
    const isCodeMode = Boolean(options.tools?.some((t) => t.name === WRAPPER_TOOL_NAME)) && !hasMirrorTool
    const cutOnTool = hasMirrorTool || isCodeMode

    // 1. Continuation span: DSH just executed `agy_acp_tool` and is resuming the same ACP turn.
    const continuation = detectContinuation(options.messages as readonly ContinuationMessage[])
    let messages = options.messages as readonly PromptMessage[]
    let recoveryPolicy: string | undefined
    if (continuation) {
      const rec = this.deps.runs.get(continuation.runId)
      if (rec && rec.owner === sessionKey) {
        const callId = encodeMirrorCallId(rec.id, continuation.itemIndex)
        const callIndex = options.messages.findLastIndex(m => m.role === 'assistant' &&
          m.content.some(b => b.type === 'tool-call' && b.id === callId))
        if (callIndex >= 0 && !options.signal?.aborted && !cfg.mcpBridge && this.deps.runs.isLatestForOwner(rec)) {
          recoveryPolicy = rec.claimApprovalRecovery(continuation.itemIndex)
        }
        if (recoveryPolicy && policyKey(this.deps.pool.policy(sessionKey)) === recoveryPolicy) {
          // Keep the original user input (including images). The interrupted tool never produced a result.
          rec.releaseRecording()
          messages = messages.slice(0, callIndex)
          this.deps.log?.(`recreating ACP session "${sessionKey}" after interrupted approval (retry 1/1)`)
        } else {
          const onContAbort = () => rec.requestCancel()
          options.signal?.addEventListener('abort', onContAbort, { once: true })
          try {
            yield* this.driveRecording(rec, continuation.itemIndex + 1, cutOnTool, isCodeMode, options.signal)
          } finally {
            options.signal?.removeEventListener('abort', onContAbort)
          }
          return
        }
      }
    }

    // 2. Fresh turn over persistent ACP session (with automatic 429/geo failover + 1x pre-output crash recovery).
    const cwd = this.deps.pool.policy(sessionKey).workspaceRoot
    const requestedModel = options.model || cfg.defaultModel || ''
    const preparedSystem = prepareSystemPrompt(options.system, messages)
    const triedAccounts = new Set<string>()
    let crashRetried = recoveryPolicy !== undefined
    let nextBlockIndex = 0
    let lastEgressBlockedError: EgressBlockedError | null = null
    const maxAccounts = Math.max(1, cfg.accounts.filter((a) => a.enabled !== false).length || 1)
    const maxIterations = maxAccounts + 2

    for (let iter = 0; iter < maxIterations; iter++) {
      options.signal?.throwIfAborted()
      let client: Awaited<ReturnType<AcpSessionPool['getOrCreateSession']>>['client']
      let session: ManagedAcpSession
      let created: boolean
      try {
        ;({ client, session, created } = await this.deps.pool.getOrCreateSession(
          sessionKey,
          cwd,
          requestedModel,
          triedAccounts.size > 0 ? triedAccounts : undefined,
          undefined,
          recoveryPolicy ? { forceNew: true } : undefined,
        ))
      } catch (err) {
        if (err instanceof EgressBlockedError && !options.signal?.aborted) {
          lastEgressBlockedError = err
          triedAccounts.add(err.accountId)
          if (triedAccounts.size < maxAccounts) {
            this.deps.log?.(
              `account "${err.accountId}" blocked by local egress geo-fence, failing over (${triedAccounts.size}/${maxAccounts} tried)`,
            )
            continue
          }
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { code: 'ACP_ERROR', message: err.message },
            },
          }
          return
        }
        if (lastEgressBlockedError && err instanceof Error && /No healthy accounts available/i.test(err.message)) {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { code: 'ACP_ERROR', message: lastEgressBlockedError.message },
            },
          }
          return
        }
        throw err
      }

      const targetModel = requestedModel || session.currentModel
      const policy = this.deps.pool.policy(sessionKey)
      if (recoveryPolicy && (!created || session.hasMcpServers || recoveryPolicy !== policyKey(policy))) {
        throw new Error('恢复时会话或权限已变更，请重新发起请求。')
      }
      const nativeAuto = session.configOptions.find(o => o.id === 'mode')?.options?.some(o => 'value' in o ? o.value === 'auto' : o.options.some(v => v.value === 'auto'))
      const targetMode = policy.preset === 'auto' && policy.mode === 'danger-full-access' && nativeAuto ? 'auto' : 'default'

      try {
        await this.deps.pool.syncSessionOptions(client, session, {
          model: targetModel,
          effort: options.reasoningEffort,
          configuredEffort: cfg.defaultEffort,
          mode: targetMode,
        })
      } catch (err) {
        if (err instanceof AcpProcessExitError) {
          if (this.deps.pool.owns(session)) this.deps.pool.invalidate(sessionKey)
          if (!crashRetried && !options.signal?.aborted) {
            crashRetried = true
            this.deps.log?.(`agy acp exited during option sync for "${sessionKey}", recreating session (retry 1/1)`)
            continue
          }
        }
        throw err
      }

      this.deps.pool.notifyStatusChange()
      const baseBlocks = await buildPromptBlocksWithAttachments(messages, created, undefined, session.promptCapabilities, this.deps.readImage, options.signal, this.deps.readFileStream)
      let pendingSystemHash: string | null = null
      let promptBlocks = baseBlocks
      if (preparedSystem) {
        if (created || session.appliedSystemHash === null) {
          promptBlocks = [buildSystemPromptBlock(preparedSystem.append, false), ...baseBlocks]
          pendingSystemHash = preparedSystem.hash
        } else if (session.appliedSystemHash !== preparedSystem.hash) {
          promptBlocks = [buildSystemPromptBlock(preparedSystem.append, true), ...baseBlocks]
          pendingSystemHash = preparedSystem.hash
        }
      }

      if (session.currentMode !== targetMode) throw new Error(`Antigravity did not accept permission mode ${targetMode}`)
      const turn = this.deps.pool.beginPrompt(session, options.signal)
      const outcomeWatcher = createTurnOutcomeWatcher(
        session.acpSessionId,
        this.deps.pool.accountEnvFor(session),
      )
      const rec = this.deps.runs.create(sessionKey, createPreEditLocator(cwd))
      // agy emits usage_update at the end of a prompt, so seed with the last known occupancy for mirror boundaries.
      if (typeof session.contextUsed === 'number') rec.contextUsed = session.contextUsed
      // Exact per-call usage (cache hits included) comes from agy's transcript; ACP only reports a run total.
      rec.attachUsageSource(new TranscriptUsageTailer(this.deps.pool.transcriptPaths(session)))
      rec.setCancelHandler(() => {
        turn.cancel()
        client.sessionCancel(session.acpSessionId)
      })

      const unsubscribe = client.onSessionUpdate(session.acpSessionId, (update) => {
        // A finished model call is on disk by the time its tool call / occupancy is announced.
        if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update' || update.sessionUpdate === 'usage_update') {
          rec.flushUsage()
        }
        rec.pushUpdate(update)
        if (update.sessionUpdate === 'usage_update' && typeof update.used === 'number') {
          this.deps.pool.recordContextUsage(session, targetModel, update.used, typeof update.size === 'number' ? update.size : 0)
        }
      })

      const onAbort = (): void => {
        rec.requestCancel()
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      let cleanedUp = false
      const cleanupTurn = (): void => {
        if (cleanedUp) return
        cleanedUp = true
        turn.finish()
        unsubscribe()
        rec.setCancelHandler(null)
        options.signal?.removeEventListener('abort', onAbort)
      }

      // Run `session/prompt` in background so the recording can span multiple DSH tool-mirror loops.
      void client
        .sessionPrompt({ sessionId: session.acpSessionId, prompt: promptBlocks }, cfg.requestTimeoutMs)
        .then((res) => {
          const hiddenFailure = options.signal?.aborted
            ? undefined
            : (outcomeWatcher.check(res) ??
              evaluateInlineWarningFallback(res.stopReason, rec.inlineMessageText, rec.hasThoughtOrTool, res.usage))
          if (hiddenFailure) {
            this.deps.pool.recordTurnUsage(res.usage)
            if (hiddenFailure.kind === 'tos') {
              const tosErr = new LlmError(
                `[风控熔断] 账号“${session.accountId}”触发上游服务条款/账号风控限制（TOS_VIOLATION）。已立即本地隔离该账号并中止自动切换备用账号，以防连坐封禁；请排查请求内容与账号状态后在控制台手动解除隔离。`,
                'ACP_TOS_VIOLATION',
              )
              this.deps.pool.reportAccountFailure(session.accountId, targetModel, tosErr, { code: 'TOS_VIOLATION' })
              if (this.deps.pool.owns(session)) this.deps.pool.evictSession(sessionKey)
              cleanupTurn()
              rec.fail(tosErr)
              return
            }
            if (hiddenFailure.kind === 'geo') {
              const snap = this.deps.pool.recordGeoRejection(session.accountId)
              const regionHint = snap.country ? `（当前检测地区：${snap.country}）` : ''
              const geoErr = new LlmError(
                `[地域限制熔断] 上游 Google API 拒绝了当前网络出口地域（400 FAILED_PRECONDITION）${regionHint}。已断开当前代理长连接并在本地立即熔断该账号出口 60 秒以防连续请求触发风控；请切换至 US / JP / SG / TW 等支持区域节点后，在控制台点击「检测出口」恢复。`,
                'ACP_GEO_UNSUPPORTED',
              )
              this.deps.pool.reportAccountFailure(session.accountId, targetModel, geoErr, { code: 'FAILED_PRECONDITION' })
              if (this.deps.pool.owns(session)) this.deps.pool.invalidate(sessionKey)
              cleanupTurn()
              rec.fail(geoErr)
              return
            }
            if (hiddenFailure.sessionBroken) {
              // Saved thinking signature corrupted: permanently broken native session, evict so next turn rebuilds cleanly.
              this.deps.log?.(`evicting corrupted ACP session "${sessionKey}" (${hiddenFailure.code})`)
              if (this.deps.pool.owns(session)) this.deps.pool.evictSession(sessionKey)
              cleanupTurn()
              rec.fail(new LlmError(hiddenFailure.message, hiddenFailure.code))
              return
            }
            const err = new LlmError(
              hiddenFailure.kind === 'quota'
                ? `QUOTA_EXHAUSTED: ${hiddenFailure.message}`
                : hiddenFailure.message,
              hiddenFailure.code,
            )
            this.deps.pool.reportAccountFailure(session.accountId, targetModel, err, {
              ...(hiddenFailure.resetAt !== undefined ? { resetAt: hiddenFailure.resetAt } : {}),
              code: hiddenFailure.code,
            })
            cleanupTurn()
            rec.fail(err)
            return
          }
          if (pendingSystemHash) this.deps.pool.recordAppliedSystemHash(session, pendingSystemHash)
          if (!options.signal?.aborted) this.deps.pool.reportAccountSuccess(session.accountId, targetModel)
          this.deps.pool.recordTurnUsage(res.usage)
          // Release active turn slot synchronously BEFORE waking consumers to prevent next-turn race.
          cleanupTurn()
          rec.finish(res.stopReason, res.usage)
        })
        .catch((err: unknown) => {
          if (err instanceof SessionPolicyChangedError) {
            cleanupTurn()
            rec.fail(err)
            return
          }
          const isCleanRpcError = err instanceof AcpRpcError
          let error = err instanceof Error ? err : new Error(String(err))
          const parsedResetAt = extractResetAtMs(error.message)
          if (err instanceof AcpProcessExitError) {
            const { interruptedBeforeGrant, granted } = turn.permissions
            if (interruptedBeforeGrant) {
              if (cutOnTool && !crashRetried && !session.hasMcpServers && !cfg.mcpBridge && targetMode !== 'auto' && policy.approval === 'ask') {
                rec.allowApprovalRecovery(interruptedBeforeGrant, policyKey(policy))
              }
              error = new Error(`工具审批因 ACP 退出而中断，该请求尚未获准执行。 ${err.message}`, { cause: err })
            } else if ([...granted].some(id => !rec.getToolCall(id)?.settled)) {
              error = new Error(`工具已获准执行，但未收到执行结果。请先核对执行状态，再决定是否重试。 ${err.message}`, { cause: err })
            }
          }
          let forceInvalidate = false
          let evictCorruptedSession = false
          if (!(err instanceof AcpProcessExitError) && isInvalidThinkingSignatureError(error)) {
            evictCorruptedSession = true
            error = new LlmError(
              'Antigravity 历史会话中的 thinking 签名已失效（INVALID_THINKING_SIGNATURE），已自动重置原生会话，下条消息将携带摘要重建新会话。',
              'INVALID_THINKING_SIGNATURE',
            )
          } else if (!(err instanceof AcpProcessExitError) && isTosViolationError(error)) {
            this.deps.pool.reportAccountFailure(session.accountId, targetModel, error)
            forceInvalidate = true
            error = new LlmError(
              `[风控熔断] 账号“${session.accountId}”触发上游服务条款/账号风控限制（TOS_VIOLATION）。已立即本地隔离该账号并中止自动切换备用账号，以防连坐封禁；请排查请求内容与账号状态后在控制台手动解除隔离。`,
              'ACP_TOS_VIOLATION',
            )
          } else if (!(err instanceof AcpProcessExitError) && isGeoUnsupportedError(error)) {
            const snap = this.deps.pool.recordGeoRejection(session.accountId)
            this.deps.pool.reportAccountFailure(session.accountId, targetModel, error)
            forceInvalidate = true
            const regionHint = snap.country ? `（当前检测地区：${snap.country}）` : ''
            error = new LlmError(
              `[地域限制熔断] 上游 Google API 拒绝了当前网络出口地域（400 FAILED_PRECONDITION）${regionHint}。已断开当前代理长连接并在本地立即熔断该账号出口 60 秒以防连续请求触发风控；请切换至 US / JP / SG / TW 等支持区域节点后，在控制台点击「检测出口」恢复。`,
              'ACP_GEO_UNSUPPORTED',
            )
          } else {
            this.deps.pool.reportAccountFailure(
              session.accountId,
              targetModel,
              error,
              parsedResetAt !== undefined ? { resetAt: parsedResetAt } : undefined,
            )
          }
          // Preserve healthy persistent processes on clean JSON-RPC application errors (`AcpRpcError`).
          // Invalidate on timeout, process crash, transport failure, TOS quarantine, corrupted history, or dead child.
          const shouldInvalidate =
            forceInvalidate || !client.isRunning || err instanceof AcpTimeoutError || !isCleanRpcError
          if (evictCorruptedSession && this.deps.pool.owns(session)) {
            this.deps.pool.evictSession(sessionKey)
          } else if (shouldInvalidate && this.deps.pool.owns(session)) {
            this.deps.pool.invalidate(sessionKey)
          }
          cleanupTurn()
          rec.fail(error)
        })
        .finally(() => {
          cleanupTurn()
        })

      // Peek first item before yielding so quota/429/geo failover and pre-output crash recovery stay seamless.
      // Never fail over on TOS_VIOLATION to avoid cascading bans across backup accounts.
      const firstItem = await rec.waitFor(0, options.signal)
      if (firstItem?.kind === 'error' && !(firstItem.error instanceof AcpProcessExitError) && !turn.permissions.requests && !options.signal?.aborted) {
        const isTosErr =
          isTosViolationError(firstItem.error) ||
          (firstItem.error instanceof LlmError && firstItem.error.code === 'ACP_TOS_VIOLATION')
        const isGeoErr =
          isGeoUnsupportedError(firstItem.error) ||
          (firstItem.error instanceof LlmError && firstItem.error.code === 'ACP_GEO_UNSUPPORTED')
        if (!isTosErr && (isQuotaOrRateLimitError(firstItem.error) || isGeoErr)) {
          triedAccounts.add(session.accountId)
          if (triedAccounts.size < maxAccounts) {
            this.deps.log?.(
              `account "${session.accountId}" hit ${isGeoErr ? 'geo-restriction' : 'quota/rate-limit'} on "${targetModel}", failing over (${triedAccounts.size}/${maxAccounts} tried)`,
            )
            rec.releaseRecording()
            await this.deps.pool.closeSession(sessionKey)
            continue
          }
        }
      }

      const resumeAt = yield* this.driveRecording(rec, 0, cutOnTool, isCodeMode, options.signal, nextBlockIndex, () =>
        !crashRetried && !options.signal?.aborted && !turn.permissions.requests &&
        !session.hasMcpServers && targetMode !== 'auto' && this.deps.runs.isLatestForOwner(rec) &&
        rec.items.every(item => item.kind === 'error' || (item.kind === 'update' &&
          ['agent_thought_chunk', 'usage_update', 'session_info_update', 'available_commands_update',
            'config_option_update'].includes(item.update.sessionUpdate))))
      if (resumeAt !== undefined && !options.signal?.aborted) {
        crashRetried = true
        recoveryPolicy = policyKey(policy)
        nextBlockIndex = resumeAt
        this.deps.log?.(`ACP exited before an answer or tool call for "${sessionKey}"; recreating session (retry 1/1)`)
        continue
      }
      return
    }
  }

  private async *streamAuxiliary(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.signal?.aborted) {
      yield {
        type: 'finish',
        reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Request aborted by caller' } },
      }
      return
    }

    const cfg = this.deps.getConfig()
    const auxMessages = options.messages as readonly PromptMessage[]
    const { append, fallbackBlock } = prepareAuxiliarySystemPrompt(options.purpose!, options.system, auxMessages)
    const prompt = buildAuxiliaryPromptBlocks(auxMessages)
    const rec = new AcpRunRecording(undefined, options.sessionId)
    const ac = new AbortController()
    const onAbort = (): void => ac.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    rec.setCancelHandler(() => ac.abort())
    const combinedSignal = options.signal ? AbortSignal.any([ac.signal, options.signal]) : ac.signal

    void this.deps.pool
      .runAuxiliaryPrompt({
        sessionKey: options.sessionId,
        model: options.model || cfg.defaultModel || undefined,
        effort: options.reasoningEffort,
        systemPromptAppend: append,
        systemFallbackBlock: fallbackBlock,
        prompt,
        signal: combinedSignal,
        onUpdate: (update) => rec.pushUpdate(update),
      })
      .then((res) => {
        rec.finish(res.stopReason, res.usage)
      })
      .catch((err: unknown) => {
        let error = err instanceof Error ? err : new Error(String(err))
        if (isTosViolationError(error)) {
          error = new LlmError(
            '[风控熔断] 账号触发上游服务条款/账号风控限制（TOS_VIOLATION）。已本地隔离该账号并中止自动切号；请核查账号状态后手动解除隔离。',
            'ACP_TOS_VIOLATION',
          )
        } else if (isGeoUnsupportedError(error)) {
          error = new LlmError(
            '[地域限制熔断] 上游 Google API 拒绝了当前网络出口地域（400 FAILED_PRECONDITION）。已在本地熔断该账号出口 60 秒；请切换至支持区域节点后重试。',
            'ACP_GEO_UNSUPPORTED',
          )
        }
        rec.fail(error)
      })
      .finally(() => {
        rec.setCancelHandler(null)
        options.signal?.removeEventListener('abort', onAbort)
      })

    yield* this.driveRecording(rec, 0, false, false, options.signal)
  }

  private async *driveRecording(
    rec: AcpRunRecording,
    startIndex: number,
    cutOnTool: boolean,
    isCodeMode: boolean,
    signal?: AbortSignal,
    blockStart = 0,
    canRetryExit?: () => boolean,
  ): AsyncGenerator<StreamChunk, number | void> {
    let idx = startIndex
    let blockIdx = blockStart
    let openType: 'text' | 'reasoning' | null = null
    let openAcc = ''

    const closeOpenBlock = (): StreamChunk | null => {
      if (openType === null) return null
      const chunk: StreamChunk =
        openType === 'text'
          ? { type: 'block-end', index: blockIdx, block: { type: 'text', text: openAcc } }
          : { type: 'block-end', index: blockIdx, block: { type: 'reasoning', text: openAcc } }
      blockIdx++
      openType = null
      openAcc = ''
      return chunk
    }

    const emitToolChunks = (tc: MergedToolCall, stepIdx: number): StreamChunk[] => {
      rec.markToolEmitted(tc.toolCallId)
      const toolName = isCodeMode ? WRAPPER_TOOL_NAME : MIRROR_TOOL_NAME
      const callId = encodeMirrorCallId(rec.id, stepIdx) as ToolCallId
      const locations = normalizeLocations(tc.locations)
      const rawInput = tc.rawInput ?? tc.args
      const mirrorPayload: Record<string, unknown> = {
        run: rec.id,
        step: stepIdx,
        toolCallId: tc.toolCallId,
        tool: tc.name ?? 'tool',
        ...(tc.title ? { title: tc.title } : {}),
        ...(tc.kind ? { kind: tc.kind } : {}),
        ...(locations ? { locations } : {}),
      }
      if (rawInput !== undefined) {
        const isEditLike =
          tc.kind === 'edit' ||
          /^(?:edit|write|replace|multi_replace|apply_patch)/i.test(tc.name ?? '')
        const inputVal = isCodeMode
          ? compactDisplayInput(rawInput)
          : compactDisplayInput(rawInput, isEditLike ? MAX_STANDARD_EDIT_INPUT_BYTES : MAX_STANDARD_INPUT_BYTES)
        if (inputVal !== undefined) mirrorPayload.input = inputVal
      }

      const argsJson = isCodeMode
        ? JSON.stringify({
            code: `await tools[${JSON.stringify(MIRROR_TOOL_NAME)}](${JSON.stringify(mirrorPayload)})`,
          })
        : JSON.stringify(mirrorPayload)

      const startChunk: StreamChunk = { type: 'block-start', index: blockIdx, blockType: 'tool-call' }
      const endChunk: StreamChunk = {
        type: 'block-end',
        index: blockIdx,
        block: {
          type: 'tool-call',
          id: callId,
          name: toolName,
          arguments: argsJson,
        },
      }
      blockIdx++
      return [startChunk, endChunk]
    }

    while (true) {
      if (signal?.aborted) {
        rec.releaseRecording()
        const closed = closeOpenBlock()
        if (closed) yield closed
        yield {
          type: 'finish',
          reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Request aborted by caller' } },
        }
        return
      }

      const item = await rec.waitFor(idx, signal)
      if (signal?.aborted) {
        rec.releaseRecording()
        const closed = closeOpenBlock()
        if (closed) yield closed
        yield {
          type: 'finish',
          reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Request aborted by caller' } },
        }
        return
      }
      if (!item) {
        rec.releaseRecording()
        const closed = closeOpenBlock()
        if (closed) yield closed
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }

      if (item.kind === 'error') {
        const mayRetry = item.error instanceof AcpProcessExitError && canRetryExit?.()
        rec.releaseRecording()
        const closed = closeOpenBlock()
        if (closed) yield closed
        if (item.error instanceof SessionPolicyChangedError) {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: item.error.message } } }
          return
        }
        if (mayRetry) return blockIdx
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { code: item.error instanceof LlmError ? item.error.code ?? 'ACP_ERROR' : 'ACP_ERROR', message: item.error.message },
          },
        }
        return
      }

      if (item.kind === 'done') {
        const closed = closeOpenBlock()
        if (closed) yield closed
        const priorUsageCount = rec.consumedSpanUsageCount
        const spanUsage = await takeSpanUsage(rec, FINAL_USAGE_RETRIES, signal)
        if (spanUsage) {
          // agy's transcript.jsonl PLANNER_RESPONSE currently omits thinking_tokens.
          // When this run had a single model call, enrich with the run-level thoughtTokens safely.
          const thought = item.usage?.thoughtTokens
          const enriched =
            spanUsage.reasoningTokens === undefined &&
            priorUsageCount === 0 &&
            typeof thought === 'number' &&
            Number.isSafeInteger(thought) &&
            thought > 0 &&
            thought <= spanUsage.outputTokens
              ? { ...spanUsage, reasoningTokens: thought }
              : spanUsage
          yield { type: 'usage', usage: callUsageToTokenUsage(enriched) }
        } else if (!rec.hasUsageSource) {
          const usage = mapContextUsage(item.usage, rec.contextUsed)
          if (usage) yield { type: 'usage', usage }
        }
        rec.releaseRecording()
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }

      const u = item.update
      if (u.sessionUpdate === 'agent_thought_chunk' && u.content && typeof u.content === 'object' && 'text' in u.content) {
        const delta = String(u.content.text ?? '')
        if (delta) {
          if (openType !== 'reasoning') {
            const closed = closeOpenBlock()
            if (closed) yield closed
            openType = 'reasoning'
            openAcc = ''
            yield { type: 'block-start', index: blockIdx, blockType: 'reasoning' }
          }
          openAcc += delta
          yield { type: 'reasoning-delta', index: blockIdx, text: delta }
        }
      } else if (u.sessionUpdate === 'agent_message_chunk' && u.content && typeof u.content === 'object' && 'text' in u.content) {
        const delta = String(u.content.text ?? '')
        if (delta) {
          if (openType !== 'text') {
            const closed = closeOpenBlock()
            if (closed) yield closed
            openType = 'text'
            openAcc = ''
            yield { type: 'block-start', index: blockIdx, blockType: 'text' }
          }
          openAcc += delta
          yield { type: 'text-delta', index: blockIdx, text: delta }
        }
      } else if (cutOnTool && (u.sessionUpdate === 'tool_call_update' || u.sessionUpdate === 'tool_call')) {
        const tcUpdate = u as AcpToolCallUpdate
        const toolCallId =
          typeof tcUpdate.toolCallId === 'string' && tcUpdate.toolCallId.trim() !== ''
            ? tcUpdate.toolCallId
            : `step:${idx}`
        if (!rec.isToolEmitted(toolCallId)) {
          const merged = rec.getToolCall(toolCallId)
          if (merged && isToolReadyToEmit(rec, idx, merged)) {
            const closed = closeOpenBlock()
            if (closed) yield closed

            const emittedBatchIds = new Set<string>([merged.toolCallId])
            for (const c of emitToolChunks(merged, idx)) yield c

            // Standard mode: batch contiguous concurrent tool calls, including a short micro-batch window
            // when the tool just started (not yet settled) so sibling parallel tool frames arriving over
            // stdio land in one DSH step instead of fanning out into multiple hollow steps.
            let sawPostToolContent = false
            if (!isCodeMode) {
              const batchDeadline = Date.now() + TOOL_BATCH_MAX_WAIT_MS
              while (true) {
                let nextItem = idx + 1 < rec.items.length ? rec.items[idx + 1] : null
                if (!nextItem && !merged.settled && !rec.isSettled && !signal?.aborted) {
                  const waitMs = Math.min(TOOL_BATCH_COALESCE_MS, batchDeadline - Date.now())
                  if (waitMs > 0) {
                    nextItem = await rec.waitForWithin(idx + 1, waitMs, signal)
                  }
                }
                if (!nextItem) break
                if (nextItem.kind !== 'update') {
                  sawPostToolContent = true
                  break
                }
                const nu = nextItem.update
                if (nu.sessionUpdate === 'usage_update') {
                  idx++
                  continue
                }
                if (nu.sessionUpdate !== 'tool_call' && nu.sessionUpdate !== 'tool_call_update') {
                  sawPostToolContent = true
                  break
                }
                const nextTc = nu as AcpToolCallUpdate
                const nextId =
                  typeof nextTc.toolCallId === 'string' && nextTc.toolCallId.trim() !== ''
                    ? nextTc.toolCallId
                    : `step:${idx + 1}`
                if (rec.isToolEmitted(nextId)) {
                  idx++
                  continue
                }
                const nextMerged = rec.getToolCall(nextId)
                if (!nextMerged || !isToolReadyToEmit(rec, idx + 1, nextMerged)) break
                idx++
                emittedBatchIds.add(nextMerged.toolCallId)
                for (const c of emitToolChunks(nextMerged, idx)) yield c
              }
            }

            // One DSH step = the agy model calls since the previous step. With the transcript, report their exact
            // usage; skip the 160ms poll loop on continuation cuts of the same model call that cannot emit a new record.
            const boundaryRetries = rec.expectsNewCallUsage(emittedBatchIds) ? BOUNDARY_USAGE_RETRIES : 0
            const spanUsage =
              sawPostToolContent && rec.hasPendingUsage
                ? rec.consumeSpanUsage()
                : await takeSpanUsage(rec, boundaryRetries, signal)
            if (spanUsage) {
              yield { type: 'usage', usage: callUsageToTokenUsage(spanUsage) }
            } else if (!rec.hasUsageSource && rec.contextUsed !== undefined && rec.contextUsed !== rec.lastFallbackContextUsed) {
              // No transcript: report live context occupancy once per distinct reading so DSH shows context
              // pressure without repeatedly billing the same full context across mirrored tool spans.
              const boundaryUsage = mapContextUsage(undefined, rec.contextUsed)
              if (boundaryUsage) {
                rec.lastFallbackContextUsed = rec.contextUsed
                yield { type: 'usage', usage: boundaryUsage }
              }
            }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
            return
          }
        }
      }

      idx++
    }
  }
}

/** agy appends a call's transcript record asynchronously; wait briefly for it before reporting a step. */
const BOUNDARY_USAGE_RETRIES = 4
const FINAL_USAGE_RETRIES = 6
const USAGE_RETRY_MS = 40
const TOOL_BATCH_COALESCE_MS = 35
const TOOL_BATCH_MAX_WAIT_MS = 70
const MAX_STANDARD_INPUT_BYTES = 16 * 1024
const MAX_STANDARD_EDIT_INPUT_BYTES = 64 * 1024

async function takeSpanUsage(rec: AcpRunRecording, retries: number, signal?: AbortSignal) {
  rec.flushUsage()
  for (let i = 0; i < retries && !rec.hasPendingUsage && rec.hasUsageSource && !signal?.aborted; i++) {
    await new Promise(resolve => setTimeout(resolve, USAGE_RETRY_MS))
    rec.flushUsage()
  }
  return rec.consumeSpanUsage()
}

function isToolReadyToEmit(rec: AcpRunRecording, idx: number, tc: MergedToolCall): boolean {
  if (tc.status === 'completed' || tc.status === 'failed' || tc.status === 'pending') return true
  const hasMetadata =
    Boolean(tc.name) ||
    Boolean(tc.title) ||
    tc.rawInput !== undefined ||
    tc.args !== undefined ||
    Boolean(tc.locations?.length)
  if (hasMetadata) return true
  // Pure placeholder `in_progress` frame: coalesce if next item is already buffered; otherwise emit immediately.
  return idx + 1 >= rec.items.length
}

// Read the shared fields structurally: older DSH puts results in user blocks,
// while newer DSH uses a separate tool message with a top-level call ID.
interface ContinuationMessage {
  readonly role: string
  readonly source?: { readonly kind?: string }
  readonly toolCallId?: unknown
  readonly content: readonly { readonly type: string; readonly toolCallId?: unknown; readonly text?: string }[]
}

export function detectContinuation(
  messages: readonly ContinuationMessage[],
): { runId: string; itemIndex: number } | null {
  let targetRunId: string | null = null
  let maxItemIndex = -1

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === 'tool') {
      const parsed = typeof message.toolCallId === 'string' ? decodeMirrorCallId(message.toolCallId) : null
      if (!parsed) break
      if (targetRunId === null) {
        targetRunId = parsed.runId
        maxItemIndex = parsed.itemIndex
      } else if (parsed.runId === targetRunId) {
        if (parsed.itemIndex > maxItemIndex) maxItemIndex = parsed.itemIndex
      } else {
        break
      }
      continue
    }

    if (message.role !== 'user') break

    // DSH may append both snapshots while preparing the next step of this same turn.
    if (message.source?.kind === 'runtime-context' || message.source?.kind === 'time-context') {
      if (targetRunId === null) continue
      break
    }

    let matchedInUser = false
    for (let j = message.content.length - 1; j >= 0; j--) {
      const block = message.content[j]
      if (block?.type === 'tool-result' && typeof block.toolCallId === 'string') {
        const parsed = decodeMirrorCallId(block.toolCallId)
        if (!parsed) continue
        if (targetRunId === null) {
          targetRunId = parsed.runId
          maxItemIndex = parsed.itemIndex
          matchedInUser = true
        } else if (parsed.runId === targetRunId) {
          if (parsed.itemIndex > maxItemIndex) maxItemIndex = parsed.itemIndex
          matchedInUser = true
        }
      }
    }
    if (!matchedInUser) break
  }

  return targetRunId !== null ? { runId: targetRunId, itemIndex: maxItemIndex } : null
}
