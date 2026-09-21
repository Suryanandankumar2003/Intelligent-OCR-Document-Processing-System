import { cpSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const require = createRequire(import.meta.url)

/** Where the app serves PDF.js's side files from, in dev and in a build alike. */
const PDFJS_ASSET_BASE = '/pdfjs'

/**
 * The directories PDF.js fetches at runtime rather than bundling.
 *
 * These are not optional extras for this application:
 *
 *   * `wasm` holds the JBIG2 and JPEG 2000 decoders. Both are standard
 *     compression formats *for scanned documents* — which is the only
 *     kind of document this system processes — and a PDF using either
 *     renders as a blank page without them. This is the entry that
 *     makes the list worth having at all.
 *   * `standard_fonts` holds the Base-14 fonts (Helvetica, Times,
 *     Courier). A browser can substitute local system fonts for these,
 *     and usually does, but the substitution is the browser's guess at
 *     metrics — shipping the real ones means a PDF's text sits where
 *     the PDF said it does, which matters here because the highlight
 *     layer is positioned from those metrics.
 *   * `cmaps` maps CJK character encodings. Unlikely in this
 *     deployment's documents and cheap to include; a missing CMap turns
 *     a page of text into a page of blanks, which is not a failure mode
 *     worth risking to save a directory nothing downloads unless it is
 *     needed.
 *   * `iccs` holds the colour profile used for CMYK conversion.
 *
 * Every one of them is fetched lazily by PDF.js, only for a document
 * that needs it — so the cost is build output size, not page load.
 */
const PDFJS_ASSET_DIRS = ['standard_fonts', 'cmaps', 'wasm', 'iccs']

/**
 * Makes PDF.js's runtime asset directories available at
 * `/pdfjs/<dir>/`, from the installed package.
 *
 * A local plugin rather than a dependency (`vite-plugin-static-copy`) or
 * a committed copy under `public/`: the files have to match the
 * installed `pdfjs-dist` version exactly — a decoder from one version
 * against a library from another fails in ways that look like a corrupt
 * PDF — and resolving them from `node_modules` at build time is the only
 * arrangement where that is true by construction rather than by someone
 * remembering to re-copy them after an upgrade.
 *
 * In dev it is served straight out of `node_modules` by middleware, so
 * there is nothing to copy and nothing to go stale.
 */
function pdfjsAssets() {
  const packageRoot = path.dirname(require.resolve('pdfjs-dist/package.json'))

  return {
    name: 'pdfjs-runtime-assets',

    configureServer(server) {
      server.middlewares.use(PDFJS_ASSET_BASE, (req, res, next) => {
        // `req.url` is already stripped of the mount path by Connect.
        // Decoded because a CMap name can contain characters the browser
        // percent-encodes, and `..` segments are rejected outright so
        // this cannot be walked out of the package directory.
        const relative = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '')
        if (!relative || relative.split('/').includes('..')) return next()

        const [dir] = relative.split('/')
        if (!PDFJS_ASSET_DIRS.includes(dir)) return next()

        const file = path.join(packageRoot, relative)
        if (!existsSync(file)) return next()

        return server.middlewares.handle(
          Object.assign(req, { url: `/@fs/${file.split(path.sep).join('/')}` }),
          res,
          next,
        )
      })
    },

    closeBundle() {
      for (const dir of PDFJS_ASSET_DIRS) {
        const from = path.join(packageRoot, dir)
        if (!existsSync(from)) continue
        cpSync(from, path.join('dist', 'pdfjs', dir), { recursive: true })
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  define: {
    // Read by `components/viewer/pdfjs.js`, so the asset base is
    // declared once here alongside the plugin that serves it rather
    // than being a string two files have to agree on.
    __PDFJS_ASSET_BASE__: JSON.stringify(PDFJS_ASSET_BASE),
  },
})
