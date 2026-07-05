// Sandboxed renderer for 'html'/'jsx' slides: turns an author's pasted source
// into a complete HTML document for an iframe's `srcDoc`, so it never touches
// the host DOM (no dangerouslySetInnerHTML). Raw HTML passes through mostly
// as-is; JSX is transpiled in-browser via Babel standalone and mounted with
// React 18. Trimmed port of humatopia-frontend's src/lib/micro-app.ts (no CDN
// library map) — kept close enough to ease a future merge of the two apps.

const BUILTIN_LIBS = new Set(['react', 'react-dom', 'react-dom/client'])

export interface ProcessResult {
  code: string
  componentName: string
  warnings: string[]
}

// Strips import/export statements (keeping only react/react-dom, which are
// provided as UMD globals) and detects the component to mount. The mounted
// name is taken from whichever line is `export default` — not guessed
// afterward by scanning for the first capitalized declaration, which would
// pick an earlier helper component over the actual entry point.
export function processImports(code: string): ProcessResult {
  const lines = code.split('\n')
  const processed: string[] = []
  const warnings: string[] = []
  let defaultExportName: string | null = null

  for (const line of lines) {
    const fromMatch = line.match(
      /^\s*import\s+(?:.*?)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/
    )
    const sideEffectMatch = line.match(/^\s*import\s+['"]([^'"]+)['"]\s*;?\s*$/)

    if (fromMatch != null) {
      const lib = fromMatch[1]
      if (!BUILTIN_LIBS.has(lib)) {
        warnings.push(`Import stripped: ${lib} (not available in sandbox)`)
      }
      continue
    }
    if (sideEffectMatch != null) {
      warnings.push(`Import stripped: ${sideEffectMatch[1]}`)
      continue
    }

    let processedLine = line
    const namedDefaultFn = processedLine.match(
      /^\s*export\s+default\s+function\s+([A-Za-z_$][\w$]*)/
    )
    if (namedDefaultFn != null) {
      defaultExportName = namedDefaultFn[1]
      processedLine = processedLine.replace(
        /^\s*export\s+default\s+function\s+/,
        'function '
      )
    } else if (/^\s*export\s+default\s+/.test(processedLine)) {
      defaultExportName = '_DefaultExport'
      processedLine = processedLine.replace(
        /^\s*export\s+default\s+/,
        'const _DefaultExport = '
      )
    }
    processedLine = processedLine.replace(
      /^\s*export\s+(?=function\s|const\s|let\s|var\s|class\s)/,
      ''
    )
    processed.push(processedLine)
  }

  const processedCode = processed.join('\n')
  return {
    code: processedCode,
    componentName: defaultExportName ?? detectComponentName(processedCode),
    warnings
  }
}

// Fallback for code with no `export default` at all — best-effort guess at
// the first declared component.
function detectComponentName(code: string): string {
  const fnMatch = code.match(/\bfunction\s+([A-Z][A-Za-z0-9_]*)\s*\(/)
  if (fnMatch != null) return fnMatch[1]
  const constMatch = code.match(
    /\bconst\s+([A-Z][A-Za-z0-9_]*)\s*=\s*(?:\(|React\.|memo|forwardRef)/
  )
  if (constMatch != null) return constMatch[1]
  const fallback = code.match(/\bconst\s+([A-Z][A-Za-z0-9_]*)\s*=/)
  if (fallback != null) return fallback[1]
  if (code.includes('_DefaultExport')) return '_DefaultExport'
  return 'App'
}

function normalizeRawHtml(code: string): string {
  const trimmed = code.trim()
  if (trimmed.length === 0) return trimmed
  if (/^\s*<!doctype html/i.test(trimmed) || /^\s*<html\b/i.test(trimmed)) {
    return trimmed
  }
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { width: 100%; min-height: 100%; margin: 0; }
  </style>
</head>
<body>
${trimmed}
</body>
</html>`
}

// Shared by both srcDoc shapes below (raw HTML and the JSX/Babel shell).
const NAV_KEY_BRIDGE_SCRIPT = `<script>
var NAV_KEYS = ['ArrowLeft','ArrowRight','Escape'];
window.addEventListener('keydown', function(e) {
  if (NAV_KEYS.indexOf(e.key) !== -1) {
    parent.postMessage({ type: 'slide-nav-key', key: e.key }, '*');
  }
});
</script>`

// Bridges keys the parent modal needs (Escape/arrows) out of the iframe via
// postMessage, since keydown on iframe content never bubbles to the host
// window. SlideshowModal listens for the 'slide-nav-key' message.
function injectKeyBridge(html: string): string {
  const idx = html.toLowerCase().lastIndexOf('</body>')
  return idx !== -1
    ? html.slice(0, idx) + NAV_KEY_BRIDGE_SCRIPT + html.slice(idx)
    : html + NAV_KEY_BRIDGE_SCRIPT
}

// Generates a complete document for an iframe `srcDoc`, keyed off the
// slide's own declared type rather than sniffed from the code — sniffing
// (e.g. by leading tag) misroutes any valid HTML fragment that doesn't start
// with a whitelisted tag.
export function generateSrcdoc(code: string, type: 'html' | 'jsx'): string {
  if (type === 'html') {
    return injectKeyBridge(normalizeRawHtml(code))
  }

  const processed = processImports(code)

  return `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@babel/standalone/babel.min.js"></script>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    html, body, #root { width: 100%; height: 100%; overflow: hidden; }
  </style>
</head>
<body>
  <div id="root"></div>
  ${NAV_KEY_BRIDGE_SCRIPT}
  <script>
    window.onerror = function(msg, _src, _line, _col, err) {
      var root = document.getElementById('root');
      if (root && root.childElementCount === 0) {
        var text = (err && err.message ? err.message : String(msg))
          .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        root.innerHTML = '<div style="color:#f87171;padding:1rem;font-family:monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word"><strong>Error</strong><br>' + text + '</div>';
      }
      return true;
    };
  </script>
  <script type="text/babel" data-type="module">
    const { useState, useRef, useEffect, useMemo, useCallback, useReducer,
            useContext, createContext, Fragment, forwardRef, memo, Suspense } = React;

    ${processed.code}

    ReactDOM.createRoot(document.getElementById('root'))
      .render(React.createElement(${processed.componentName}));
  </script>
</body></html>`
}
