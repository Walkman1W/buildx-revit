import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { customerSkillCatalog } from '../lib/buildx-skills.mjs';
import { observeProjectToolReadiness } from '../lib/project-agent-bridge.mjs';

const root = path.resolve('product-fixture');
const id = '7e90bdb2-7c6d-4a72-a421-3e8d3703995b';
const product = { id, name: 'buildx-project-research', scope: 'repo', enabled: true,
  path: path.join(root, '.agents', 'skills', 'buildx-project-research', 'SKILL.md') };
const toolStates = { buildx_materials_list: 'available', buildx_materials_read: 'available' };
const catalog = (discovered, states = toolStates) => customerSkillCatalog({ root, discovered, toolStates: states });

test('only a discovered product-owned skill is returned with its own description and selection id', () => {
  const privateSkill = { ...product, name: 'private', path: path.resolve('private', 'SKILL.md'), description: 'private details' };
  const [item] = catalog([{ ...product, description: 'untrusted description' }, privateSkill]);
  assert.equal(item.availability, 'available');
  assert.equal(item.selectable, true);
  assert.equal(item.id, id);
  assert.equal(item.dependencies.length, 2);
  assert.deepEqual(item.dependencies.map(dependency => dependency.name), ['buildx_materials_list', 'buildx_materials_read']);
  assert.doesNotMatch(JSON.stringify(item), /private|untrusted|SKILL\.md/);
});

test('a personal skill with the same name, wrong scope, or ambiguous identity cannot be selected', () => {
  for (const entries of [
    [{ ...product, path: path.resolve('private', 'SKILL.md') }],
    [{ ...product, scope: 'user' }],
    [product, product],
  ]) {
    const [item] = catalog(entries);
    assert.equal(item.selectable, false);
    assert.equal(item.availability, 'unavailable');
    assert.equal(item.id, undefined);
  }
});

test('dependency and discovery uncertainty do not claim availability', () => {
  assert.equal(catalog([product], {})[0].availability, 'unknown');
  assert.equal(catalog([product], { ...toolStates, buildx_materials_read: 'unavailable' })[0].availability, 'unavailable');
  assert.equal(catalog([{ ...product, enabled: false }])[0].availability, 'unavailable');
  assert.equal(catalog([{ ...product, id: 'not-a-selection-id' }])[0].availability, 'unknown');
  assert.throws(() => customerSkillCatalog({ root: 'relative', discovered: [] }), TypeError);
});

test('a project or connection invalidated during readiness refresh is never reported ready', async () => {
  let current=true,release,entered;
  const started=new Promise(resolve=>entered=resolve),pending=new Promise(resolve=>release=resolve);
  const service={refresh:async()=>{entered();await pending;return {ok:true};},list:()=>({ok:true,value:{coverage:{complete:true},refreshing:false,files:[]}}),search(){},read(){},table(){}};
  const check=observeProjectToolReadiness({isCurrent:()=>current,knowledge:{service,isCurrent:()=>current}});
  await started;current=false;release();assert.equal(await check,false);
});
