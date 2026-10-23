import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsClient } from '../src/client/settings-client.mjs';

const etag = number => '"' + String(number).padStart(64, '0') + '"';
const response = (config, revision = 0, status = 200) => new Response(JSON.stringify(config), { status, headers: { ETag: etag(revision) } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function globals(t, fetch) {
  const oldFetch = globalThis.fetch, oldWindow = globalThis.window, saved = [];
  globalThis.fetch = fetch; globalThis.window = { dispatchEvent: event => saved.push(event.detail) };
  t.after(() => { globalThis.fetch = oldFetch; if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow; });
  return saved;
}

test('a conflict refreshes the authoritative config without retrying the stale edit', async t => {
  const writes = [], first = { identitySavedPresets: [] }, latest = { identitySavedPresets: [{ id: 'new', name: 'Other window' }] };
  const saved = globals(t, async (_url, options) => {
    if (!options.method) return response(first);
    writes.push(options);
    return response({ error: 'conflict', config: latest }, 1, 409);
  });
  const client = createSettingsClient(); t.after(() => client.dispose()); await client.load();
  assert.equal(await client.commit({ identitySavedPresets: [] }), false);
  assert.equal(writes.length, 1); assert.equal(writes[0].headers['If-Match'], etag(0));
  assert.deepEqual(client.getSnapshot().config, latest); assert.match(client.getSnapshot().error, /conflict/);
  assert.equal(saved.length, 0);
});

test('async edits retain their original read revision even after the client reloads', async t => {
  let reads = 0, write;
  globals(t, async (_url, options) => {
    if (!options.method) return response({ identityPrompt: 'Read ' + reads }, reads++);
    write = options; return response({ error: 'conflict', config: { identityPrompt: 'Read 1' } }, 1, 409);
  });
  const client = createSettingsClient(); t.after(() => client.dispose()); await client.load();
  const original = client.getSnapshot().config;
  await client.load();
  assert.equal(await client.commit({ identityPrompt: 'Old edit' }, original), false);
  assert.equal(write.headers['If-Match'], etag(0));
});

test('queued edits snapshot their values and cannot borrow a newer successful receipt', async t => {
  const gate = deferred(), entered = deferred(), writes = [];
  globals(t, async (_url, options) => {
    if (!options.method) return response({ identityPrompt: 'Original' });
    writes.push(options);
    if (writes.length === 1) { entered.resolve(); await gate.promise; return response({ identityPrompt: 'First' }, 1); }
    return response({ error: 'conflict', config: { identityPrompt: 'First' } }, 1, 409);
  });
  const client = createSettingsClient(); t.after(() => client.dispose()); await client.load();
  const first = client.commit({ identityPrompt: 'First' }); await entered.promise;
  const patch = { identityCustomModules: { style: 'Original draft' } }, second = client.commit(patch);
  patch.identityCustomModules.style = 'Mutated later'; gate.resolve();
  assert.equal(await first, true); assert.equal(await second, false);
  assert.equal(writes[1].headers['If-Match'], etag(0));
  assert.equal(JSON.parse(writes[1].body).identityCustomModules.style, 'Original draft');
});

test('a delayed read cannot replace a completed save and reads requested during saving wait', async t => {
  const readGate = deferred(), writeGate = deferred(), entered = deferred(); let reads = 0;
  globals(t, async (_url, options) => {
    if (!options.method) { reads++; if (reads === 2) await readGate.promise; return response({ identityPrompt: 'Old' }); }
    entered.resolve(); await writeGate.promise; return response({ identityPrompt: 'New' }, 1);
  });
  const client = createSettingsClient(); t.after(() => client.dispose()); await client.load();
  const staleRead = client.load(); await new Promise(resolve => setImmediate(resolve));
  const save = client.commit({ identityPrompt: 'New' }); await entered.promise;
  const duringWrite = client.load();
  assert.equal(reads, 2); writeGate.resolve(); assert.equal(await save, true);
  readGate.resolve(); await Promise.all([staleRead, duringWrite]);
  assert.equal(client.getSnapshot().config.identityPrompt, 'New');
  assert.equal(reads, 2);
});

test('unloading cancels the in-flight request and never dispatches queued writes', async t => {
  let writes = 0, signal; const entered = deferred();
  const saved = globals(t, async (_url, options) => {
    if (!options.method) return response({ identityPrompt: 'Original' });
    writes++; signal = options.signal; entered.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const client = createSettingsClient(); await client.load();
  const first = client.commit({ identityPrompt: 'First' }); await entered.promise;
  const second = client.commit({ identityPrompt: 'Second' }); client.dispose();
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(signal.aborted, true); assert.equal(writes, 1); assert.equal(saved.length, 0);
  assert.equal(await client.commit({ identityPrompt: 'After unload' }), false);
});
