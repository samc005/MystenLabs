// Loads a TypeScript module from demo-ui (and the relative modules it imports) without a build step.
// Packages resolve normally. `overrides` replaces any import by name, like the other tests do by hand.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const nodeRequire = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadTs(file, overrides = {}) {
  const cache = new Map();
  function load(absolute) {
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const output = ts.transpileModule(readFileSync(absolute, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const module = { exports: {} };
    cache.set(absolute, module);
    const require = (name) => {
      if (name in overrides) return overrides[name];
      if (name.startsWith('.')) return load(`${path.resolve(path.dirname(absolute), name)}.ts`);
      return nodeRequire(name);
    };
    new Function('require', 'exports', 'module', output)(require, module.exports, module);
    return module.exports;
  }
  return load(path.resolve(root, file));
}
