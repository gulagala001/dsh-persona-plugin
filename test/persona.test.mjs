import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonaStore } from '../src/store.mjs';
import { acquirePersona } from '../src/index.mjs';
import { applyPersonality } from '../src/shared/prompt.mjs';
import { importPersonalityFile, exportPersonalityFile, personalityPatch, personalityOptions } from '../src/shared/personality.mjs';
import { sessionPersonality } from '../src/session.mjs';

const personality = (name = '测试人设', text = 'PERSONA_TEST') => ({ format: 'dsh.persona', version: 1, name,
  modules: { identity: text, style: 'STYLE_TEST', communication: 'COMMUNICATION_TEST', presentation: '' } });
const temporary = t => { const root = mkdtempSync(join(tmpdir(), 'dsh-persona-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; };

test('new profiles enable independent choices; both new identities reach the prompt and explicit off survives restart', t => {
  const root = temporary(t), store = new PersonaStore(root), hub = { store, config: () => store.config() };
  assert.equal(store.config().sessionPersonalityEnabled, true);
  assert.deepEqual(personalityOptions().map(item => item.value), ['custom', 'default', 'overclock', 'economical', 'off']);
  const assembly = { sections: [{ name: 'host', text: 'HOST_RULES' }], tools: [{ name: 'read' }] };
  for (const [preset, name] of [['overclock', '超频'], ['economical', '精算']]) {
    store.save({ id: preset, personalityPreset: preset });
    const value = sessionPersonality(hub, { id: preset });
    assert.equal(value.effectiveName, name);
    const applied = applyPersonality(assembly, { agent: { session: { id: preset } } }, { forSession: session => sessionPersonality(hub, session) });
    assert.match(applied.sections.find(item => item.name === 'dsh-persona:identity').text, new RegExp(name));
    assert.equal(applied.sections.length, 5);
    assert.equal(applied.sections[0], assembly.sections[0]);
    assert.equal(applied.tools, assembly.tools);
  }
  store.update({ sessionPersonalityEnabled: false });
  const reopened = new PersonaStore(root);
  assert.equal(reopened.config().sessionPersonalityEnabled, false);
  assert.equal(sessionPersonality({ store: reopened, config: () => reopened.config() }, { id: 'overclock' }).preset, 'inherit');
  assert.equal(reopened.choice('overclock'), 'overclock');
});

test('retired selections and newly reserved names load safely without losing custom text or session references', t => {
  const root = temporary(t), id = 'user:11111111-1111-4111-8111-111111111111';
  for (const retired of ['hardcore', 'softie']) {
    const state = { version: 1, migrations: [], sessions: { retired, custom: id }, config: {
      identityPreset: retired, identityPrompt: 'RETIRED_TEXT', identityCustomPrompt: 'KEEP_DRAFT',
      identitySavedPresets: [{ id, name: '精算', text: 'KEEP_PERSONAL_TEXT', modules: { style: 'KEEP_STYLE' } }],
    } };
    writeFileSync(join(root, 'state.json'), JSON.stringify(state));
    const store = new PersonaStore(root), hub = { store, config: () => store.config() };
    assert.equal(store.config().identityPreset, 'default');
    assert.equal(store.config().identityCustomPrompt, 'KEEP_DRAFT');
    assert.equal(sessionPersonality(hub, { id: 'retired' }).missing, true);
    assert.equal(sessionPersonality(hub, { id: 'retired' }).effectivePreset, 'default');
    assert.equal(sessionPersonality(hub, { id: 'custom' }).effectiveName, '精算（自定义）');
    assert.equal(sessionPersonality(hub, { id: 'custom' }).modules.identity, 'KEEP_PERSONAL_TEXT');
    assert.equal(sessionPersonality(hub, { id: 'custom' }).modules.style, 'KEEP_STYLE');
    store.update(personalityPatch(store.config(), id));
    const reopened = new PersonaStore(root);
    assert.equal(reopened.config().identityPreset, id);
    assert.equal(reopened.config().identityPrompt, 'KEEP_PERSONAL_TEXT');
    assert.equal(reopened.choice('custom'), id);
    assert.throws(() => reopened.update({ identityPreset: retired }), /未知/);
  }
});

test('portable files preserve modules, accept legacy files and reject execution configuration', () => {
  const legacy = { ...personality(), format: 'omd.personality' };
  const config = importPersonalityFile({}, JSON.stringify(legacy));
  assert.deepEqual(JSON.parse(exportPersonalityFile(config)), { ...personality(), description: '' });
  assert.notEqual(importPersonalityFile(config, JSON.stringify(legacy)).identityPreset, config.identityPreset);
  for (const invalid of [{ ...legacy, tools: [] }, { ...legacy, modules: { environment: 'fake' } }, { ...legacy, version: 2 }])
    assert.throws(() => importPersonalityFile(config, JSON.stringify(invalid)));
});
test('migration keeps original data, preserves choices after restart and honors explicit inheritance', t => {
  const root = temporary(t), legacyDir = join(root, 'legacy'); mkdirSync(join(legacyDir, 'sessions'), { recursive: true });
  const config = { ...importPersonalityFile({}, JSON.stringify(personality())), sessionPersonalityEnabled: true };
  const original = JSON.stringify({ id: 'session-one', personalityPreset: config.identityPreset, notes: ['keep'] });
  writeFileSync(join(legacyDir, 'sessions/session-one.json'), original);
  let store = new PersonaStore(join(root, 'persona')); store.migrateLegacy(config, legacyDir);
  assert.equal(store.config().identityPreset, config.identityPreset);
  assert.equal(store.choice('session-one'), config.identityPreset);
  store = new PersonaStore(join(root, 'persona'));
  assert.equal(store.choice('session-one'), config.identityPreset);
  store.save({ id: 'session-one' }); assert.equal(store.choice('session-one'), undefined);
  store.migrateLegacy({ ...config, identityPreset: 'off' }, legacyDir);
  assert.equal(store.config().identityPreset, config.identityPreset);
  assert.equal(readFileSync(join(legacyDir, 'sessions/session-one.json'), 'utf8'), original);
});
test('merging with an existing library remaps colliding IDs without replacing either personality', t => {
  const root = temporary(t), legacyDir = join(root, 'legacy'); mkdirSync(join(legacyDir, 'sessions'), { recursive: true });
  const store = new PersonaStore(join(root, 'persona'));
  const first = importPersonalityFile({}, JSON.stringify(personality('同名', 'CURRENT'))); store.update(first);
  const legacy = { ...first, identitySavedPresets: first.identitySavedPresets.map(item => ({ ...item, text: 'LEGACY' })) };
  writeFileSync(join(legacyDir, 'sessions/session-one.json'), JSON.stringify({ id: 'session-one', personalityPreset: first.identityPreset }));
  store.migrateLegacy(legacy, legacyDir);
  assert.equal(store.config().identityPreset, first.identityPreset);
  const migrated = store.choice('session-one'); assert.notEqual(migrated, first.identityPreset);
  assert.equal(store.config().identitySavedPresets.find(item => item.id === migrated).text, 'LEGACY');
  assert.equal(store.config().identitySavedPresets.find(item => item.id === first.identityPreset).text, 'CURRENT');
});
test('duplicate installs share one runtime and removing either owner preserves the other', async t => {
  const home = temporary(t), effects = [], services = new Map(); let routes = 0, hooks = 0;
  services.set('profileContext', { home, dir: join(home, 'profile') });
  const root = { get: key => services.get(key), provide(key, value) { services.set(key, value); return () => services.delete(key); },
    on() { hooks++; return () => hooks--; },
    inject(_keys, callback) { let stop; callback({ effect(fn) { stop = fn(); }, connection: {}, webServer: { register() { routes++; return () => routes--; } } }); return { dispose() { stop(); } }; } };
  const owner = () => ({ root, effect(fn) { effects.push(fn()); } });
  const a = acquirePersona(owner());
  const { acquirePersona: secondCopy } = await import('../src/index.mjs?second-copy');
  const b = secondCopy(owner()); assert.equal(a, b); assert.equal(routes, 1); assert.equal(hooks, 1);
  a.update({ ...importPersonalityFile({}, JSON.stringify(personality())), sessionPersonalityEnabled: true });
  a.store.save({ id: 'session-one', personalityPreset: 'economical' });
  await effects.shift()(); assert.equal(routes, 1); assert.equal(b.forSession({ id: 'session-one' }).effectivePreset, 'economical');
  const assembly = { sections: [{ name: 'host', text: 'KEEP_CORE' }], tools: [{ name: 'read', parameters: { type: 'object' } }] };
  const adapted = applyPersonality(assembly, { agent: { session: { id: 'session-two', header: {} } } }, b);
  assert.equal(adapted.sections[0], assembly.sections[0]); assert.equal(adapted.tools, assembly.tools);
  assert.equal(adapted.sections.filter(section => section.name === 'dsh-persona:identity').length, 1);
  assert.equal(applyPersonality(assembly, { agent: { session: { header: { origin: 'subagent' } } } }, b), assembly);
  assert.equal(applyPersonality({ ...assembly, sections: [{ name: 'dsh-persona:applied' }] }, { agent: { session: { header: {} } } }, b).sections.length, 1);
  b.update(personalityPatch(b.config(), 'off'));
  assert.equal(applyPersonality(assembly, { agent: { session: { id: 'session-two', header: {} } } }, b), assembly);
  await effects.shift()(); assert.equal(routes, 0); assert.equal(hooks, 0); assert.equal(services.has('dshPersona'), false);
});
test('corrupt data fails without resetting the stored file', t => {
  const root = temporary(t); writeFileSync(join(root, 'state.json'), '{broken');
  assert.throws(() => new PersonaStore(root), /保留/);
  assert.equal(readFileSync(join(root, 'state.json'), 'utf8'), '{broken');
});
