import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';

const source = path.resolve(process.argv[2] || '.tmp/piik-upstream/Piik-main');
const target = path.resolve('src/vendor/piik');
const roots = ['src/client/styles.css', ...['Stage', 'Couch', 'BrandMark', 'primitives', 'SharingSettings', 'LanguageControl', 'QualityTileGlyph'].map(name => `src/client/components/living/${name}.tsx`), 'src/client/ui/theme.ts'];
const files = new Map(), external = new Set();
function visit(relative) {
  if (files.has(relative)) return;
  const content = fs.readFileSync(path.join(source, relative), 'utf8');
  files.set(relative, crypto.createHash('sha256').update(content).digest('hex'));
  const imports = relative.endsWith('.css')
    ? [...content.matchAll(/@import\s+["']([^"']+)["']/g)].map(match => match[1])
    : ts.preProcessFile(content, true, true).importedFiles.map(item => item.fileName);
  for (const name of imports) {
    if (!name.startsWith('.')) { external.add(name); continue; }
    const base = path.resolve(path.dirname(path.join(source, relative)), name);
    const found = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, `${base}.tsx`, `${base}.css`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')].find(file => fs.existsSync(file) && fs.statSync(file).isFile());
    if (!found || !found.startsWith(source + path.sep)) throw new Error(`Cannot resolve ${relative}: ${name}`);
    visit(path.relative(source, found).replaceAll('\\', '/'));
  }
}
for (const root of roots) visit(root);
for (const relative of files.keys()) {
  const destination = path.join(target, relative);
  fs.mkdirSync(path.dirname(destination), { recursive:true });
  fs.copyFileSync(path.join(source, relative), destination);
}
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(target, 'LICENSE'));
fs.writeFileSync(path.join(target, 'upstream.json'), JSON.stringify({ repository:'https://github.com/TNTcraftHIM/Piik', revision:process.argv[3], roots, files:Object.fromEntries(files) }, null, 2) + '\n');
console.log(JSON.stringify({ files:files.size, external:[...external] }));
