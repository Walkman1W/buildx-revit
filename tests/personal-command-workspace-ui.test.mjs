import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputUi, session, flush, UiEvent } from '../test-support/model-input-ui-fixture.mjs';
import { MODEL_COMMAND_CATALOG } from '../lib/model-command-catalog.mjs';
import { supportsConfirmedWriteCommand } from '../lib/confirmed-write-profile.mjs';

const state = {
  workspace: { kind: 'model', supportsModelContext: true },
  ready: false,
  commandsReady: true,
  commandReadiness: 'local',
  directCommandsAvailable: true,
  commandCatalog: MODEL_COMMAND_CATALOG,
  historyAvailable: true,
  account: { required: false },
};

const notes = {
  command_id: 'notes',
  revision: 'a'.repeat(64),
  name: '项目备注',
  description: '汇总项目备注',
  schema_version: 2,
  created_utc: '2026-11-14T10:00:00.000Z',
  verification: { status: 'unverified' },
};
const floors = {
  ...notes,
  command_id: 'floors',
  revision: 'b'.repeat(64),
  name: '楼板核对',
  description: '检查楼板',
  created_utc: '2026-11-14T08:00:00.000Z',
};
const olderNotes = { ...notes, revision: 'c'.repeat(64), created_utc: '2026-11-14T09:00:00.000Z' };
const viewedNotes = { ...notes, code: 'return parameters;', parameters: { count: 'integer' } };

const nodes = (root, className) => root.querySelectorAll('.' + className);
const row = (ui, id) => nodes(ui.document.body, 'model-command-item').find(item => item.dataset.commandId === id);
const cards = ui => nodes(row(ui, 'revit_list_commands'), 'model-command-stored-version');
const versionKey = command => 'personal:' + command.command_id + ':' + command.revision;
const cardFor = (ui, command) => cards(ui).find(card => card.dataset.favoriteKey === versionKey(command));
const listedVersions = ui => cards(ui).map(card => card.dataset.favoriteKey);
const filter = (ui, scope) => nodes(ui.document.body, 'model-command-scope').find(button => button.dataset.scope === scope);
const searchField = ui => nodes(ui.document.body, 'model-command-filter')[0];
function visible(element) {
  for (let node = element; node; node = node.parent) {
    if (node.hidden) return false;
  }
  return Boolean(element);
}

function search(ui, value) {
  const input = searchField(ui);
  input.value = value;
  input.dispatchEvent(new UiEvent('input'));
}

function complete(ui, commandId, executionId, data, conversationId = 'chat-a') {
  ui.emit('conversation', {
    busy: false,
    session: session(conversationId),
    command: {
      commandId, executionId, conversationId, status: 'completed',
      result: { data: { value: data } },
    },
  });
}

function showPage(ui, commands, {
  offset = 0, limit = 20, total = commands.length, has_more = false, executionId = 'list-1', conversationId,
} = {}) {
  complete(ui, 'revit_list_commands', executionId, { commands, offset, limit, total, has_more }, conversationId);
}

async function setup(t, overrides = {}) {
  const ui = await createInputUi();
  t.after(() => ui.close());
  ui.emit('state', { ...state, ...overrides });
  ui.emit('conversation', { busy: false, session: session() });
  nodes(ui.document.body, 'model-tab').find(tab => tab.textContent === '命令').click();
  await flush();
  return ui;
}

test('search intersects exact personal favorites and shows the empty state for a non-favorite match', async t => {
  const ui = await setup(t);
  showPage(ui, [notes, floors]);
  nodes(cardFor(ui, notes), 'model-personal-favorite')[0].click();
  filter(ui, 'favorites').click();
  search(ui, floors.name);

  assert.equal(cardFor(ui, floors).hidden, true);
  assert.equal(cardFor(ui, notes).hidden, true);
  assert.equal(row(ui, 'revit_list_commands').hidden, true);
  assert.equal(ui.get('model-command-empty').hidden, false);
  assert.match(ui.get('model-command-empty-text').textContent, /没有匹配的会话收藏/);
  assert.equal(ui.requests.length, 0);
});

test('a favorite opens its reviewed revision and confirmed form without clearing filters or running it', async t => {
  const ui = await setup(t);
  showPage(ui, [notes, olderNotes]);
  nodes(cardFor(ui, notes), 'model-personal-favorite')[0].click();
  filter(ui, 'favorites').click();
  search(ui, notes.name);
  assert.equal(cardFor(ui, olderNotes).hidden, true);
  assert.equal(cardFor(ui, notes).hidden, false);
  assert.equal(ui.requests.length, 0);

  nodes(cardFor(ui, notes), 'model-command-version-view')[0].click();
  await flush();
  const [viewRequest] = ui.requests;
  assert.equal(ui.requests.length, 1);
  assert.equal(viewRequest.body.commandId, 'revit_get_command');
  assert.deepEqual(viewRequest.body.parameters, { command_id: notes.command_id, revision: notes.revision });
  assert.equal(searchField(ui).value, notes.name);
  await ui.respond(viewRequest, { ok: true, executionId: 'view-notes' });
  complete(ui, 'revit_get_command', 'view-notes', viewedNotes);

  const detail = row(ui, 'revit_get_command');
  assert.equal(visible(detail), true);
  assert.match(detail.textContent, /项目备注/);
  assert.match(detail.textContent, new RegExp(notes.revision));

  const execution = row(ui, 'revit_run_command');
  const confirmation = nodes(execution, 'model-command-confirm')[0].children[0];
  const mode = ui.get('model-command-revit_run_command-mode');
  const parameterId = 'model-command-revit_run_command-parameters-count';
  mode.value = 'commit';
  ui.get('model-command-revit_run_command-parameters').value = '{"count":99}';
  confirmation.checked = true;
  nodes(detail, 'model-command-version-choose')[0].click();
  await flush();

  assert.equal(visible(nodes(execution, 'model-command-parameters')[0]), true);
  assert.equal(searchField(ui).value, notes.name);
  assert.equal(filter(ui, 'favorites').getAttribute('aria-pressed'), 'true');
  assert.equal(ui.get('model-command-revit_run_command-command_id').value, notes.command_id);
  assert.equal(ui.get('model-command-revit_run_command-revision').value, notes.revision);
  const count = ui.get(parameterId);
  assert.equal(visible(count), true);
  assert.equal(count.value, '');
  assert.equal(mode.value, 'rollback');
  assert.equal(confirmation.checked, false);
  assert.equal(ui.requests.length, 1);

  const run = nodes(execution, 'model-command-run')[0];
  count.value = '4';
  count.dispatchEvent(new UiEvent('input'));
  run.click();
  await flush();
  assert.equal(ui.requests.length, 1, 'the viewed revision still requires explicit confirmation');
  confirmation.checked = true;
  run.click();
  await flush();
  assert.equal(ui.requests.length, 2);
  const runRequest = ui.requests[1];
  assert.equal(runRequest.body.commandId, 'revit_run_command');
  assert.equal(runRequest.body.confirmed, true);
  assert.deepEqual(runRequest.body.parameters, {
    command_id: notes.command_id,
    revision: notes.revision,
    parameters: { count: 4 },
    mode: 'rollback',
  });
  await ui.respond(runRequest, { ok: true, executionId: 'run-notes' });
});

test('the confirmed-write catalog can review a saved revision without offering to run it', async t => {
  const ui = await setup(t, {
    confirmedWrite: true,
    commandCatalog: MODEL_COMMAND_CATALOG.filter(supportsConfirmedWriteCommand),
  });
  complete(ui, 'revit_get_command', 'view-notes', viewedNotes);

  const detail = row(ui, 'revit_get_command');
  assert.match(detail.textContent, /项目备注/);
  assert.equal(nodes(detail, 'model-command-version-choose').length, 0);
  assert.equal(row(ui, 'revit_run_command'), undefined);
  assert.equal(ui.requests.length, 0);
});

test('explicit paging extends search while keeping first-page favorites and deduplicating exact revisions', async t => {
  const ui = await setup(t);
  showPage(ui, [notes, olderNotes], { limit: 2, total: 4, has_more: true });
  assert.deepEqual(listedVersions(ui), [notes, olderNotes].map(versionKey));
  nodes(cardFor(ui, olderNotes), 'model-personal-favorite')[0].click();
  search(ui, floors.name);
  assert.equal(ui.get('model-command-empty').hidden, false);
  assert.equal(ui.requests.length, 0);

  const next = nodes(ui.document.body, 'model-command-next-page').find(visible);
  assert.ok(next, 'loading the next page is available while there are no matches');
  assert.equal(next.disabled, false);
  next.click();
  await flush();
  assert.equal(ui.requests.length, 1);
  const [pageRequest] = ui.requests;
  assert.equal(pageRequest.body.commandId, 'revit_list_commands');
  assert.deepEqual(pageRequest.body.parameters, { offset: 2, limit: 2 });
  await ui.respond(pageRequest, { ok: true, executionId: 'list-2' });
  showPage(ui, [olderNotes, floors], { offset: 2, limit: 2, total: 4, executionId: 'list-2' });

  assert.equal(searchField(ui).value, floors.name);
  assert.equal(ui.get('model-command-empty').hidden, true);
  assert.equal(cardFor(ui, floors).hidden, false);
  assert.deepEqual(listedVersions(ui), [notes, olderNotes, floors].map(versionKey));
  search(ui, notes.name);
  filter(ui, 'favorites').click();
  assert.equal(row(ui, 'revit_list_commands').hidden, false);
  assert.equal(cardFor(ui, olderNotes).hidden, false);
  assert.equal(cardFor(ui, notes).hidden, true);
  assert.equal(cardFor(ui, floors).hidden, true);
  assert.equal(nodes(cardFor(ui, olderNotes), 'model-personal-favorite')[0].getAttribute('aria-pressed'), 'true');
  assert.equal(ui.requests.length, 1);
});

test('a rejected next page keeps the first page and only retries the same offset after a click', async t => {
  const ui = await setup(t);
  showPage(ui, [notes], { limit: 1, total: 2, has_more: true });
  const next = () => nodes(ui.document.body, 'model-command-next-page').find(visible);
  next().click();
  await flush();
  const [request] = ui.requests;
  assert.deepEqual(request.body.parameters, { offset: 1, limit: 1 });
  await ui.respond(request, { error: '命令繁忙，未接受请求' }, false);

  assert.equal(ui.requests.length, 1);
  assert.deepEqual(listedVersions(ui), [versionKey(notes)]);
  assert.equal(next().disabled, false);
  next().click();
  await flush();
  assert.equal(ui.requests.length, 2);
  const retry = ui.requests[1];
  assert.equal(retry.body.commandId, 'revit_list_commands');
  assert.deepEqual(retry.body.parameters, request.body.parameters);
  await ui.respond(retry, { ok: true, executionId: 'list-after-retry' });
  showPage(ui, [floors], { offset: 1, limit: 1, total: 2, executionId: 'list-after-retry' });
  assert.deepEqual(listedVersions(ui), [notes, floors].map(versionKey));
  assert.equal(next(), undefined);
});

test('changing conversations clears old command cards and actions but retains favorite choices for the same account', async t => {
  const ui = await setup(t);
  showPage(ui, [notes, olderNotes]);
  const noteCard = cardFor(ui, notes);
  nodes(noteCard, 'model-personal-favorite')[0].click();
  const staleView = nodes(noteCard, 'model-command-version-view')[0];

  ui.conversation('chat-b');
  await flush();
  assert.deepEqual(listedVersions(ui), []);
  staleView.click();
  await flush();
  assert.equal(ui.requests.length, 0);

  showPage(ui, [notes, olderNotes], { conversationId: 'chat-b', executionId: 'chat-b-list' });
  filter(ui, 'favorites').click();
  assert.equal(visible(cardFor(ui, notes)), true);
  assert.equal(visible(cardFor(ui, olderNotes)), false);
  assert.equal(ui.requests.length, 0);
});
