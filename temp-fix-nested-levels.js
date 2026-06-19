const fs = require('fs');
const path = require('path');
const root = process.cwd();

function walk(dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) {
      results = results.concat(walk(full));
    } else if (full.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

const files = walk('src/services');
let patched = 0;

for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const parts = rel.split('/');
  const servicesIdx = parts.indexOf('services');
  
  // Root-level service: src/services/*.js
  const isRootService = servicesIdx >= 0 && parts.length === servicesIdx + 2;
  
  // Nested service: src/services/*/.../*.js
  const isNestedService = servicesIdx >= 0 && parts.length > servicesIdx + 2;
  
  let text = fs.readFileSync(file, 'utf8');
  let newText = text;
  
  if (isRootService) {
    // Root level: src/services/imageService.js needs ../config/ and ../models/
    newText = text
      .split("require('../../config/").join("require('../config/")
      .split("require('../../models/").join("require('../models/")
      .split('require("../../config/').join('require("../config/')
      .split('require("../../models/').join('require("../models/');
  } else if (isNestedService) {
    // Nested: src/services/auth/authService.js needs ../../config/ and ../../models/
    newText = text
      .split("require('../config/").join("require('../../config/")
      .split("require('../models/").join("require('../../models/")
      .split('require("../config/').join('require("../../config/')
      .split('require("../models/').join('require("../../models/');
  }
  
  if (newText !== text) {
    fs.writeFileSync(file, newText, 'utf8');
    console.log('patched', rel);
    patched++;
  }
}

console.log('done', patched, 'files');
