import { defineConfig } from 'tsdown'

const hostExternals = [/^@deepseek-ai\//, /^node:/]

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'dist',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: true,
    clean: true,
    fixedExtension: false,
    deps: { neverBundle: hostExternals },
    copy: [{ from: 'src/mcp/bridge.mjs', to: 'dist' }],
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'dist',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    fixedExtension: false,
    deps: { neverBundle: [/^@deepseek-ai\//, 'react', 'react-dom', 'react/jsx-runtime'] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: "@morsewayne/dsh-agy-acp", factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
