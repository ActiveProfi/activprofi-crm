const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const M = require('./model.js');
const L = require('./leads-model.js');

function fixture() {
  const box = {window: {}};
  vm.runInNewContext(fs.readFileSync(__dirname + '/seed.js', 'utf8'), box);
  return L.upgrade(M.migrate(JSON.parse(JSON.stringify(box.window.BASE_SEED))));
}

test('Proposal stage is inserted before won and does not move existing deals', () => {
  const state = fixture();
  const inbound = state.pipelines.find(pipe => pipe.id === 'inbound');
  const kp = inbound.stages.findIndex(stage => stage.name === 'Отправлено КП');
  const won = inbound.stages.findIndex(stage => stage.kind === 'won');
  assert.ok(kp > 0);
  assert.ok(kp < won);
  assert.equal(inbound.stages[kp].kind, 'open');
  const kept = state.clients.find(client => client.stageId === 'stage-2');
  assert.ok(kept);
  const stageBefore = kept.stageId;
  state.pipelines.push({id: 'custom', name: 'Отдельная', stages: [{id: 'a', name: 'Старт', kind: 'open'}, {id: 'b', name: 'Успех', kind: 'won'}, {id: 'c', name: 'Отказ', kind: 'lost'}]});
  state.clients.push({id: 'stay', pipelineId: 'custom', stageId: 'a'});
  L.upgrade(state);
  const custom = state.pipelines.find(pipe => pipe.id === 'custom');
  assert.deepEqual(custom.stages.map(stage => stage.name), ['Старт', 'Отправлено КП', 'Успех', 'Отказ']);
  assert.equal(state.clients.find(client => client.id === 'stay').stageId, 'a');
  assert.equal(kept.stageId, stageBefore);
  L.upgrade(state);
  assert.equal(custom.stages.filter(stage => stage.name === 'Отправлено КП').length, 1);
  assert.equal(inbound.stages.filter(stage => stage.name === 'Отправлено КП').length, 1);
});

test('API deal keeps the commercial fields and lands on the requested stage', () => {
  const state = fixture();
  const [deal] = L.acceptIntegrationDeals(state, [{
    name: 'Ирина Колл',
    description: 'Сеть кофеен',
    email: 'irina-call@example.test',
    phone: '+7 999 555-01-99',
    source: 'колл-центр',
    date: '2026-11-18',
    clientTask: 'Автоматизировать заявки',
    kpVariants: 'Базовый 90 000 / 3 недели',
    kpLink: 'https://kp.example.test/maya',
    callAt: '2026-11-20T15:00',
    statusNote: 'ждём решения',
    comment: 'Просили два варианта',
  }], {pipelineId: 'inbound', stage: 'Отправлено КП', name: 'Колл-центр'});
  assert.equal(deal.status, 'created');
  const client = state.clients.find(item => item.id === deal.id);
  assert.equal(client.stage, 'Отправлено КП');
  assert.equal(client.inLeadBase, false);
  assert.equal(client.source, 'колл-центр');
  assert.equal(client.email, 'irina-call@example.test');
  assert.equal(client.clientTask, 'Автоматизировать заявки');
  assert.equal(client.kpVariants, 'Базовый 90 000 / 3 недели');
  assert.equal(client.kpLink, 'https://kp.example.test/maya');
  assert.equal(client.callAt, '2026-11-20T15:00');
  assert.equal(client.statusNote, 'ждём решения');
  assert.equal(client.dealDate, '2026-11-18');
  assert.match(client.sourceComment, /два варианта/);
  const again = L.acceptIntegrationDeals(state, [{name: 'Повтор', phone: '+7 999 555-01-99', comment: 'ещё раз'}], {pipelineId: 'inbound', stage: 'Отправлено КП', name: 'Повтор'});
  assert.equal(again[0].status, 'duplicate');
  assert.equal(again[0].id, deal.id);
  assert.throws(() => L.acceptIntegrationDeals(state, [{name: 'Нет', phone: '+7 999 555-01-98'}], {pipelineId: 'inbound', stage: 'Нет такого этапа', name: 'Ошибка'}));
});
