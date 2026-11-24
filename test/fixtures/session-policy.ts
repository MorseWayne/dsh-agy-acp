import type { SessionPolicy } from '../../src/runtime/permission-manager.ts'

// Only used with the mock ACP subprocess, never for a real provider launch.
export const fakeHost = {
  readPolicy: (sessionId: string): SessionPolicy => ({ sessionId, workspaceRoot: process.cwd(), mode: 'danger-full-access', preset: 'danger-full-access', approval: 'never' }),
  prepareArgv: async (argv: string[]) => argv,
}
