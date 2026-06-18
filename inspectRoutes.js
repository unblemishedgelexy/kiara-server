const createApp = require('./src/app');
const app = createApp();
const routes = [];

function traverse(stack, prefix = '') {
  stack.forEach((layer) => {
    if (layer.route && layer.route.path) {
      const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
      methods.forEach((method) => routes.push({ method: method.toUpperCase(), path: prefix + layer.route.path }));
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      const regexp = layer.regexp && layer.regexp.source;
      const mountPath = regexp ? regexp.replace(/^\^/, '').replace(/\\/g, '').replace(/\/?(?=\/|$)/, '').replace(/\?$/, '') : '';
      traverse(layer.handle.stack, mountPath === '/' ? '' : mountPath);
    }
  });
}

traverse(app._router.stack);
console.log(routes.sort((a, b) => a.path.localeCompare(b.path)).map((r) => `${r.method} ${r.path}`).join('\n'));
