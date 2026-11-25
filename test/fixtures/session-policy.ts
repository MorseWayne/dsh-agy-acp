import { EgressGuard } from '../../src/runtime/egress-guard.ts'
import type { SessionPolicy } from '../../src/runtime/permission-manager.ts'

/**
 * Stateless offline egress guard fixture so unit/E2E tests never make external internet requests.
 * Tests that verify egress blocking or proxy protocols inject their own `new EgressGuard(...)`.
 */
export function createOfflineEgressGuard(): EgressGuard {
  return new EgressGuard({
    probeFn: async (_accountId, env) => ({
      status: 'supported',
      country: 'US',
      ipMasked: '198.51.100.*',
      proxyMode: env?.HTTPS_PROXY || env?.ALL_PROXY || env?.HTTP_PROXY ? 'proxy' : 'direct',
      probeSource: 'offline-fixture',
    }),
  })
}

// Only used with the mock ACP subprocess, never for a real provider launch.
export const fakeHost = {
  readPolicy: (sessionId: string): SessionPolicy => ({
    sessionId,
    workspaceRoot: process.cwd(),
    mode: 'danger-full-access',
    preset: 'danger-full-access',
    approval: 'never',
  }),
  prepareArgv: async (argv: string[]) => argv,
  get egressGuard(): EgressGuard {
    return createOfflineEgressGuard()
  },
}
