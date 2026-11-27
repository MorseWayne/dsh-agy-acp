import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { apply } from '../src/index.ts'
import type { AcpAdapter } from '../src/provider/adapter.ts'
import { ConfigStore } from '../src/runtime/config-store.ts'
// @ts-expect-error runtime React is supplied by workspace dependencies
import React from 'react'
// @ts-expect-error runtime ReactDOMServer is supplied by workspace dependencies
import ReactDOMServer from 'react-dom/server'
import {
  DEFAULT_ACCOUNT_ID,
  maskProxyUrlForDisplay,
  slugifyAccountId,
  slugifyEmailToAccountId,
  validateLoginCodeInput,
  validateManagedAccountCreateInput,
  validateProxyUrl,
} from '../src/common/account-validation.ts'
import { resolveConfig } from '../src/common/config.ts'
import type { AccountHealthSnapshot, StatusSnapshot } from '../src/common/types.ts'
import { AccountsPanel } from '../src/client/accounts-panel.ts'
import { EnvSetupBanner } from '../src/client/env-setup-banner.ts'
import { AccountLoginManager } from '../src/runtime/account-login.ts'
import { isAuthFailureError, MultiAccountPool } from '../src/runtime/account-pool.ts'
import {
  AccountStore,
  detectAccountIdentityFromHome,
  hasLocalOAuthTokenFile,
  inspectAccountAuthStatus,
} from '../src/runtime/account-store.ts'
import { AgyInstaller } from '../src/runtime/env-setup.ts'
import { AcpSessionPool } from '../src/runtime/session-pool.ts'
import { registerAcpRoutes, type ExactRouteSpec, type WebServerLike } from '../src/transport/sse.ts'
import { fakeHost } from './fixtures/session-policy.ts'

function postJsonTo(routes: ReadonlyMap<string, ExactRouteSpec['handler']>) {
  return async (routePath: string, body: Record<string, unknown>) => {
    const handler = routes.get(routePath)
    assert.ok(handler, `expected POST route ${routePath}`)
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
    req.method = 'POST'
    req.url = routePath
    req.headers = { 'content-type': 'application/json' }
    let statusCode = 0
    let rawBody = ''
    const res = {
      writeHead(code: number) {
        statusCode = code
        return res
      },
      end(chunk?: string) {
        rawBody = chunk ?? ''
        return res
      },
    } as unknown as ServerResponse
    await handler(req, res)
    return { statusCode, json: JSON.parse(rawBody) as Record<string, unknown> }
  }
}

test('plugin HTTP config replaces routes atomically, persists a clear across restart, and resets to host routing', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agy-route-http-'))
  const paths = { DSH_AGY_ACP_CONFIG_PATH: 'config.json', DSH_AGY_ACP_SESSIONS_PATH: 'sessions.json',
    DSH_AGY_ACP_ACCOUNTS_PATH: 'accounts.json', DSH_AGY_ACP_USAGE_PATH: 'usage.json' }
  const oldEnv = Object.fromEntries(Object.keys(paths).map(k => [k, process.env[k]]))
  const peer = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url))
  const model = 'gemini-4-neon'
  const hostRule = { families: { 'gemini-pro': { accountId: 'two' } } }
  const persistedRule = { models: { [model]: { accountId: 'one' } } }
  const cleanups: Array<() => void> = []
  const dispose = () => { while (cleanups.length) cleanups.pop()!() }
  let turn = 0
  const mount = async () => {
    const routes = new Map<string, ExactRouteSpec['handler']>()
    let adapter!: AcpAdapter
    const services = new Map<string, unknown>([
      ['connection', { requestRejection: () => undefined }],
      ['webServer', { register: (s: ExactRouteSpec) => { routes.set(s.path, s.handler); return () => routes.delete(s.path) } }],
      ['llm', { registerAdapter: (_ids: string[], a: AcpAdapter) => { adapter = a } }],
    ])
    const host = {
      get: (id: string) => services.get(id),
      inject: (ids: string[], setup: (ctx: unknown) => void | (() => void)) => {
        if (!ids.every(k => services.has(k))) return
        const close = setup(host)
        if (close) cleanups.push(close)
      },
      agents: { get: (id: string) => ({ session: { id } }) },
      sandboxPolicy: { resolve: ({ session }: { session: { id: string } }) => fakeHost.readPolicy(session.id) },
      permissionPresets: { current: () => 'danger-full-access' }, approval: { overrideOf: () => 'never' },
      sandbox: { confine: async (argv: string[]) => { assert.equal(argv[0], peer); return { argv, enforcement: 'full' } } },
      effect: (setup: () => () => void) => cleanups.push(setup()), on: () => {}, emit: () => {},
    }
    apply(host as unknown as Parameters<typeof apply>[0], { agyBin: peer, geoFenceMode: 'off',
      modelAccountRouting: hostRule, accounts: ['one', 'two'].map(id => ({ id, homeDir: path.join(dir, id), env: { FAKE_ACCOUNT_TAG: id } })),
    })
    await adapter.listModels('antigravity-acp') // protocol barrier for the initial catalog probe
    const post = postJsonTo(routes)
    return {
      post: (data: Record<string, unknown>, route = 'config') => post(`/plugins/agy-acp/${route}`, data),
      run: async () => {
        let text = ''
        for await (const c of adapter.stream({ provider: 'antigravity-acp', sessionId: `chat-${++turn}`, model,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        } as GenerateOptions)) if (c.type === 'text-delta') text += c.text
        return text
      },
    }
  }
  try {
    for (const [k, f] of Object.entries(paths)) process.env[k] = path.join(dir, f)
    let app = await mount()
    assert.equal((await app.post({ accountId: 'one' }, 'accounts/select')).statusCode, 200)
    assert.match(await app.run(), /^<two>/, 'host family rule overrides global primary')
    const saved = await app.post({ modelAccountRouting: persistedRule, defaultEffort: 'low' })
    assert.equal(saved.statusCode, 200)
    assert.deepEqual((saved.json.status as StatusSnapshot).config.modelAccountRouting, persistedRule)
    assert.match(await app.run(), /^<one>/, 'HTTP patch synchronizes live routing')
    assert.equal((await app.post({ modelAccountRouting: { models: { x: { accountId: 'bad id' } } } })).statusCode, 400)
    dispose()
    app = await mount()
    assert.match(await app.run(), /^<one>/, 'restart loads the model override')
    for (const empty of [null, {}]) {
      await app.post({ modelAccountRouting: hostRule })
      assert.match(await app.run(), /^<two>/)
      const cleared = await app.post({ modelAccountRouting: empty })
      assert.equal(cleared.statusCode, 200)
      assert.equal((cleared.json.status as StatusSnapshot).config.modelAccountRouting, undefined)
      assert.match(await app.run(), /^<one>/, 'empty patch removes the rule from the live scheduler')
    }
    assert.deepEqual(new ConfigStore().load().patch, { defaultEffort: 'low', modelAccountRouting: {} })
    dispose()
    app = await mount()
    assert.match(await app.run(), /^<one>/, 'explicit clear masks host routing across restart')
    const reset = await app.post({}, 'config/reset')
    assert.deepEqual((reset.json.status as StatusSnapshot).config.modelAccountRouting, hostRule)
    assert.match(await app.run(), /^<two>/, 'reset restores host rules in scheduler too')
    assert.equal(new ConfigStore().load().exists, false)
  } finally {
    dispose()
    for (const [k, v] of Object.entries(oldEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v
    rmSync(dir, { recursive: true, force: true })
  }
})

test('account validation enforces safe IDs, proxy protocols, redaction, and login code bounds', () => {
  assert.equal(slugifyAccountId('Primary US Account'), 'primary-us-account')
  assert.equal(slugifyAccountId('主力账号', '9a2b'), 'acct-9a2b')
  assert.equal(slugifyAccountId('default', 'x1'), 'acct-x1')
  assert.equal(slugifyEmailToAccountId('Alice.Dev@gmail.com'), 'alice-dev')

  assert.equal(validateProxyUrl('').ok, true)
  assert.equal(validateProxyUrl('http://127.0.0.1:7890').ok, true)
  assert.equal(validateProxyUrl('socks5://user:secret@127.0.0.1:1080').ok, true)
  assert.equal(validateProxyUrl('file:///etc/passwd').ok, false)
  assert.equal(validateProxyUrl('javascript:alert(1)').ok, false)
  assert.equal(validateProxyUrl('http://127.0.0.1:7890\nEvil: 1').ok, false)

  assert.equal(maskProxyUrlForDisplay('http://alice:superpass@proxy.local:7890'), 'http://***@proxy.local:7890')
  assert.equal(maskProxyUrlForDisplay('socks5://127.0.0.1:1080'), 'socks5://127.0.0.1:1080')

  assert.equal(validateManagedAccountCreateInput({ label: '主力号', id: 'default' }).ok, false)
  assert.equal(validateManagedAccountCreateInput({ label: '主力号', id: '../escape' }).ok, false)
  const valid = validateManagedAccountCreateInput({ label: 'US Primary', proxyUrl: 'http://127.0.0.1:7890' })
  assert.equal(valid.ok, true)
  if (valid.ok) {
    assert.equal(valid.value.id, 'us-primary')
    assert.equal(valid.value.proxyUrl, 'http://127.0.0.1:7890')
  }

  assert.equal(validateLoginCodeInput('   ').ok, false)
  assert.equal(validateLoginCodeInput('code\nwith-newline').ok, false)
  assert.equal(validateLoginCodeInput('4/0AQSTgQ_valid_code').ok, true)
})

test('AccountStore persists managed accounts atomically with 0600 mode, isolated homes, and auth detection', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-agy-acct-store-'))
  const filePath = path.join(dir, 'accounts.json')
  const accountsRootDir = path.join(dir, 'accounts')
  try {
    const store = new AccountStore({ filePath, accountsRootDir })
    assert.deepEqual(store.load(), { accounts: [], defaultAccountEnabled: true })

    const created = store.addAccount({ label: 'US Main', proxyUrl: 'http://127.0.0.1:7890' })
    assert.equal(created.id, 'us-main')
    assert.equal(created.enabled, true)

    // Duplicate label without explicit ID auto-increments suffix cleanly
    const created2 = store.addAccount({ label: 'US Main' })
    assert.equal(created2.id, 'us-main-2')

    if (process.platform !== 'win32') {
      assert.equal(statSync(filePath).mode & 0o777, 0o600)
    }

    const home1 = store.resolveManagedAccountHome(created.id)
    assert.equal(existsSync(home1), true)
    assert.equal(hasLocalOAuthTokenFile(home1), false)

    // Effective profiles keep default machine profile + host profiles + managed isolated profiles
    const hostProfiles = [{ id: 'host-one', label: '宿主账号', homeDir: path.join(dir, 'host-home') }]
    const effective = store.buildEffectiveProfiles(hostProfiles)
    assert.deepEqual(
      effective.map((p) => `${p.id}:${p.source}`),
      ['default:default', 'host-one:host', 'us-main:managed', 'us-main-2:managed'],
    )
    const managedProfile = effective.find((p) => p.id === 'us-main')!
    assert.equal(managedProfile.env?.HTTPS_PROXY, 'http://127.0.0.1:7890')
    assert.ok(managedProfile.env?.SSH_CONNECTION)
    assert.equal(inspectAccountAuthStatus(managedProfile), 'not_logged_in')

    // Write valid token file -> auth status flips to logged_in without exposing secrets
    const tokenFile = path.join(home1, '.gemini', 'antigravity-acp', 'antigravity-oauth-token')
    writeFileSync(tokenFile, JSON.stringify({ token: { access_token: 'fake-access-token' } }), { mode: 0o600 })
    assert.equal(inspectAccountAuthStatus(managedProfile), 'logged_in')

    // Symlinked token file is rejected by hasLocalOAuthTokenFile
    const home2 = store.resolveManagedAccountHome(created2.id)
    const symlinkToken = path.join(home2, '.gemini', 'antigravity-acp', 'antigravity-oauth-token')
    symlinkSync(tokenFile, symlinkToken)
    assert.equal(hasLocalOAuthTokenFile(home2), false)

    // Toggle default account disabled & update managed account proxy
    store.updateAccount({ accountId: DEFAULT_ACCOUNT_ID, enabled: false })
    assert.equal(store.isDefaultAccountEnabled(), false)
    store.updateAccount({ accountId: 'us-main', label: '主力号 US', proxyUrl: '' })

    // Reload from disk verifies durability
    const reloaded = new AccountStore({ filePath, accountsRootDir })
    const loaded = reloaded.load()
    assert.equal(loaded.defaultAccountEnabled, false)
    assert.equal(loaded.accounts[0]?.label, '主力号 US')
    assert.equal(loaded.accounts[0]?.proxyUrl, undefined)

    // Remove with purgeData deletes isolated directory cleanly
    reloaded.removeAccount('us-main', { purgeData: true })
    assert.equal(existsSync(home1), false)
    assert.equal(reloaded.listManaged().length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('OAuth readiness and identity accept the CLI token path but reject symlinked credentials', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-agy-cli-token-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const home = path.join(dir, 'account')
  const cliDir = path.join(home, '.gemini', 'antigravity-cli')
  const fileName = 'antigravity-oauth-token'
  const tokenFile = path.join(cliDir, fileName)
  mkdirSync(cliDir, { recursive: true, mode: 0o700 })
  const identity = { email: 'cli-user@example.com', name: 'CLI User' }
  const claims = Buffer.from(JSON.stringify(identity)).toString('base64url')
  writeFileSync(tokenFile, JSON.stringify({ token: { access_token: 'fixture-cli-token', id_token: `hdr.${claims}.sig` } }), { mode: 0o600 })
  const fetcher = t.mock.fn(async () => ({ statusCode: 500, body: '' }))

  assert.equal(hasLocalOAuthTokenFile(home), true)
  assert.deepEqual(await detectAccountIdentityFromHome(home, { fetcher }), identity)

  if (process.platform !== 'win32') {
    const linkedFileHome = path.join(dir, 'linked-file')
    const linkedFileDir = path.join(linkedFileHome, '.gemini', 'antigravity-cli')
    mkdirSync(linkedFileDir, { recursive: true })
    symlinkSync(tokenFile, path.join(linkedFileDir, fileName))
    const linkedDirHome = path.join(dir, 'linked-dir')
    mkdirSync(path.join(linkedDirHome, '.gemini'), { recursive: true })
    symlinkSync(cliDir, path.join(linkedDirHome, '.gemini', 'antigravity-cli'), 'dir')

    for (const linkedHome of [linkedFileHome, linkedDirHome]) {
      assert.equal(hasLocalOAuthTokenFile(linkedHome), false)
      assert.deepEqual(await detectAccountIdentityFromHome(linkedHome, { fetcher }), {})
    }
  }
  assert.equal(fetcher.mock.callCount(), 0)
})

test('the first OAuth onboarding persists the new preference and disables the default account', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-agy-first-oauth-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const options = { filePath: path.join(dir, 'accounts.json'), accountsRootDir: path.join(dir, 'accounts') }
  const store = new AccountStore(options)
  assert.deepEqual(store.listManaged(), [])
  assert.equal(store.isDefaultAccountEnabled(), true)
  assert.equal(store.getPreferredAccountId(), null)

  const pending = store.preparePendingAccountHome('first-login')
  writeFileSync(path.join(pending, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
    JSON.stringify({ token: { access_token: 'fixture-first-login' } }), { mode: 0o600 })
  const committed = store.commitPendingAccount({ pendingId: 'first-login', email: 'first@example.com' })
  assert.equal(store.isDefaultAccountEnabled(), false)
  assert.equal(store.getPreferredAccountId(), committed.id)

  const reloaded = new AccountStore(options)
  assert.deepEqual(reloaded.listManaged(), [committed])
  assert.equal(reloaded.isDefaultAccountEnabled(), false)
  assert.equal(reloaded.getPreferredAccountId(), committed.id)
})

test('MultiAccountPool.syncProfiles hot-updates accounts while preserving live quota/cooldown state', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-agy-pool-sync-'))
  try {
    const store = new AccountStore({ filePath: path.join(dir, 'accounts.json'), accountsRootDir: path.join(dir, 'accounts') })
    const a1 = store.addAccount({ label: 'Account One', id: 'acct-1', proxyUrl: 'http://user:pw@127.0.0.1:7890' })
    const pool = new MultiAccountPool({
      accounts: store.buildEffectiveProfiles(),
      inspectAuthStatus: (p) => inspectAccountAuthStatus(p),
    })

    pool.reportFailure(a1.id, 'claude-sonnet', 'HTTP 429 rate limit')
    const lease = await pool.acquire('sess-1', 'gemini-4-neon')
    assert.ok(lease.accountId)

    // Add second account and update label of first while lease is live
    store.addAccount({ label: 'Account Two', id: 'acct-2' })
    store.updateAccount({ accountId: 'acct-1', label: '主力一号' })
    pool.syncProfiles(store.buildEffectiveProfiles())

    const snaps = pool.getHealthSnapshots()
    assert.deepEqual(snaps.map((s) => s.id), ['default', 'acct-1', 'acct-2'])
    const snap1 = snaps.find((s) => s.id === 'acct-1')!
    assert.equal(snap1.label, '主力一号')
    assert.equal(snap1.proxyDisplay, 'http://***@127.0.0.1:7890')
    assert.equal(snap1.editable, true)
    assert.equal(snap1.canInteractiveLogin, true)
    assert.equal(snap1.authStatus, 'not_logged_in')
    assert.ok(snap1.families.claude?.cooldownUntil)

    lease.release()
    pool.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AgyInstaller manages one-click install/update, concurrency lock, proxy validation, and completion callback', async () => {
  let installedPath: string | null = null
  let callbackBin = ''
  const installer = new AgyInstaller({
    resolveBin: () => installedPath,
    platform: 'linux',
    onInstalled: (bin) => {
      callbackBin = bin
    },
    runner: async (ctx) => {
      assert.equal(ctx.env.HTTPS_PROXY, 'http://127.0.0.1:7890')
      ctx.appendLog('Downloading agy binary...')
      installedPath = '/home/tester/.local/bin/agy'
      ctx.appendLog('Installed agy 1.5.17')
    },
  })

  // Invalid proxy URL rejected synchronously
  assert.throws(() => installer.start({ action: 'install', proxyUrl: 'ftp://bad-proxy' }), /代理协议/)
  // Cannot update when agy is not yet installed
  assert.throws(() => installer.start({ action: 'update' }), /未找到已安装的 agy/)

  const started = installer.start({ action: 'install', proxyUrl: 'http://127.0.0.1:7890' })
  assert.equal(started.state, 'running')
  assert.throws(() => installer.start({ action: 'install' }), /正在进行中/)

  const done = await installer.waitForCompletion()
  assert.equal(done.state, 'succeeded')
  assert.equal(callbackBin, '/home/tester/.local/bin/agy')
  assert.ok(done.logs.some((l) => l.includes('Installed agy 1.5.17')))
  installer.dispose()
})

test('AccountLoginManager extracts Google OAuth URL, submits auth code over stdin, and reports success/failure', async t => {
  let succeededAccount = ''
  const fakeLoginScript = [
    'const readline = require("node:readline");',
    'console.log("Open this link in a browser to log in with Google:");',
    'console.log("  https://accounts.google.com/o/oauth2/auth?client_id=test&state=xyz");',
    'const rl = readline.createInterface({ input: process.stdin });',
    'rl.once("line", (line) => {',
    '  if (line.trim() === "GOOD_AUTH_CODE") { console.log("Login complete"); process.exit(0); }',
    '  console.error("invalid_grant: expired code"); process.exit(1);',
    '});',
  ].join('\n')

  const manager = new AccountLoginManager({
    spawnFn: (_bin, _args, opts) =>
      spawn(process.execPath, ['-e', fakeLoginScript], {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    onLoginSuccess: (accountId) => {
      succeededAccount = accountId
    },
  })

  t.after(() => manager.dispose())

  // 1. Happy path
  const started = await manager.startLogin({
    accountId: 'us-main',
    accountLabel: '主力号',
    bin: 'mock-agy',
    cwd: process.cwd(),
  })
  assert.equal(started.state, 'awaiting_code')
  assert.equal(started.authUrl, 'https://accounts.google.com/o/oauth2/auth?client_id=test&state=xyz')

  const finished = await manager.submitCode(started.loginId, 'GOOD_AUTH_CODE')
  assert.equal(finished.state, 'succeeded')
  assert.equal(manager.getActiveSnapshot(), null)
  assert.equal(succeededAccount, 'us-main')

  // 2. Rejected code path
  const started2 = await manager.startLogin({
    accountId: 'us-main',
    accountLabel: '主力号',
    bin: 'mock-agy',
    cwd: process.cwd(),
  })
  await assert.rejects(manager.submitCode(started2.loginId, 'BAD_CODE'), /invalid_grant/)
  assert.equal(manager.getActiveSnapshot()?.state, 'failed')

  // 3. Cancel path
  const started3 = await manager.startLogin({
    accountId: 'us-main',
    accountLabel: '主力号',
    bin: 'mock-agy',
    cwd: process.cwd(),
  })
  manager.cancelLogin(started3.loginId)
  assert.equal(manager.getActiveSnapshot(), null)
})

test('HTTP routes expose env check/install, managed account CRUD, and login flow behind JSON checks', async () => {
  const routes = new Map<string, ExactRouteSpec['handler']>()
  const webServer: WebServerLike = {
    register(spec) {
      routes.set(spec.path, spec.handler)
      return () => routes.delete(spec.path)
    },
  }

  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-agy-routes-'))
  try {
    const store = new AccountStore({ filePath: path.join(dir, 'accounts.json'), accountsRootDir: path.join(dir, 'accounts') })
    const accountPool = new MultiAccountPool({ accounts: store.buildEffectiveProfiles() })
    const pool = new AcpSessionPool({
      ...fakeHost,
      getConfig: () => resolveConfig(),
      resolveBin: () => null,
      accountProvider: accountPool,
    })

    const dispose = registerAcpRoutes(webServer, pool, {
      connection: { requestRejection: () => undefined },
      addAccount: async (body) => {
        const rec = store.addAccount(body)
        accountPool.syncProfiles(store.buildEffectiveProfiles())
        return rec
      },
      updateAccount: async (body) => {
        const res = store.updateAccount(body)
        accountPool.syncProfiles(store.buildEffectiveProfiles())
        return res
      },
      removeAccount: async (id, opts) => {
        store.removeAccount(id, opts)
        accountPool.syncProfiles(store.buildEffectiveProfiles())
      },
      startAccountLogin: async ({ accountId, proxyUrl }) => ({
        loginId: accountId ? 'login-existing' : 'login-new',
        accountId: accountId ?? 'pending-abc',
        accountLabel: accountId ? 'Test' : '新 Google 账号',
        ...(accountId ? {} : { isNewAccount: true }),
        ...(proxyUrl ? { proxyDisplay: maskProxyUrlForDisplay(proxyUrl) } : {}),
        state: 'awaiting_code',
        authUrl: 'https://accounts.google.com/o/oauth2/auth?mock=1',
        message: '等待授权码',
        startedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }),
    })

    const invoke = postJsonTo(routes)

    const added = await invoke('/plugins/agy-acp/accounts/add', { label: 'JP Backup', proxyUrl: 'http://127.0.0.1:7891' })
    assert.equal(added.statusCode, 200)
    assert.equal((added.json.account as { id: string }).id, 'jp-backup')
    assert.equal(((added.json.status as StatusSnapshot).accounts).length, 2)

    const loginStarted = await invoke('/plugins/agy-acp/accounts/login/start', { accountId: 'jp-backup' })
    assert.equal(loginStarted.statusCode, 200)
    assert.match((loginStarted.json.login as { authUrl: string }).authUrl, /^https:\/\/accounts\.google\.com/)

    // Direct zero-form new-account OAuth login (no accountId required)
    const directNewLogin = await invoke('/plugins/agy-acp/accounts/login/start', { proxyUrl: 'http://127.0.0.1:7892' })
    assert.equal(directNewLogin.statusCode, 200)
    assert.equal((directNewLogin.json.login as { isNewAccount?: boolean }).isNewAccount, true)
    assert.equal((directNewLogin.json.login as { proxyDisplay?: string }).proxyDisplay, 'http://127.0.0.1:7892')

    const updated = await invoke('/plugins/agy-acp/accounts/update', { accountId: 'jp-backup', enabled: false })
    assert.equal(updated.statusCode, 200)
    assert.equal(
      (updated.json.status as StatusSnapshot).accounts.find((a) => a.id === 'jp-backup')?.enabled,
      false,
    )

    const removed = await invoke('/plugins/agy-acp/accounts/remove', { accountId: 'jp-backup', purgeData: true })
    assert.equal(removed.statusCode, 200)
    assert.equal(((removed.json.status as StatusSnapshot).accounts).length, 1)

    dispose()
    pool.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST accounts/select persists the preference and the scheduler honors it only when eligible', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-agy-account-select-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const options = { filePath: path.join(dir, 'accounts.json'), accountsRootDir: path.join(dir, 'accounts') }
  const store = new AccountStore(options)
  const main = store.addAccount({ label: 'Main' })
  const backup = store.addAccount({ label: 'Backup' })
  store.updateAccount({ accountId: DEFAULT_ACCOUNT_ID, enabled: false })
  const accountPool = new MultiAccountPool({ accounts: store.buildEffectiveProfiles() })
  const pool = new AcpSessionPool({
    ...fakeHost,
    getConfig: () => resolveConfig(),
    resolveBin: () => null,
    accountProvider: accountPool,
  })
  t.after(() => pool.dispose())

  const routes = new Map<string, ExactRouteSpec['handler']>()
  const dispose = registerAcpRoutes({
    register(spec) {
      routes.set(spec.path, spec.handler)
      return () => routes.delete(spec.path)
    },
  }, pool, {
    connection: { requestRejection: () => undefined },
    selectAccount: accountId => {
      store.setPreferredAccount(accountId)
      pool.switchActiveAccount(accountId)
    },
  })
  t.after(dispose)

  const post = postJsonTo(routes)
  const select = (accountId: string | null) => post('/plugins/agy-acp/accounts/select', { accountId })
  const model = 'claude-sonnet'
  const acquire = async (excluded?: ReadonlySet<string>) => {
    const lease = await accountPool.acquire('conversation', model, excluded)
    lease.release()
    return lease.accountId
  }

  accountPool.updateQuota(main.id, 'claude', { fiveHour: { remainingFraction: 0.9 } })
  accountPool.updateQuota(backup.id, 'claude', { fiveHour: { remainingFraction: 0.2 } })
  assert.equal(await acquire(), main.id)

  const selected = await select(backup.id)
  assert.equal(selected.statusCode, 200)
  assert.equal(selected.json.ok, true)
  const status = selected.json.status as StatusSnapshot
  assert.equal(status.preferredAccountId, backup.id)
  assert.equal(status.accounts.find(a => a.id === backup.id)?.isPreferred, true)
  assert.equal(status.accounts.find(a => a.id === backup.id)?.isEffectiveActive, true)
  assert.equal(new AccountStore(options).getPreferredAccountId(), backup.id)
  assert.equal(await acquire(), backup.id, 'selected account wins over quota ranking and existing stickiness')

  assert.equal((await select('missing')).statusCode, 404)
  assert.equal((await select(DEFAULT_ACCOUNT_ID)).statusCode, 409)
  assert.equal(new AccountStore(options).getPreferredAccountId(), backup.id)
  assert.equal(await acquire(new Set([backup.id])), main.id)
  assert.equal(await acquire(), backup.id, 'preference also wins over failover stickiness')

  accountPool.reportFailure(backup.id, model, 'HTTP 429 rate limit')
  assert.equal(await acquire(), main.id)
  assert.equal(accountPool.getPreferredAccountId(), backup.id, 'cooldown does not clear the preference')
  accountPool.clearCooldown(backup.id)
  assert.equal(await acquire(), backup.id)

  const auto = await select(null)
  assert.equal(auto.statusCode, 200)
  assert.equal(auto.json.ok, true)
  assert.equal((auto.json.status as StatusSnapshot).preferredAccountId, null)
  assert.equal(new AccountStore(options).getPreferredAccountId(), null)
  assert.equal(await acquire(), main.id, 'auto mode resumes quota ranking without old stickiness')
})

test('EnvSetupBanner and AccountsPanel SSR render one-click install CTA and in-panel Google login wizard', () => {
  const noop = () => {}

  const missingHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(EnvSetupBanner, {
      environment: {
        platform: 'linux',
        agyFound: false,
        agyBinPath: null,
        agyVersion: null,
        manualInstallCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
      },
      applyStatus: noop,
    }),
  )
  assert.match(missingHtml, /一键安装 agy/)
  assert.match(missingHtml, /一键环境检查/)
  assert.match(missingHtml, /antigravity\.google\/cli\/install\.sh/)

  const readyHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(EnvSetupBanner, {
      environment: {
        platform: 'linux',
        agyFound: true,
        agyBinPath: '/home/u/.local/bin/agy',
        agyVersion: '1.5.17',
        manualInstallCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
      },
      applyStatus: noop,
    }),
  )
  assert.match(readyHtml, /本地环境已就绪/)
  assert.match(readyHtml, /1\.5\.17/)

  const accountsHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(AccountsPanel, {
      accounts: [
        {
          id: 'us-main',
          label: '主力号 (US)',
          enabled: true,
          source: 'managed',
          authStatus: 'not_logged_in',
          proxyDisplay: 'http://127.0.0.1:7890',
          hasProxy: true,
          editable: true,
          canInteractiveLogin: true,
          hasSandboxHome: true,
          activeLeases: 0,
          families: {},
          lastError: null,
          lastUsedAt: null,
        },
      ],
      agyFound: true,
      activeLogin: {
        loginId: 'l1',
        accountId: 'pending-1',
        accountLabel: '新 Google 账号',
        isNewAccount: true,
        state: 'awaiting_code',
        authUrl: 'https://accounts.google.com/o/oauth2/auth?mock=1',
        message: '请在浏览器完成授权',
        startedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
      applyStatus: noop,
    }),
  )
  assert.match(accountsHtml, /\+ 添加账号/)
  assert.match(accountsHtml, /添加新账号 · Google OAuth 登录/)
  assert.match(accountsHtml, /为此账号指定专属代理/)
  assert.match(accountsHtml, /控制台托管/)
  assert.match(accountsHtml, /待登录/)
  assert.match(accountsHtml, /打开 Google 登录页/)
  assert.match(accountsHtml, /提交完成登录/)
})

test('AccountsPanel SSR identifies the selected account, offers switching, and collapses disabled default', () => {
  const base = {
    enabled: true,
    source: 'managed',
    authStatus: 'logged_in',
    editable: true,
    canInteractiveLogin: true,
    hasSandboxHome: true,
    activeLeases: 0,
    families: {},
    lastError: null,
    lastUsedAt: null,
  } as const
  const accounts: AccountHealthSnapshot[] = [
    { ...base, id: 'alice', label: 'Alice@example.com', email: 'Alice@example.com', isPreferred: true, isEffectiveActive: true },
    { ...base, id: 'backup', label: 'Backup' },
    { ...base, id: DEFAULT_ACCOUNT_ID, label: '本机默认账号', source: 'default', enabled: false, editable: false },
  ]
  const render = (preferredAccountId: string | null, snapshots: AccountHealthSnapshot[]) =>
    ReactDOMServer.renderToStaticMarkup(React.createElement(AccountsPanel, {
      accounts: snapshots, preferredAccountId, applyStatus: () => {},
    }))
  const html = render('alice', accounts)

  assert.match(html, /class="agy-acp-active-bar" role="status"[^]*?当前使用：<strong>Alice@example\.com<\/strong>/)
  assert.match(html, /<h4[^>]*>Alice@example\.com<\/h4><span[^>]*>当前使用<\/span>/)
  assert.match(html, /<button[^>]*aria-label="切换到账号 Backup"[^>]*>使用此账号<\/button>/)
  assert.doesNotMatch(html, /aria-label="切换到账号 Alice@example\.com"/)
  assert.match(html, /<button[^>]*>切为自动轮换<\/button>/)
  assert.match(html, /<div class="agy-acp-collapsed-default"><span[^>]*>已停用：本机默认账号 \(default\)[^<]*<\/span><button[^>]*>启用<\/button>/)
  assert.doesNotMatch(html, /<h4[^>]*>本机默认账号/)

  const autoHtml = render(null, accounts.map(a => ({ ...a, isPreferred: false, isEffectiveActive: false })))
  assert.match(autoHtml, /当前模式：<strong>自动轮换（2 个可用账号）<\/strong>/)
  assert.doesNotMatch(autoHtml, /切为自动轮换|>当前使用<\/span>/)
})

test('Direct OAuth onboarding auto-detects Google email, replaces same-email credentials in place, and cleans up cancelled runs', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-agy-direct-oauth-'))
  try {
    const store = new AccountStore({ filePath: path.join(dir, 'accounts.json'), accountsRootDir: path.join(dir, 'accounts') })
    store.load()

    // 1. Identity detection from JWT id_token (no network needed)
    const pending1 = store.preparePendingAccountHome('run1')
    const jwtPayload = Buffer.from(JSON.stringify({ email: 'Alice.Work@gmail.com', name: 'Alice' })).toString('base64url')
    writeFileSync(
      path.join(pending1, '.gemini', 'antigravity-acp', 'antigravity-oauth-token'),
      JSON.stringify({ token: { access_token: 'tok-1', id_token: `hdr.${jwtPayload}.sig` } }),
      { mode: 0o600 },
    )
    const id1 = await detectAccountIdentityFromHome(pending1)
    assert.equal(id1.email, 'Alice.Work@gmail.com')
    assert.equal(id1.name, 'Alice')

    const committed1 = store.commitPendingAccount({
      pendingId: 'run1', email: id1.email, name: id1.name, proxyUrl: 'http://127.0.0.1:7891',
    })
    assert.equal(committed1.id, 'alice-work')
    assert.equal(committed1.label, 'Alice.Work@gmail.com')
    assert.equal(existsSync(pending1), false)
    const aliceHome = store.resolveManagedAccountHome(committed1.id)
    assert.equal(hasLocalOAuthTokenFile(aliceHome), true)
    store.updateAccount({ accountId: committed1.id, label: 'Alice Work (custom)' })
    store.setPreferredAccount(null)
    store.load()
    assert.equal(store.getPreferredAccountId(), null)

    // 2. Userinfo fallback resolves the same email despite case and the custom label.
    const pending2 = store.preparePendingAccountHome('run2')
    const cliTokenPath = path.join('.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    const refreshedToken = { token: { access_token: 'tok-2' } }
    writeFileSync(path.join(pending2, cliTokenPath), JSON.stringify(refreshedToken), { mode: 0o600 })
    const id2 = await detectAccountIdentityFromHome(pending2, {
      fetcher: async () => ({
        statusCode: 200,
        headers: {},
        body: JSON.stringify({ email: 'alice.work@gmail.com', name: 'Alice Backup' }),
      }),
    })
    assert.equal(id2.email, 'alice.work@gmail.com')
    const committed2 = store.commitPendingAccount({ pendingId: 'run2', email: id2.email, proxyUrl: 'http://127.0.0.1:7890' })
    assert.equal(committed2.id, 'alice-work')
    assert.equal(committed2.label, 'Alice Work (custom)')
    assert.equal(committed2.email, 'alice.work@gmail.com')
    assert.equal(committed2.createdAt, committed1.createdAt)
    assert.equal(committed2.proxyUrl, 'http://127.0.0.1:7890')
    assert.equal(existsSync(pending2), false)
    assert.equal(existsSync(path.join(aliceHome, '.gemini', 'antigravity-acp', 'antigravity-oauth-token')), false)
    assert.deepEqual(JSON.parse(readFileSync(path.join(aliceHome, cliTokenPath), 'utf8')), refreshedToken)
    store.load()
    assert.deepEqual(store.listManaged(), [committed2])
    assert.equal(store.getPreferredAccountId(), committed2.id)

    // 3. AccountLoginManager invokes onBeforeSuccess on exit 0 and onCleanup on cancel
    let cleanupCount = 0
    const pending3 = store.preparePendingAccountHome('run3')
    const fakeLoginScript = [
      'const readline = require("node:readline");',
      'console.log("https://accounts.google.com/o/oauth2/auth?client_id=test");',
      'const rl = readline.createInterface({ input: process.stdin });',
      'rl.once("line", (line) => {',
      '  if (line.trim() === "OK") { console.log("Logged in as bob@example.com"); process.exit(0); }',
      '  process.exit(1);',
      '});',
    ].join('\n')

    const manager = new AccountLoginManager({
      spawnFn: (_bin, _args, opts) =>
        spawn(process.execPath, ['-e', fakeLoginScript], {
          cwd: opts.cwd,
          env: opts.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
    })

    t.after(() => manager.dispose())

    const started = await manager.startLogin({
      accountId: 'pending-run3',
      accountLabel: '新 Google 账号',
      isNewAccount: true,
      bin: 'mock-agy',
      cwd: process.cwd(),
      onBeforeSuccess: async ({ outputLog }) => {
        const detected = await detectAccountIdentityFromHome(pending3, { outputText: outputLog })
        const rec = store.commitPendingAccount({ pendingId: 'run3', email: detected.email })
        return { accountId: rec.id, accountLabel: rec.label }
      },
      onCleanup: () => {
        cleanupCount++
        store.cleanupPendingAccountHome('run3')
      },
    })
    const done = await manager.submitCode(started.loginId, 'OK')
    assert.equal(done.state, 'succeeded')
    assert.equal(manager.getActiveSnapshot(), null)
    assert.equal(done.accountId, 'bob')
    assert.equal(done.accountLabel, 'bob@example.com')
    assert.equal(cleanupCount, 0)
    assert.equal(existsSync(store.resolveManagedAccountHome('bob')), true)

    // Cancelled pending login cleans up temp home and leaves no orphan account
    const pending4 = store.preparePendingAccountHome('run4')
    const startedCancel = await manager.startLogin({
      accountId: 'pending-run4',
      accountLabel: '新 Google 账号',
      isNewAccount: true,
      bin: 'mock-agy',
      cwd: process.cwd(),
      onCleanup: () => {
        cleanupCount++
        store.cleanupPendingAccountHome('run4')
      },
    })
    manager.cancelLogin(startedCancel.loginId)
    assert.equal(cleanupCount, 1)
    assert.equal(existsSync(pending4), false)
    assert.deepEqual(store.listManaged().map(a => a.id), ['alice-work', 'bob'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('default account auth verification persists across reload, detects ambient env stores, and reacts to auth failures', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-agy-default-auth-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const options = { filePath: path.join(dir, 'accounts.json'), accountsRootDir: path.join(dir, 'accounts') }
  const store = new AccountStore(options)
  store.addAccount({ label: 'Managed One', id: 'managed-one' })
  assert.equal(store.isDefaultAuthVerified(), false)

  // Persists default login verification even when managed accounts coexist
  assert.equal(store.setDefaultAuthVerified(true), true)
  assert.equal(store.setDefaultAuthVerified(true), false)
  assert.equal(store.isDefaultAuthVerified(), true)
  const reloaded = new AccountStore(options)
  assert.equal(reloaded.isDefaultAuthVerified(), true)
  assert.equal(reloaded.listManaged().length, 1)

  const defaultProfile = reloaded.buildEffectiveProfiles().find(p => p.id === DEFAULT_ACCOUNT_ID)!
  const emptyEnv: NodeJS.ProcessEnv = { HOME: path.join(dir, 'empty-home') }
  assert.equal(
    inspectAccountAuthStatus(defaultProfile, { defaultConnected: true, env: emptyEnv }),
    'logged_in',
  )
  assert.equal(
    inspectAccountAuthStatus(defaultProfile, { defaultConnected: true, defaultAuthFailed: true, env: emptyEnv }),
    'not_logged_in',
  )

  // Ambient GEMINI_HOME & ANTIGRAVITY_APP_DATA_DIR token files are recognized safely
  const customGemini = path.join(dir, 'custom-gemini')
  const customCliDir = path.join(customGemini, 'antigravity-cli')
  mkdirSync(customCliDir, { recursive: true, mode: 0o700 })
  writeFileSync(
    path.join(customCliDir, 'antigravity-oauth-token'),
    JSON.stringify({ access_token: 'fixture-ambient-token' }),
    { mode: 0o600 },
  )
  assert.equal(
    inspectAccountAuthStatus(defaultProfile, { env: { ...emptyEnv, GEMINI_HOME: customGemini } }),
    'logged_in',
  )
  assert.equal(
    inspectAccountAuthStatus(defaultProfile, { env: { ...emptyEnv, ANTIGRAVITY_APP_DATA_DIR: customCliDir } }),
    'logged_in',
  )

  // MultiAccountPool auth observation hooks work without clearing cooldowns on markAuthVerified
  assert.equal(isAuthFailureError(new Error('HTTP 401 Unauthorized: please log in')), true)
  assert.equal(isAuthFailureError(new Error('Unauthenticated: invalid_grant')), true)
  assert.equal(isAuthFailureError(new Error('HTTP 429 rate limit')), false)

  const observed: Array<{ id: string; state: 'verified' | 'failed' }> = []
  let authFailed = false
  const accountPool = new MultiAccountPool({
    accounts: reloaded.buildEffectiveProfiles(),
    inspectAuthStatus: profile =>
      inspectAccountAuthStatus(profile, {
        defaultConnected: profile.id === DEFAULT_ACCOUNT_ID && reloaded.isDefaultAuthVerified(),
        defaultAuthFailed: profile.id === DEFAULT_ACCOUNT_ID && authFailed,
        env: emptyEnv,
      }),
    onAuthObserved: (accountId, state) => {
      observed.push({ id: accountId, state })
      if (accountId === DEFAULT_ACCOUNT_ID) {
        authFailed = state === 'failed'
        reloaded.setDefaultAuthVerified(state === 'verified')
      }
    },
  })
  t.after(() => accountPool.dispose())

  assert.equal(accountPool.getHealthSnapshots().find(a => a.id === DEFAULT_ACCOUNT_ID)?.authStatus, 'logged_in')

  // Rate-limit failure sets cooldown but does NOT revoke auth status
  accountPool.reportFailure(DEFAULT_ACCOUNT_ID, 'claude-sonnet', new Error('HTTP 429 rate limit'))
  assert.equal(accountPool.getHealthSnapshots().find(a => a.id === DEFAULT_ACCOUNT_ID)?.authStatus, 'logged_in')
  assert.ok(accountPool.getHealthSnapshots().find(a => a.id === DEFAULT_ACCOUNT_ID)?.families.claude?.cooldownUntil)

  // markAuthVerified does NOT clear existing cooldowns
  accountPool.markAuthVerified(DEFAULT_ACCOUNT_ID)
  assert.ok(accountPool.getHealthSnapshots().find(a => a.id === DEFAULT_ACCOUNT_ID)?.families.claude?.cooldownUntil)

  // Real auth error flips default to not_logged_in and clears persisted verification
  accountPool.reportFailure(DEFAULT_ACCOUNT_ID, 'claude-sonnet', new Error('Unauthenticated: login required'))
  assert.equal(accountPool.getHealthSnapshots().find(a => a.id === DEFAULT_ACCOUNT_ID)?.authStatus, 'not_logged_in')
  assert.equal(reloaded.isDefaultAuthVerified(), false)

  // Subsequent success restores logged_in
  accountPool.reportSuccess(DEFAULT_ACCOUNT_ID, 'claude-sonnet')
  assert.equal(accountPool.getHealthSnapshots().find(a => a.id === DEFAULT_ACCOUNT_ID)?.authStatus, 'logged_in')
  assert.equal(reloaded.isDefaultAuthVerified(), true)
  assert.ok(observed.some(e => e.id === DEFAULT_ACCOUNT_ID && e.state === 'failed'))
  assert.ok(observed.some(e => e.id === DEFAULT_ACCOUNT_ID && e.state === 'verified'))
})

test('AccountLoginManager finalizes automatic browser-callback exit-0 without stdin code', async t => {
  let beforeSuccessCount = 0
  const succeededIds: string[] = []
  let spawnedChild: ReturnType<typeof spawn> | null = null
  const loopbackLoginScript = [
    'console.log("Open this link in a browser:");',
    'console.log("  https://accounts.google.com/o/oauth2/auth?client_id=loopback&state=abc");',
    'process.once("message", () => { console.log("Logged in as default-user@example.com"); process.exit(0); });',
  ].join('\n')

  const manager = new AccountLoginManager({
    spawnFn: (_bin, _args, opts) => {
      spawnedChild = spawn(process.execPath, ['-e', loopbackLoginScript], {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      })
      return spawnedChild
    },
    onLoginSuccess: accountId => {
      succeededIds.push(accountId)
    },
  })
  t.after(() => manager.dispose())

  const done = new Promise<void>(resolve => {
    manager.on('change', () => {
      if (manager.getActiveSnapshot() === null && succeededIds.length > 0) resolve()
    })
  })

  const started = await manager.startLogin({
    accountId: DEFAULT_ACCOUNT_ID,
    accountLabel: '本机默认账号',
    bin: 'mock-agy',
    cwd: process.cwd(),
    onBeforeSuccess: async () => {
      beforeSuccessCount++
    },
  })
  assert.equal(started.state, 'awaiting_code')
  spawnedChild!.send('complete')
  await done
  assert.equal(beforeSuccessCount, 1)
  assert.deepEqual(succeededIds, [DEFAULT_ACCOUNT_ID])
  assert.equal(manager.getActiveSnapshot(), null)
})

test('AccountsPanel SSR renders default account auth states accurately without misleading login prompts', () => {
  const mkDefault = (authStatus: AccountHealthSnapshot['authStatus']): AccountHealthSnapshot => ({
    id: DEFAULT_ACCOUNT_ID,
    label: '本机默认账号',
    enabled: true,
    isEffectiveActive: true,
    source: 'default',
    authStatus,
    editable: false,
    canInteractiveLogin: true,
    hasSandboxHome: false,
    activeLeases: 0,
    families: {},
    lastError: null,
    lastUsedAt: null,
  })
  const renderOne = (authStatus: AccountHealthSnapshot['authStatus']) =>
    ReactDOMServer.renderToStaticMarkup(
      React.createElement(AccountsPanel, { accounts: [mkDefault(authStatus)], applyStatus: () => {} }),
    )

  const loggedInHtml = renderOne('logged_in')
  assert.match(loggedInHtml, />已登录<\/span>/)
  assert.match(loggedInHtml, />重新登录<\/button>/)
  assert.doesNotMatch(loggedInHtml, />登录账号<\/button>/)

  const unknownHtml = renderOne('unknown')
  assert.match(unknownHtml, />本机凭据<\/span>/)
  assert.match(unknownHtml, />重新登录<\/button>/)
  assert.doesNotMatch(unknownHtml, />待登录<\/span>/)
  assert.doesNotMatch(unknownHtml, />登录账号<\/button>/)

  const notLoggedInHtml = renderOne('not_logged_in')
  assert.match(notLoggedInHtml, />待登录<\/span>/)
  assert.match(notLoggedInHtml, />登录账号<\/button>/)
})
