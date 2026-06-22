const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const srcRoot = path.join(root, 'src');

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      files.push(...walk(full));
    } else if (stat.isFile() && full.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

function parseImports(file) {
  const text = fs.readFileSync(file, 'utf8');
  const imports = [];
  const requireRegex = /require\(['\"](.+?)['\"]\)/g;
  const importRegex = /import\s+(?:[^'"\n]+\s+from\s+)?['\"](.+?)['\"]/g;
  let m;
  while ((m = requireRegex.exec(text))) imports.push(m[1]);
  while ((m = importRegex.exec(text))) imports.push(m[1]);
  return imports;
}

function resolveImport(fromFile, imp) {
  if (imp.startsWith('.') || imp.startsWith('..')) {
    const full = path.resolve(path.dirname(fromFile), imp);
    const candidates = [full, `${full}.js`, path.join(full, 'index.js')];
    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        return path.relative(root, cand).replace(/\\/g, '/');
      }
    }
  }
  return null;
}

const files = walk(srcRoot);
const map = {};
for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const imports = parseImports(file).map(imp => ({ imp, resolved: resolveImport(file, imp) }));
  map[rel] = imports;
}

const reverse = {};
for (const [file, imports] of Object.entries(map)) {
  imports.forEach(({ resolved }) => {
    if (resolved) {
      reverse[resolved] = reverse[resolved] || new Set();
      reverse[resolved].add(file);
    }
  });
}

function writeJSON(name, obj) {
  fs.writeFileSync(path.join(root, `${name}.json`), JSON.stringify(obj, null, 2));
}
writeJSON('backend-dependency-map', map);
const reverseObj = {};
for (const [k, s] of Object.entries(reverse)) reverseObj[k] = Array.from(s);
writeJSON('backend-reverse-dependency-map', reverseObj);

const roots = ['src/server.js'];
const reachable = new Set();
function dfs(file) {
  if (reachable.has(file)) return;
  reachable.add(file);
  const entry = map[file] || [];
  entry.forEach(({ resolved }) => {
    if (resolved) dfs(resolved);
  });
}
roots.forEach(dfs);
writeJSON('backend-reachable', Array.from(reachable).sort());

const allRel = files.map(f => path.relative(root, f).replace(/\\/g, '/')).sort();
const unused = allRel.filter(f => !reachable.has(f));
writeJSON('backend-unused', unused);

console.log('Wrote backend JSON artifacts:', Object.keys(map).length, 'files');
console.log('Reachable files', reachable.size);
console.log('Unused files', unused.length);
