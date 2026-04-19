/**
 * Dev-mode preload script.
 *
 * Registers a Bun plugin that intercepts `import { feature } from 'bun:bundle'`
 * and provides a runtime shim. Also ensures the MACRO global is available
 * before any application code runs.
 *
 * Loaded via bunfig.toml → preload.
 */

import { plugin } from 'bun'
import pkg from '../package.json'

// ── 1. MACRO global ─────────────────────────────────────────────────────────
// In production builds Bun inlines MACRO.* references at compile time.
// For dev we expose the same shape on globalThis so bare `MACRO` references
// resolve at runtime.
type MacroConfig = {
  VERSION: string
  BUILD_TIME: string
  PACKAGE_URL: string
  NATIVE_PACKAGE_URL: string
  VERSION_CHANGELOG: string
  ISSUES_EXPLAINER: string
  FEEDBACK_CHANNEL: string
}

const devMacro: MacroConfig = {
  VERSION: pkg.version,
  BUILD_TIME: '',
  PACKAGE_URL: pkg.name,
  NATIVE_PACKAGE_URL: pkg.name,
  VERSION_CHANGELOG: '',
  ISSUES_EXPLAINER:
    'file an issue at https://github.com/anthropics/claude-code/issues',
  FEEDBACK_CHANNEL: 'github',
}

if (!('MACRO' in globalThis)) {
  ;(globalThis as typeof globalThis & { MACRO: MacroConfig }).MACRO = devMacro
}

// ── 2. bun:bundle shim ─────────────────────────────────────────────────────
// `feature(flag)` is a build-time DCE gate. In dev mode we return `false`
// for every flag so that code guarded by `if (feature('X'))` is simply
// skipped at runtime. This is the safest default: it disables internal /
// ant-only features but keeps the main CLI path functional.
plugin({
  name: 'dev-bun-bundle-shim',
  setup(build) {
    build.onResolve({ filter: /^bun:bundle$/ }, (args) => {
      return {
        path: 'bun:bundle',
        namespace: 'bun-bundle-shim',
      }
    })

    build.onLoad(
      { filter: /.*/, namespace: 'bun-bundle-shim' },
      () => {
        return {
          contents: `
            export function feature(flag) {
              return false;
            }
          `,
          loader: 'js',
        }
      },
    )
  },
})
