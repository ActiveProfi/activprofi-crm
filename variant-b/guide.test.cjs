const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./model.js');
const Guide = require('./guide.js');
const Leads = require('./leads-model.js');

test('novice sees only own clients even if a wider right is switched on', () => {
  const state = {clients: [{id: 'a', ownerId: 'n', name: 'Свой'}, {id: 'b', ownerId: 'o', name: 'Чужой'}], projects: [], pipelines: []};
  const novice = {id: 'n', role: 'sales', probation: true, permissionOverrides: {'clients.all': true, 'leads.manage': true}};
  assert.deepEqual(M.visibleClients(state, novice).map(item => item.id), ['a']);
  assert.equal(Leads.canImport(novice, state), false);
  novice.probation = false;
  assert.deepEqual(M.visibleClients(state, novice).map(item => item.id), ['a', 'b']);
  assert.equal(Leads.canImport(novice, state), true);
});

test('day list puts overdue and today before a missing next step', () => {
  const rows = Guide.contactQueue([
    {id: 'later', name: 'Позже', next: 'Написать', when: '2026-11-28T10:00', kind: 'open'},
    {id: 'none', name: 'Пусто', next: '', when: '', kind: 'open'},
    {id: 'late', name: 'Просрочен', next: 'Позвонить', when: '2026-11-20T09:00', kind: 'open'},
    {id: 'today', name: 'Сегодня', next: 'КП', when: '2026-11-23T15:00', kind: 'open'},
    {id: 'lost', name: 'Отказ', next: '', when: '', kind: 'lost'},
    {id: 'base', name: 'В базе', next: '', when: '', kind: 'open', inLeadBase: true},
  ], '2026-11-23');
  assert.deepEqual(rows.map(item => item.id), ['late', 'today', 'later', 'none']);
  assert.equal(rows[0].label, 'Просрочено');
  assert.equal(rows[3].label, 'Нет следующего шага');
});
