import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: {
      // Markdown's raw-HTML highlighting drags in the HTML, CSS and JavaScript
      // parsers; replace it with a no-op (see src/stubs/lang-html.ts).
      '@codemirror/lang-html': fileURLToPath(new URL('./src/stubs/lang-html.ts', import.meta.url)),
    },
  },
  build: {
    target: 'es2021', // Safari 15 (macOS 12 WebKit) and WebView2
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
  // Lazily imported packages: pre-bundle them when the dev server starts, so the
  // first JS/shell tab or JS format doesn't make Vite re-optimise and reload the page.
  optimizeDeps: {
    include: [
      '@codemirror/lang-javascript',
      '@codemirror/legacy-modes/mode/shell',
      'js-beautify/js/src/javascript/index.js',
    ],
  },
  server: { port: 5173, strictPort: true },
});
