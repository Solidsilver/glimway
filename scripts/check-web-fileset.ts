/** Check local build imports against nix/web.nix's narrow source whitelist. */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export function checkWebFileset(root: string, nix = readFileSync(resolve(root, 'nix/web.nix'), 'utf8')): string[] {
  const union = nix.match(/fileset\s*=\s*lib\.fileset\.unions\s*\[([\s\S]*?)\]/)?.[1]
  if (!union) throw new Error('Expected an explicit Nix web fileset union')
  const entries = [...union.replace(/#[^\n]*/g, '').matchAll(/\.\.\/([\w./-]+)/g)].map((m) => m[1]!)
  const included = (path: string) => entries.some((e) => path === e || path.startsWith(`${e}/`))
  const files: string[] = []
  const walk = (path: string) => {
    if (statSync(resolve(root, path)).isDirectory()) {
      for (const name of readdirSync(resolve(root, path))) walk(`${path}/${name}`)
    } else if (/\.(?:ts|js|mjs|svelte|css)$/.test(path)) files.push(path)
  }
  for (const entry of entries) walk(entry)
  const failures: string[] = []
  const globInside = (file: string, pattern: string) => {
    if (!pattern.startsWith('.') && !pattern.startsWith('/')) return false
    const fixed = pattern.split('/').filter((_, i, parts) => !parts.slice(0, i + 1).some((part) => /[*?[\]{}()!]/.test(part))).join('/')
    const dir = relative(root, pattern.startsWith('/') ? resolve(root, `.${fixed}`) : resolve(root, dirname(file), fixed))
    return !dir.startsWith('..') && included(dir)
  }
  for (const file of files) {
    const source = readFileSync(resolve(root, file), 'utf8')
    const imports: string[] = []
    const svelte = file.endsWith('.svelte')
    const text = svelte ? [...source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n') : source
    const styles = svelte ? [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n') : file.endsWith('.css') ? source : ''
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text)
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text)
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.[0] && ts.isStringLiteral(node.arguments[0])) {
        const spec = node.arguments[0].text
        // The Vite E2E router is only loaded when GLIMWAY_E2E_ROUTING=1;
        // it is excluded from the production Nix build deliberately.
        if (!(file === 'vite.config.ts' && spec.startsWith('./e2e/'))) imports.push(spec)
      }
      // import.meta.glob: every pattern must be literal, and its static
      // directory must lie inside the fileset, or the build may miss files.
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'import.meta.glob') {
        const arg = node.arguments[0]
        const patterns = arg && ts.isStringLiteralLike(arg) ? [arg] : arg && ts.isArrayLiteralExpression(arg) ? [...arg.elements] : []
        if (!patterns.length || patterns.some((p) => !ts.isStringLiteralLike(p))) failures.push(`${file}: import.meta.glob needs literal patterns`)
        for (const p of patterns) if (ts.isStringLiteralLike(p) && !p.text.startsWith('!') && !globInside(file, p.text)) failures.push(`${file}: import.meta.glob('${p.text}') reaches outside the filtered source`)
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    for (const m of styles.matchAll(/@import\s*(?:url\(\s*)?['"]?([^'")\s;]+)/g)) imports.push(m[1]!)
    for (const m of styles.matchAll(/url\(\s*['"]?([^'")\s]+)/g)) imports.push(m[1]!)
    for (const spec of imports) {
      const specifier = spec.split('?')[0]!
      if (!specifier.startsWith('.')) continue
      const base = resolve(root, dirname(file), specifier)
      const candidates = [base, ...['.ts', '.js', '.svelte', '.json', '/index.ts', '/index.js'].map((s) => base + s)]
      const target = candidates.find((p) => existsSync(p) && statSync(p).isFile())
      if (!target || !included(relative(root, target))) failures.push(`${file}: ${specifier} is absent from the filtered source`)
    }
  }
  return failures
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkWebFileset(process.cwd())
  if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
  else console.log('Nix web fileset: local build imports resolve')
}
