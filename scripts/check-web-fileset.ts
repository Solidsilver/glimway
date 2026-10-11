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
  for (const file of files) {
    const source = readFileSync(resolve(root, file), 'utf8')
    const imports: string[] = []
    const text = file.endsWith('.svelte') ? [...source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n') : source
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
      ts.forEachChild(node, visit)
    }
    visit(ast)
    if (file.endsWith('.css')) for (const m of source.matchAll(/@import\s*['"]([^'"]+)['"]/g)) imports.push(m[1]!)
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
