import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import net, { type AddressInfo } from 'node:net'
import test from 'node:test'
import {
  DEFAULT_EGRESS_PROBES,
  EgressBlockedError,
  EgressGuard,
  evaluateGoogleAiStudioProbe,
  evaluateGoogleCloudCodeProbe,
  parseCloudflareTrace,
  parseIpSbGeoIp,
  resolveProxyForUrl,
  shouldBypassProxy,
} from '../src/runtime/egress-guard.ts'

// Ephemeral throwaway self-signed localhost TLS key/cert strictly for offline 127.0.0.1 loopback tests.
const TEST_TLS_KEY = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDU0+cVD4WO5bqw',
  'ETbMGifZ40R1V32G37vdcG2eQvarObrShLOzpjN1UYCAFr6dh2A51Ezv5rVjIDIs',
  '6ryFxQOSYtMlfBWveDiqUE6mooTQAjbM1X4gbl8ZktaOY3IURV2Sb6XDD5Na/UPS',
  'XsUSFZ6qjvtmiSl6v2BGaosOqAkGVCtDwKhkHMU4L9SJ9vOgSh2lRu3FRjol9LPH',
  'ralVPpic+m4bK/wbkCKQrwpDveaLS2UwQAZpX06XauqpUZw5oNmNzdiW5gpE/UyJ',
  '6Nz50aNByk9od8PeTv5P8vG+MpCN+eXK0hBJOESTiY4DR7FhpM6E7lhD6qNI/rUz',
  '+0AZGJdbAgMBAAECggEAByE4LxTviPt6NxbEiq7foeWCsBmnu2J4ZTE0guZEZDUR',
  'ZKcMbBrHw4jg8KmSZi2YVCegEjNc5T65X5bXjPWuKnPEFg/jnBa/czkwgVWVdHB2',
  'jIMkcAqyheVM6cU8F6DBQzwZRgEaEyTD5mLFYFc4EweqNWOn75REsec01F9dugf9',
  'LMKRYlksK3UxDbsNMuW+cuf3g7yC7T5e0ouBLq3WsY/gPiA9B8+ENoDQCpVQn6/5',
  '8gmx3FUXybE/9CW6Lhh5Xva5AQ30xtuFnsuNMKmvLa25KYXngV6cAfKWkKbhZloF',
  'H1AdQOfgdsfBs43Je/vDcIWyPVV9mzvJaKGjeygGGQKBgQDtmrEF3vSzNajYw4mE',
  '4AjWL5omR6IS/hjpxBfuR6YEjty0ZORgqlAb54gHrNleqVeEfxV4qL2O4oXBT14b',
  'A52rEfusHKeMQ9Dm3azusvdM+dxu9yr5uJ55mCWNUgk6bGX/A2iijZkzBqscIxYI',
  'SpmHvC0vXj3QCflQtxut4Mm2YwKBgQDlTiQyxEo7kDcNKGtXjZkZNZyjnKeD8PZs',
  'zOssbWHZNjgZrOU8LDdWH3E44T5KUQEnpI6NSGuhpfc3w4Npcd6hdevyUavTjdGu',
  '65ZbggsJdMYxOBlOdW6YICZqofrOYROzUY7KuIQmDc4fZt7tRU5j19azW9MT4Dxp',
  'gt9xAyMQqQKBgGPpVmLnm/H3sGZl4t/S7SRTo/hQyuA9pPA3mvCBhFgKUtgwTLAx',
  'LbpuI49GqajagIigf8DbA8qfiir9Ws71OEmFKFT5P6MFqURLFrrQ2pitwHmQyat0',
  'bH8o8TF5u5OrnUAciNVBwZfpR+5u+obGB8VB5aYzdL6UUxgTxznYejmNAoGBANDd',
  'Z21yjCdLCkoK6hN639wtkDsbYx50axHZadEy5PDEST9h1AAGSnVA+JGV4XYx6Lpi',
  'UpJwR9Ga6d86UEXIucAaOEulhryRLlCFOJSrlEANxMVqUuq7XnxktHlmh5xaomYw',
  'wL74aS58XqcNvbsj6O5a2K7Q0igFlSGKWtqGv/bZAoGBAOEItX54u2q8ITkHOAop',
  'pkFAZNZZrIkrL5ekMhhZq6KNjJGPybnszejfztAB+62+xAYLZ2FsqL7KTlOifRZn',
  'RcHNFDiz3Plz9J60d8UnQJfYWQQY3ArND3qkCiCHnshgNLYSQCfU57bEphPkA0QJ',
  'IpvulwULF0me1QfcUcVYb7fr',
  '-----END PRIVATE KEY-----',
].join('\n')

const TEST_TLS_CERT = [
  '-----BEGIN CERTIFICATE-----',
  'MIIDCTCCAfGgAwIBAgIUDjuF1EOa4FBWE/K7bPBI00a4FXowDQYJKoZIhvcNAQEL',
  'BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTEyNTA0MjU1OVoXDTM2MTEy',
  'MjA0MjU1OVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF',
  'AAOCAQ8AMIIBCgKCAQEA1NPnFQ+FjuW6sBE2zBon2eNEdVd9ht+73XBtnkL2qzm6',
  '0oSzs6YzdVGAgBa+nYdgOdRM7+a1YyAyLOq8hcUDkmLTJXwVr3g4qlBOpqKE0AI2',
  'zNV+IG5fGZLWjmNyFEVdkm+lww+TWv1D0l7FEhWeqo77Zokper9gRmqLDqgJBlQr',
  'Q8CoZBzFOC/UifbzoEodpUbtxUY6JfSzx62pVT6YnPpuGyv8G5AikK8KQ73mi0tl',
  'MEAGaV9Ol2rqqVGcOaDZjc3YluYKRP1Miejc+dGjQcpPaHfD3k7+T/LxvjKQjfnl',
  'ytIQSThEk4mOA0exYaTOhO5YQ+qjSP61M/tAGRiXWwIDAQABo1MwUTAdBgNVHQ4E',
  'FgQUF0OUBVibSpDWDvvCE1EfZrI265swHwYDVR0jBBgwFoAUF0OUBVibSpDWDvvC',
  'E1EfZrI265swDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAwIe4',
  '0GSJQFdaFb5hnhEQUh1TmD8M+FecSjDrXQGrhymcXGizl4XH35LMGUWb5IL6OOeZ',
  'HEQgAwBCf10GIGzp98jnfwkW1MMJzSt3pJahhUc4k+hWy2BUh1xczqMvJulxWuBN',
  'pIdl1X1VcKVL3p/gMFr9cCjSOFU4P6RUW4w4gYtFlYCMvHl/db5FleDrY7ejAEOJ',
  '0DRGN4mrrKxMq4c0znIFSd4IWOsGBzRZnjwKLZX7k8i5au6kbAP2p1c38oPGaXMW',
  'KWN1oWP1GOOeIeS+57Ym9PXUzdF1VkK6dIMtm3pea+gSmzkC7EUxED2/Q8SDfKNR',
  'fH8r+2qv3eHRDQyV2w==',
  '-----END CERTIFICATE-----',
].join('\n')

function trackServer<T extends net.Server>(srv: T): { server: T; close: () => Promise<void> } {
  const sockets = new Set<net.Socket>()
  srv.on('connection', (sock: net.Socket) => {
    sockets.add(sock)
    sock.once('close', () => sockets.delete(sock))
  })
  srv.on('secureConnection', (sock: net.Socket) => {
    sockets.add(sock)
    sock.once('close', () => sockets.delete(sock))
  })
  return {
    server: srv,
    close: () => {
      for (const sock of sockets) sock.destroy()
      sockets.clear()
      ;(srv as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
      return new Promise((resolve) => srv.close(() => resolve()))
    },
  }
}

test('HTTP CONNECT proxy tunnel (with Basic Auth & NO_PROXY bypass) upgrades TLS and never leaks credentials', async () => {
  let traceLoc = 'US'
  let traceIp = '203.0.113.19'
  const trackedTarget = trackServer(
    https.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (req, res) => {
      if (req.url === '/cdn-cgi/trace') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(`fl=12f\nip=${traceIp}\nloc=${traceLoc}\n`)
        return
      }
      res.writeHead(404)
      res.end()
    }),
  )
  const targetServer = trackedTarget.server
  await new Promise<void>((resolve) => targetServer.listen(0, '127.0.0.1', () => resolve()))
  const targetPort = (targetServer.address() as AddressInfo).port

  const connectCalls: Array<{ authority: string; authHeader: string | undefined }> = []
  const expectedAuth = `Basic ${Buffer.from('proxyUser:superSecretPass999').toString('base64')}`

  const trackedProxy = trackServer(
    http.createServer((_req, res) => {
      res.writeHead(405)
      res.end()
    }),
  )
  const httpProxy = trackedProxy.server
  httpProxy.on('connect', (req, clientSocket, head) => {
    connectCalls.push({
      authority: req.url ?? '',
      authHeader: req.headers['proxy-authorization'] as string | undefined,
    })
    if (req.headers['proxy-authorization'] !== expectedAuth) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
      clientSocket.destroy()
      return
    }
    const upstream = net.connect({ host: '127.0.0.1', port: targetPort }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    upstream.on('close', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
    clientSocket.on('close', () => upstream.destroy())
  })
  await new Promise<void>((resolve) => httpProxy.listen(0, '127.0.0.1', () => resolve()))
  const proxyPort = (httpProxy.address() as AddressInfo).port

  const logs: string[] = []
  const guard = new EgressGuard({
    probes: [
      {
        id: 'cloudflare-trace',
        url: `https://probe.example.test:${targetPort}/cdn-cgi/trace`,
        parse: parseCloudflareTrace,
      },
    ],
    tlsOptions: { rejectUnauthorized: false },
    log: (m) => logs.push(m),
  })

  try {
    // 1. Valid Basic Auth over HTTP CONNECT + TLS upgrade
    const okSnap = await guard.check('acct-http', {
      HTTPS_PROXY: `http://proxyUser:superSecretPass999@127.0.0.1:${proxyPort}`,
    })
    assert.equal(okSnap.status, 'supported')
    assert.equal(okSnap.country, 'US')
    assert.equal(okSnap.ipMasked, '203.0.113.*')
    assert.equal(okSnap.proxyMode, 'proxy')
    assert.equal(connectCalls.length, 1)
    assert.equal(connectCalls[0]?.authority, `probe.example.test:${targetPort}`)

    // 2. Wrong proxy credentials -> status=error with HTTP 407 and ZERO credential leakage
    const badSnap = await guard.check('acct-bad-auth', {
      HTTPS_PROXY: `http://proxyUser:wrongSecretPass888@127.0.0.1:${proxyPort}`,
    })
    assert.equal(badSnap.status, 'error')
    assert.match(badSnap.reason ?? '', /407/)
    const serialized = JSON.stringify({ okSnap, badSnap, logs })
    assert.equal(serialized.includes('superSecretPass999'), false)
    assert.equal(serialized.includes('wrongSecretPass888'), false)
    assert.equal(serialized.includes('proxyUser'), false)

    // 3. NO_PROXY matching domain suffix bypasses dead proxy and connects directly
    const directGuard = new EgressGuard({
      probes: [
        {
          id: 'cloudflare-trace',
          url: `https://127.0.0.1:${targetPort}/cdn-cgi/trace`,
          parse: parseCloudflareTrace,
        },
      ],
      tlsOptions: { rejectUnauthorized: false },
    })
    traceLoc = 'HK'
    const bypassSnap = await directGuard.check('acct-bypass', {
      HTTPS_PROXY: `http://proxyUser:wrongSecret@127.0.0.1:${proxyPort}`,
      NO_PROXY: 'localhost,127.0.0.1',
    })
    assert.equal(bypassSnap.proxyMode, 'direct')
    assert.equal(bypassSnap.status, 'unsupported')
    assert.equal(bypassSnap.country, 'HK')
    directGuard.dispose()
  } finally {
    guard.dispose()
    await trackedProxy.close()
    await trackedTarget.close()
  }
})

test('SOCKS5 / SOCKS5H tunnel supports no-auth & RFC 1929 auth and enforces ATYP=0x03 remote domain resolution', async () => {
  const trackedTarget = trackServer(
    https.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ip=2001:0db8:abcd:0001::42\nloc=JP\n')
    }),
  )
  const targetServer = trackedTarget.server
  await new Promise<void>((resolve) => targetServer.listen(0, '127.0.0.1', () => resolve()))
  const targetPort = (targetServer.address() as AddressInfo).port

  let requireAuth = false
  const observedRequests: Array<{ atyp: number; domain: string; port: number; authed: boolean }> = []

  const trackedSocks = trackServer(
    net.createServer((client) => {
      let stage: 'greeting' | 'auth' | 'connect' | 'piping' = 'greeting'
      let buf = Buffer.alloc(0)
      let authed = false

      client.on('error', () => {})
      client.on('data', (chunk: Buffer) => {
        if (stage === 'piping') return
        buf = Buffer.concat([buf, chunk])

        while (true) {
          if (stage === 'greeting') {
            if (buf.length < 2) return
            const nMethods = buf[1]!
            if (buf.length < 2 + nMethods) return
            const methods = buf.subarray(2, 2 + nMethods)
            buf = buf.subarray(2 + nMethods)
            if (requireAuth) {
              if (!methods.includes(0x02)) {
                client.end(Buffer.from([0x05, 0xff]))
                return
              }
              stage = 'auth'
              client.write(Buffer.from([0x05, 0x02]))
            } else {
              stage = 'connect'
              client.write(Buffer.from([0x05, 0x00]))
            }
            continue
          }

          if (stage === 'auth') {
            if (buf.length < 2) return
            const uLen = buf[1]!
            if (buf.length < 2 + uLen + 1) return
            const pLen = buf[2 + uLen]!
            if (buf.length < 3 + uLen + pLen) return
            const user = buf.subarray(2, 2 + uLen).toString('utf8')
            const pass = buf.subarray(3 + uLen, 3 + uLen + pLen).toString('utf8')
            buf = buf.subarray(3 + uLen + pLen)
            if (user === 'socksUser' && pass === 'socksSecret777') {
              authed = true
              stage = 'connect'
              client.write(Buffer.from([0x01, 0x00]))
              continue
            }
            client.end(Buffer.from([0x01, 0x01]))
            return
          }

          if (stage === 'connect') {
            if (buf.length < 5) return
            const atyp = buf[3]!
            if (atyp !== 0x03) {
              client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
              return
            }
            const dLen = buf[4]!
            if (buf.length < 5 + dLen + 2) return
            const domain = buf.subarray(5, 5 + dLen).toString('utf8')
            const port = buf.readUInt16BE(5 + dLen)
            const leftover = buf.subarray(7 + dLen)
            buf = Buffer.alloc(0)
            stage = 'piping'
            observedRequests.push({ atyp, domain, port, authed })

            const upstream = net.connect({ host: '127.0.0.1', port: targetPort }, () => {
              client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]))
              if (leftover.length > 0) upstream.write(leftover)
              client.pipe(upstream)
              upstream.pipe(client)
            })
            upstream.on('error', () => client.destroy())
            upstream.on('close', () => client.destroy())
            client.on('close', () => upstream.destroy())
            return
          }
          break
        }
      })
    }),
  )
  const socksServer = trackedSocks.server
  await new Promise<void>((resolve) => socksServer.listen(0, '127.0.0.1', () => resolve()))
  const socksPort = (socksServer.address() as AddressInfo).port

  const guard = new EgressGuard({
    probes: [
      {
        id: 'cloudflare-trace',
        url: `https://remote-dns.example.test:${targetPort}/cdn-cgi/trace`,
        parse: parseCloudflareTrace,
      },
    ],
    tlsOptions: { rejectUnauthorized: false },
  })

  try {
    // 1. Unauthenticated SOCKS5
    const noAuthSnap = await guard.check('s-noauth', {
      ALL_PROXY: `socks5://127.0.0.1:${socksPort}`,
    })
    assert.equal(noAuthSnap.status, 'supported')
    assert.equal(noAuthSnap.country, 'JP')
    assert.equal(noAuthSnap.ipMasked, '2001:db8::*')
    assert.equal(noAuthSnap.proxyMode, 'proxy')
    assert.deepEqual(observedRequests[0], {
      atyp: 0x03,
      domain: 'remote-dns.example.test',
      port: targetPort,
      authed: false,
    })

    // 2. Authenticated SOCKS5H (RFC 1929)
    requireAuth = true
    const authSnap = await guard.check('s-auth', {
      HTTPS_PROXY: `socks5h://socksUser:socksSecret777@127.0.0.1:${socksPort}`,
    })
    assert.equal(authSnap.status, 'supported')
    assert.equal(authSnap.country, 'JP')
    assert.deepEqual(observedRequests[1], {
      atyp: 0x03,
      domain: 'remote-dns.example.test',
      port: targetPort,
      authed: true,
    })

    // 3. Wrong SOCKS5 password returns sanitized error without leaking secret
    const badAuth = await guard.check('s-bad', {
      HTTPS_PROXY: `socks5://socksUser:wrongSocksPass@127.0.0.1:${socksPort}`,
    })
    assert.equal(badAuth.status, 'error')
    assert.match(badAuth.reason ?? '', /认证失败/)
    assert.equal(JSON.stringify(badAuth).includes('wrongSocksPass'), false)
  } finally {
    guard.dispose()
    await trackedSocks.close()
    await trackedTarget.close()
  }
})

test('EgressGuard falls back to backup probe, deduplicates singleflight, enforces split TTLs, and evaluates all 4 GeoFenceModes + runtime-400', async () => {
  assert.equal(shouldBypassProxy(new URL('https://sub.cloudflare.com/cdn-cgi/trace'), '.cloudflare.com'), true)
  assert.equal(resolveProxyForUrl(new URL('https://cloudflare.com'), { HTTPS_PROXY: 'socks4://127.0.0.1:1080' }).kind, 'invalid')

  let primaryMode: 'ok-us' | 'ok-hk' | 'placeholder-xx' | 'http-503' = 'http-503'
  let backupMode: 'ok-sg' | 'http-500' = 'ok-sg'
  let primaryHits = 0
  let backupHits = 0

  const trackedProbe = trackServer(
    https.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (req, res) => {
      if (req.url === '/trace') {
        primaryHits++
        if (primaryMode === 'http-503') {
          res.writeHead(503)
          res.end('down')
          return
        }
        const loc = primaryMode === 'ok-us' ? 'US' : primaryMode === 'ok-hk' ? 'HK' : 'XX'
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(`ip=198.51.100.7\nloc=${loc}\n`)
        return
      }
      if (req.url === '/geoip') {
        backupHits++
        if (backupMode === 'http-500') {
          res.writeHead(500)
          res.end('err')
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ country_code: 'SG', ip: '198.51.100.88' }))
        return
      }
      res.writeHead(404)
      res.end()
    }),
  )
  const probeServer = trackedProbe.server
  await new Promise<void>((resolve) => probeServer.listen(0, '127.0.0.1', () => resolve()))
  const port = (probeServer.address() as AddressInfo).port

  let fakeNow = 1_000_000
  const warnings: string[] = []
  const guard = new EgressGuard({
    now: () => fakeNow,
    reprobeMinIntervalMs: 5_000,
    probes: [
      { id: 'cloudflare-trace', url: `https://127.0.0.1:${port}/trace`, parse: parseCloudflareTrace },
      { id: 'ipsb', url: `https://127.0.0.1:${port}/geoip`, parse: parseIpSbGeoIp },
    ],
    tlsOptions: { rejectUnauthorized: false },
    log: (m) => warnings.push(m),
  })

  try {
    // 1. Primary 503 falls back to backup `ipsb` + 8 concurrent calls share 1 singleflight probe
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => guard.check('acct-1', {})))
    assert.equal(primaryHits, 1)
    assert.equal(backupHits, 1)
    for (const snap of concurrent) {
      assert.equal(snap.status, 'supported')
      assert.equal(snap.country, 'SG')
      assert.equal(snap.probeSource, 'ipsb')
    }

    // Within 5-minute supported TTL (299s later) -> 0 new probes
    fakeNow += 299_000
    await guard.assertAllowed({ accountId: 'acct-1', env: {}, mode: 'block' })
    assert.equal(primaryHits, 1)

    // After 300s supported TTL expires -> re-probes; switch primary to HK
    fakeNow += 2_000
    primaryMode = 'ok-hk'
    await assert.rejects(
      guard.assertAllowed({ accountId: 'acct-1', accountLabel: '主力账号', env: {}, mode: 'block' }),
      (err: unknown) =>
        err instanceof EgressBlockedError &&
        err.status === 451 &&
        err.message.includes('主力账号') &&
        err.message.includes('HK'),
    )

    // `warn` mode allows HK with warning; `off` mode skips probing altogether
    const hitsBeforeWarn = primaryHits
    await guard.assertAllowed({ accountId: 'acct-1', env: {}, mode: 'warn' }) // hits 60s unsupported cache
    assert.equal(primaryHits, hitsBeforeWarn)
    assert.ok(warnings.some(w => w.includes('geoFenceMode=warn')))

    const hitsBeforeOff = primaryHits
    await guard.assertAllowed({ accountId: 'never-probed', env: {}, mode: 'off' })
    assert.equal(primaryHits, hitsBeforeOff)

    // Unknown (`XX` + backup 500): `block` allows with warning, `strict` blocks!
    primaryMode = 'placeholder-xx'
    backupMode = 'http-500'
    const unkAllow = await guard.assertAllowed({ accountId: 'acct-unk', env: {}, mode: 'block' })
    assert.equal(unkAllow?.status, 'unknown')
    await assert.rejects(
      guard.assertAllowed({ accountId: 'acct-unk', env: {}, mode: 'strict' }),
      EgressBlockedError,
    )

    // `recordGeoRejection` invalidates supported cache immediately and keeps 60s block armed
    primaryMode = 'ok-us'
    const usSnap = await guard.check('acct-drift', {}, { force: true })
    assert.equal(usSnap.status, 'supported')
    const rejected = guard.recordGeoRejection('acct-drift', {})
    assert.equal(rejected.status, 'unsupported')
    assert.equal(rejected.probeSource, 'runtime-400')
    await assert.rejects(
      guard.assertAllowed({ accountId: 'acct-drift', env: {}, mode: 'block' }),
      EgressBlockedError,
    )
    // Wait for background reprobe (which sees US -> split-tunnel hint, STILL blocked until manual force check!)
    await new Promise((r) => setTimeout(r, 80))
    await assert.rejects(
      guard.assertAllowed({ accountId: 'acct-drift', env: {}, mode: 'block' }),
      EgressBlockedError,
    )
    assert.match(guard.getSnapshot('acct-drift', {})?.reason ?? '', /googleapis\.com/)
  } finally {
    guard.dispose()
    await trackedProbe.close()
  }
})

test('DEFAULT_EGRESS_PROBES uses pure anonymous Google endpoints and evaluates AI Studio + CloudCode over HTTP CONNECT', async () => {
  // 1. Default probe configuration never calls third-party IP services and carries zero credentials
  assert.ok(DEFAULT_EGRESS_PROBES.length >= 2)
  const serializedDefaults = JSON.stringify(DEFAULT_EGRESS_PROBES)
  assert.equal(serializedDefaults.includes('cloudflare.com'), false)
  assert.equal(serializedDefaults.includes('ip.sb'), false)
  assert.equal(/authorization|cookie/i.test(serializedDefaults), false)
  assert.equal(DEFAULT_EGRESS_PROBES[0]?.id, 'google-aistudio')
  assert.equal(DEFAULT_EGRESS_PROBES[0]?.url, 'https://aistudio.google.com/')
  assert.equal(DEFAULT_EGRESS_PROBES[0]?.method, 'HEAD')
  assert.equal(DEFAULT_EGRESS_PROBES[0]?.confirm?.url, 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist')

  // 2. Live loopback TLS + HTTP CONNECT proxy testing all anonymous Google probe outcomes
  let aiMode: 'welcome' | 'restricted' | 'down' = 'welcome'
  let cloudMode: 'unauth' | 'geo-400' | 'down' = 'unauth'
  const observed: Array<{ method: string; path: string; hasAuth: boolean; hasCookie: boolean }> = []

  const trackedTarget = trackServer(
    https.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (req, res) => {
      observed.push({
        method: req.method ?? '',
        path: req.url ?? '',
        hasAuth: 'authorization' in req.headers,
        hasCookie: 'cookie' in req.headers,
      })
      if (req.url === '/') {
        if (aiMode === 'welcome') {
          res.writeHead(302, { Location: 'https://aistudio.google.com/welcome', 'Content-Length': '0' })
          res.end()
          return
        }
        if (aiMode === 'restricted') {
          res.writeHead(302, { Location: 'https://aistudio.google.com/available-regions', 'Content-Length': '0' })
          res.end()
          return
        }
        res.writeHead(503)
        res.end()
        return
      }
      if (req.url === '/v1internal:loadCodeAssist') {
        if (cloudMode === 'unauth') {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED' } }))
          return
        }
        if (cloudMode === 'geo-400') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 400, status: 'FAILED_PRECONDITION', message: 'User location is not supported for the API use.' } }))
          return
        }
        res.writeHead(503)
        res.end('unavailable')
        return
      }
      res.writeHead(404)
      res.end()
    }),
  )
  await new Promise<void>((resolve) => trackedTarget.server.listen(0, '127.0.0.1', () => resolve()))
  const targetPort = (trackedTarget.server.address() as AddressInfo).port

  const trackedProxy = trackServer(http.createServer((_req, res) => { res.writeHead(405); res.end() }))
  trackedProxy.server.on('connect', (_req, clientSocket, head) => {
    const upstream = net.connect({ host: '127.0.0.1', port: targetPort }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  await new Promise<void>((resolve) => trackedProxy.server.listen(0, '127.0.0.1', () => resolve()))
  const proxyPort = (trackedProxy.server.address() as AddressInfo).port

  const guard = new EgressGuard({
    probes: [
      {
        id: 'google-aistudio',
        url: `https://aistudio.google.com:${targetPort}/`,
        method: 'HEAD',
        evaluate: evaluateGoogleAiStudioProbe,
        confirm: {
          id: 'google-cloudcode',
          url: `https://daily-cloudcode-pa.googleapis.com:${targetPort}/v1internal:loadCodeAssist`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          evaluate: (res) => evaluateGoogleCloudCodeProbe(res, 'confirm'),
        },
      },
      {
        id: 'google-cloudcode',
        url: `https://daily-cloudcode-pa.googleapis.com:${targetPort}/v1internal:loadCodeAssist`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        evaluate: (res) => evaluateGoogleCloudCodeProbe(res, 'standalone'),
      },
    ],
    tlsOptions: { rejectUnauthorized: false },
  })
  const env = { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` }

  try {
    // Supported: AI Studio 302 /welcome + CloudCode 401 -> supported, zero auth/cookies sent
    const okSnap = await guard.check('g-ok', env, { force: true })
    assert.equal(okSnap.status, 'supported')
    assert.equal(okSnap.country, null)
    assert.equal(okSnap.proxyMode, 'proxy')
    assert.equal(okSnap.probeSource, 'google-aistudio')
    assert.deepEqual(
      observed.map((o) => `${o.method} ${o.path}`),
      ['HEAD /', 'POST /v1internal:loadCodeAssist'],
    )
    assert.ok(observed.every((o) => !o.hasAuth && !o.hasCookie))

    // Restricted: AI Studio 302 /available-regions -> immediately unsupported (skips confirm)
    observed.length = 0
    aiMode = 'restricted'
    const restrictedSnap = await guard.check('g-hk', env, { force: true })
    assert.equal(restrictedSnap.status, 'unsupported')
    assert.equal(restrictedSnap.probeSource, 'google-aistudio')
    assert.equal(observed.length, 1)
    await assert.rejects(
      guard.assertAllowed({ accountId: 'g-hk', env, mode: 'block' }),
      (err: unknown) => err instanceof EgressBlockedError && err.message.includes('Google AI Studio 受限区'),
    )

    // Split route: AI Studio welcome, but CloudCode returns 400 geo -> unsupported
    aiMode = 'welcome'
    cloudMode = 'geo-400'
    const splitSnap = await guard.check('g-split', env, { force: true })
    assert.equal(splitSnap.status, 'unsupported')
    assert.equal(splitSnap.probeSource, 'google-cloudcode')

    // AI Studio down (503) + CloudCode reachable (401) -> unknown (block allows, strict blocks)
    aiMode = 'down'
    cloudMode = 'unauth'
    const unkSnap = await guard.assertAllowed({ accountId: 'g-unk', env, mode: 'block' })
    assert.equal(unkSnap?.status, 'unknown')
    assert.equal(unkSnap?.probeSource, 'google-cloudcode')
    await assert.rejects(guard.assertAllowed({ accountId: 'g-unk', env, mode: 'strict' }), EgressBlockedError)

    // AI Studio welcome, but CloudCode unreachable (503) -> error (never false green)
    aiMode = 'welcome'
    cloudMode = 'down'
    const errSnap = await guard.check('g-err', env, { force: true })
    assert.equal(errSnap.status, 'error')
  } finally {
    guard.dispose()
    await trackedProxy.close()
    await trackedTarget.close()
  }
})
