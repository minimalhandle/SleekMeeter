const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Exercise the actual persistence/handoff functions with a delayed save pending,
// as happens when another mixer window imports while a control is being edited.
test('import handoff cancels stale saves, adopts new settings and refreshes once', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/app/01-core.js'), 'utf8');
  const start = source.indexOf('let saveTimer;');
  const end = source.indexOf('function showProblems(', start);
  assert.ok(start >= 0 && end > start);
  const pending = new Map(); let timer = 0, reloads = 0, saves = 0;
  const stored = new Map();
  const context = vm.createContext({
    settings: { theme: 'old' }, DEFAULT_SETTINGS: { theme: 'default' },
    clone: (x) => structuredClone(x),
    setTimeout: (fn) => { const id = ++timer; pending.set(id, fn); return id; },
    clearTimeout: (id) => pending.delete(id),
    sessionStorage: { setItem: (key, value) => stored.set(key, value) },
    document: { body: { inert: false } },
    location: { reload: () => reloads++ },
    engine: { saveSettings: async () => { saves++; } },
    fail: (e) => { throw e; }, showProblems: () => {},
  });
  vm.runInContext(source.slice(start, end), context);
  vm.runInContext('saveSettings()', context);
  assert.equal(pending.size, 1);
  vm.runInContext('reloadImportedSetup({settings:{theme:"imported",migrationEpoch:"epoch"},backup:"backup-dir"})', context);
  assert.equal(pending.size, 0);
  assert.equal(context.settings.theme, 'imported');
  assert.equal(context.document.body.inert, true);
  assert.equal(reloads, 1);
  assert.equal(stored.get('setupImportedBackup'), 'backup-dir');
  vm.runInContext('saveSettings(); reloadImportedSetup({settings:{theme:"duplicate"}})', context);
  assert.equal(await vm.runInContext('saveNow()', context), false);
  assert.equal(pending.size, 0); assert.equal(saves, 0); assert.equal(reloads, 1);
  assert.equal(context.settings.theme, 'imported');
});
