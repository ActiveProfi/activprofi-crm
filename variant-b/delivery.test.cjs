const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const M = require('./model.js');
const D = require('./delivery-model.js');

function fixture() {
  const box = {window: {}};
  vm.runInNewContext(fs.readFileSync(__dirname + '/seed.js', 'utf8'), box);
  const state = M.migrate(JSON.parse(JSON.stringify(box.window.BASE_SEED)));
  D.upgrade(state);
  return state;
}

test('Delivery board keeps a fixed stage list and puts existing projects on the first stage once', () => {
  const state = fixture();
  assert.deepEqual(D.stages.map(stage => stage.name), ['Начало проекта', '1 релиз', '2 релиз', '3 релиз', 'Доработка', 'Внедрение', 'Обучение', 'Техподдержка']);
  assert.ok(state.projects.every(project => project.devStage === 'dev-start'));
  const before = JSON.stringify(state.projects);
  D.upgrade(state);
  assert.equal(JSON.stringify(state.projects), before);
});

test('Won deal becomes one project; head, PM and admin see all, developer sees only own tasks', () => {
  const state = fixture();
  const user = id => state.users.find(item => item.id === id);
  const head = {id: 'devhead', role: 'dev_head', name: 'Павел'};
  state.users.push(head);
  for (const project of state.projects) project.members = project.members.filter(id => id !== 'pm');
  assert.equal(M.visibleProjects(state, user('pm')).length, state.projects.length);
  assert.equal(M.visibleTasks(state, user('pm')).length, state.tasks.length);
  assert.equal(M.visibleProjects(state, head).length, state.projects.length);
  assert.equal(M.visibleTasks(state, head).length, state.tasks.length);
  assert.equal(M.canAssign(state, head, '1'), true);
  assert.equal(M.visibleProjects(state, {id: 'outsider', role: 'developer'}).length, 0);

  const sales = user('sales');
  const won = state.pipelines.find(pipe => pipe.id === 'inbound').stages.find(stage => stage.kind === 'won');
  M.moveClient(state, sales, '4', 'inbound', won.id);
  const client = state.clients.find(item => item.id === '4');
  const project = D.ensureFromWon(state, client, sales.id);
  assert.equal(project.devStage, 'dev-start');
  assert.equal(client.project, project.id);
  assert.ok(project.members.includes('sales'));
  assert.equal(D.ensureFromWon(state, client, sales.id).id, project.id);
  assert.equal(state.projects.filter(item => item.sourceClientId === '4').length, 1);
  const kept = state.projects.find(item => item.id === '2');
  const keptDescription = kept.description;
  const olga = state.clients.find(item => item.id === '5');
  olga.handover = {sold: 'Сервис прайсов', kp: 'Базовый пакет', amount: 170000, due: '2026-12-01', contacts: '+7 999 000-00-05', kpLink: 'https://kp.example/olga', files: ['Прайс.txt']};
  D.ensureFromWon(state, olga, sales.id);
  assert.equal(kept.description, keptDescription);
  assert.equal(kept.handover.sold, 'Сервис прайсов');
  assert.equal(kept.handover.files[0], 'Прайс.txt');
  client.handover = {sold: 'Автоматизация контента', kp: 'Старт', amount: 55000, due: '2026-12-15', contacts: 'mikhail@example.test', kpLink: '', files: []};
  D.ensureFromWon(state, client, sales.id);
  assert.equal(project.handover.sold, 'Автоматизация контента');
  assert.equal(project.pmId, '');
  assert.throws(() => D.moveProject(state, sales, project.id, 'dev-r2'));

  assert.throws(() => D.moveProject(state, user('anna'), project.id, 'dev-support'));
  D.moveProject(state, head, project.id, 'dev-r1');
  assert.equal(project.devStage, 'dev-r1');
  assert.equal(project.status, undefined);
  D.moveProject(state, head, project.id, 'dev-support');
  assert.equal(project.devStage, 'dev-support');
  assert.equal(project.devHistory.at(-1).by, 'devhead');

  project.members.push('anna', 'dev2');
  const annaTask = M.addTask(state, head, {projectId: project.id, title: 'Сверстать экран', due: '2026-12-01', start: '2026-11-18', estimate: 8, remaining: 8, type: 'work', assigneeId: 'anna'});
  const alexeyTask = M.addTask(state, head, {projectId: project.id, title: 'Подключить оплату', due: '2026-12-02', start: '2026-11-18', estimate: 8, remaining: 8, type: 'work', assigneeId: 'dev2'});
  const annaSees = M.visibleTasks(state, user('anna')).map(task => task.id);
  const alexeySees = M.visibleTasks(state, user('dev2')).map(task => task.id);
  assert.ok(annaSees.includes(annaTask.id));
  assert.ok(!annaSees.includes(alexeyTask.id));
  assert.ok(alexeySees.includes(alexeyTask.id));
  assert.ok(!alexeySees.includes(annaTask.id));
  assert.ok(M.visibleProjects(state, user('anna')).some(item => item.id === project.id));
  assert.ok(M.visibleTasks(state, head).some(task => task.id === annaTask.id));
  assert.ok(M.visibleTasks(state, head).some(task => task.id === alexeyTask.id));
  assert.ok(M.visibleTasks(state, user('admin')).some(task => task.id === alexeyTask.id));
});
