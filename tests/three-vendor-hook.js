// Resolve the bare `three` specifier to the vendored copy when running under Node.
//
// The browser gets this mapping from the import map in index.html. Node has no
// import map, and `node_modules/` is not checked in, so without this hook
// `npm test` fails on a fresh clone with ERR_MODULE_NOT_FOUND.

import { registerHooks } from 'node:module';

const VENDORED = new URL('../vendor/three.module.js', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'three') return { url: VENDORED, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
