import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { acquirePersona } from '../src/index.mjs';
import { PersonaStore } from '../src/store.mjs';
import { importPersonalityFile } from '../src/shared/personality.mjs';

const imported = (config, name) => importPersonalityFile(config, JSON.stringify({
  format: 'dsh.persona', version: 1, name, modules: { identity: name },
}));

async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'persona-settings-')), ctx = new Context();
  let handler, service, routes = 0;
  ctx.reflect.provide('profileContext', { home, dir: join(home, 'profile') });
  ctx.reflect.provide('connection', { requestRejection: () => undefined });
  ctx.reflect.provide('webServer', { register(route) { handler = route.handler; routes++; return () => routes--; } });
  const owner = ctx.plugin({ name: 'persona-test', apply(scope) { service = acquirePersona(scope); } });
  await owner;
  const second = ctx.plugin({ name: 'persona-test-second', apply(scope) { assert.equal(acquirePersona(scope), service); } });
  await second;
  assert.equal(routes, 1);
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/api/dsh-persona/settings`;
  t.after(async () => { await ctx.fiber.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(home, { recursive: true, force: true }); });
  const read = async () => { const response = await fetch(url); return { revision: response.headers.get('etag'), config: await response.json() }; };
  const write = async (patch, revision) => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(revision === undefined ? {} : { 'If-Match': revision }) }, body: JSON.stringify(patch) });
    return { status: response.status, revision: response.headers.get('etag'), data: await response.json() };
  };
  return { ctx, owner, second, service, server, url, read, write, routes: () => routes };
}

test('real Cordis owners and HTTP writes preserve a newer library and allow an explicit refreshed save', async t => {
  const f = await fixture(t), first = await f.read(), second = await f.read();
  const a = await f.write(imported(first.config, 'Window A'), first.revision);
  assert.equal(a.status, 200);
  const stale = await f.write(imported(second.config, 'Window B'), second.revision);
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.data.config.identitySavedPresets.map(item => item.name), ['Window A']);
  assert.equal(stale.revision, a.revision);
  const b = await f.write(imported(stale.data.config, 'Window B'), stale.revision);
  assert.equal(b.status, 200);
  const restarted = new PersonaStore(f.service.store.dir);
  assert.deepEqual(restarted.config().identitySavedPresets.map(item => item.name), ['Window A', 'Window B']);
  assert.equal(restarted.revision(), b.revision);
  assert.match(f.service.promptFor({ id: 'session-a' }), /Window B/);
  // Session choices do not change the global library's revision.
  f.service.store.save({ id: 'session-a', personalityPreset: 'economical' });
  assert.equal((await f.read()).revision, b.revision);
  await f.owner.dispose(); assert.equal(f.routes(), 1);
  assert.equal((await f.write({ sessionPersonalityEnabled: true }, b.revision)).status, 200);
  assert.equal(f.service.forSession({ id: 'session-a' }).effectivePreset, 'economical');
  await f.second.dispose(); assert.equal(f.routes(), 0);
});

test('unconditional, wildcard, invalid and failed writes cannot silently replace the accepted state', async t => {
  const f = await fixture(t), base = await f.read();
  assert.equal((await f.write({ identityPrompt: 'missing revision' })).status, 428);
  assert.equal((await f.write({ identityPrompt: 'wildcard' }, '*')).status, 409);
  assert.equal((await f.write({ unexpected: true }, base.revision)).status, 400);
  const commit = f.service.store.commit;
  f.service.store.commit = () => { throw Error('injected storage failure'); };
  try {
    const failed = await f.write({ identityPrompt: 'not saved' }, base.revision);
    assert.equal(failed.status, 400);
    assert.deepEqual(failed.data.config, base.config);
    assert.equal(failed.revision, base.revision);
  } finally { f.service.store.commit = commit; }
  assert.deepEqual(await f.read(), base);
  assert.equal((await f.write({ identityPrompt: 'saved' }, base.revision)).status, 200);
});

test('revision is checked after the request body, not at request admission', async t => {
  const f = await fixture(t), base = await f.read();
  const req = httpRequest(f.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': base.revision } });
  const response = new Promise((resolve, reject) => {
    req.once('error', reject);
    req.once('response', async res => { let text = ''; for await (const chunk of res) text += chunk; resolve({ status: res.statusCode, data: JSON.parse(text) }); });
  });
  const body = JSON.stringify(imported(base.config, 'Slow window'));
  req.write(body.slice(0, 10));
  assert.equal((await f.write(imported(base.config, 'Fast window'), base.revision)).status, 200);
  req.end(body.slice(10));
  assert.equal((await response).status, 409);
  assert.deepEqual((await f.read()).config.identitySavedPresets.map(item => item.name), ['Fast window']);
});

test('a request accepted before unload cannot overwrite the replacement runtime', async t => {
  const f = await fixture(t), base = await f.read();
  const accepted = once(f.server, 'request');
  const req = httpRequest(f.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'If-Match': base.revision } });
  const response = new Promise((resolve, reject) => {
    req.once('error', reject);
    req.once('response', async res => { for await (const _chunk of res) {} resolve(res.statusCode); });
  });
  const body = JSON.stringify(imported(base.config, 'Retired window'));
  req.write(body.slice(0, 10));
  await accepted;
  await f.owner.dispose(); await f.second.dispose();
  let replacement;
  await f.ctx.plugin({ name: 'persona-test-replacement', apply(scope) { replacement = acquirePersona(scope); } });
  replacement.update(imported(replacement.config(), 'Replacement window'));
  req.end(body.slice(10));
  const status = await response;
  const restarted = new PersonaStore(replacement.store.dir);
  assert.deepEqual(restarted.config().identitySavedPresets.map(item => item.name), ['Replacement window']);
  assert.equal(status, 503);
});
