import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const RE = /new THREE\.(Point|Spot|Directional|RectArea)Light\(/g;

function walk(d, out = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

let total = 0;
let hidden = 0;
const files = new Set();
for (const f of walk(path.join(root, 'src/worlds'))) {
  const src = readFileSync(f, 'utf8');
  const lines = src.split('\n');
  let m;
  RE.lastIndex = 0;
  while ((m = RE.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length;
    const after = lines.slice(line - 1, line + 12).join('\n');
    const decl = lines[line - 1].match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=|(this\.[\w$]+)\s*=/);
    const name = decl ? (decl[1] || decl[2]) : null;
    const isHidden = name
      && new RegExp(`${name.replace(/[.$]/g, '\\$&')}\\.visible\\s*=\\s*false`).test(after);
    total++;
    if (isHidden) hidden++;
    else files.add(path.relative(root, f).replace(/\\/g, '/'));
    console.log(`${isHidden ? 'HIDDEN ' : 'VISIBLE'} ${path.relative(root, f).replace(/\\/g, '/')}:${line}  ${name ?? '?'}`);
  }
}
console.log(`\ntotal=${total} hidden=${hidden} offending=${total - hidden} files=${files.size}`);
console.log([...files].sort().join('\n'));
