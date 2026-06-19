const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, 'src');
const jsFiles = [];
function walk(dir){
  for(const f of fs.readdirSync(dir)){
    const full = path.join(dir,f);
    if(fs.statSync(full).isDirectory()) walk(full);
    else if(full.endsWith('.js')||full.endsWith('.mjs')||full.endsWith('.cjs')) jsFiles.push(full);
  }
}
walk(root);
const requireRe = /require\(['\"]([^'\"]+)['\"]\)/g;
const importRe = /import\s+(?:[^'"]+from\s+)?['\"]([^'\"]+)['\"]/g;
const missing = [];
function existsModule(baseDir, rel){
  if(rel.startsWith('/')||!rel.startsWith('.')) return true; // skip core/external
  const candidates = [];
  const p = path.resolve(baseDir, rel);
  candidates.push(p);
  candidates.push(p + '.js');
  candidates.push(p + '.mjs');
  candidates.push(p + '.cjs');
  candidates.push(p + '.json');
  candidates.push(path.join(p, 'index.js'));
  for(const c of candidates){ if(fs.existsSync(c)) return true; }
  return false;
}
for(const file of jsFiles){
  const text = fs.readFileSync(file,'utf8');
  let m;
  while((m=requireRe.exec(text))){
    const target = m[1];
    if(!existsModule(path.dirname(file), target)) missing.push({file, target});
  }
  while((m=importRe.exec(text))){
    const target = m[1];
    if(!existsModule(path.dirname(file), target)) missing.push({file, target});
  }
}
if(missing.length===0) console.log('NO_MISSING');
else {
  for(const x of missing){
    console.log(x.file.replace(/\\/g,'/'), '->', x.target);
  }
}
