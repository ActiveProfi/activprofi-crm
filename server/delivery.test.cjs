const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {start} = require('./app.cjs');

async function listen() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-delivery-'));
  const app = await start({
    host: '127.0.0.1',
    port: 0,
    databasePath: path.join(dir, 'crm.sqlite'),
    seedDemo: true,
    seedPassword: 'demo-pass-1',
    adminLogin: 'admin',
    adminPassword: 'admin-pass-1',
    adminName: 'Ксения',
    sessionDays: 2,
    cookieSecure: false,
  });
  return {app, dir};
}

function request(port, method, pathname, {body, cookie, headers} = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        ...(data ? {'Content-Type': 'application/json', 'Content-Length': data.length} : {}),
        ...(cookie ? {Cookie: cookie} : {}),
        ...headers,
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json;
        try { json = JSON.parse(buf.toString('utf8')); } catch { json = undefined; }
        resolve({status: res.statusCode, headers: res.headers, json});
      });
    });
    req.on('error', reject);
    req.end(data || undefined);
  });
}

function cookieOf(response) {
  return (response.headers['set-cookie']?.[0] || '').split(';')[0];
}

async function login(port, loginName, password) {
  const response = await request(port, 'POST', '/api/auth/login', {
    body: {login: loginName, password},
    headers: {'X-Requested-With': 'ActivProfi'},
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return cookieOf(response);
}

const browser = {'X-Requested-With': 'ActivProfi'};

test('admin hands a lead to one manager; the other manager cannot see or take it', async () => {
  const {app, dir} = await listen();
  try {
    const admin = await login(app.port, 'admin', 'admin-pass-1');
    const created = await request(app.port, 'POST', '/api/clients', {
      cookie: admin,
      headers: browser,
      body: {
        name: 'Марина Лидова',
        company: 'Студия Север',
        phone: '+7 999 555-00-77',
        email: 'marina-lead@example.test',
        source: 'Вручную',
        amount: 80000,
        pipelineId: 'inbound',
        stageId: 'stage-0',
        ownerId: 'sales',
        notes: ['Ксения · 2026-11-18: первый контакт'],
        inLeadBase: false,
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const lead = created.json.state.clients.find(client => client.email === 'marina-lead@example.test');
    assert.equal(lead.ownerId, 'sales');
    assert.match(lead.notes[0], /первый контакт/);

    const elena = await login(app.port, 'elena', 'demo-pass-1');
    const own = await request(app.port, 'GET', '/api/clients/' + lead.id, {cookie: elena});
    assert.equal(own.status, 200);
    assert.equal(own.json.client.name, 'Марина Лидова');
    const commented = await request(app.port, 'PATCH', '/api/clients/' + lead.id, {
      cookie: elena,
      headers: browser,
      body: {notes: ['Елена · 2026-11-18: договорились о созвоне', ...own.json.client.notes]},
    });
    assert.equal(commented.status, 200, JSON.stringify(commented.json));
    const after = await request(app.port, 'GET', '/api/clients/' + lead.id, {cookie: admin});
    assert.match(after.json.client.notes[0], /договорились о созвоне/);

    const oleg = await login(app.port, 'oleg', 'demo-pass-1');
    const hidden = await request(app.port, 'GET', '/api/clients/' + lead.id, {cookie: oleg});
    assert.equal(hidden.status, 404);
    const list = await request(app.port, 'GET', '/api/clients', {cookie: oleg});
    assert.ok(list.json.clients.every(client => client.id !== lead.id));
    const stolen = await request(app.port, 'PATCH', '/api/clients/' + lead.id, {
      cookie: elena,
      headers: browser,
      body: {ownerId: 'sales2'},
    });
    assert.equal(stolen.status, 403);
    const still = await request(app.port, 'GET', '/api/clients/' + lead.id, {cookie: oleg});
    assert.equal(still.status, 404);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('won deal becomes a project; developers see only their tasks, leads stay private', async () => {
  const {app, dir} = await listen();
  try {
    const admin = await login(app.port, 'admin', 'admin-pass-1');
    const elena = await login(app.port, 'elena', 'demo-pass-1');
    const created = await request(app.port, 'POST', '/api/clients', {
      cookie: admin,
      headers: browser,
      body: {
        name: 'Игорь Победов',
        company: 'Северная верфь',
        phone: '+7 999 555-00-88',
        email: 'igor-won@example.test',
        source: 'Вручную',
        amount: 240000,
        pipelineId: 'inbound',
        stageId: 'stage-0',
        ownerId: 'sales',
        notes: [],
        inLeadBase: false,
      },
    });
    const lead = created.json.state.clients.find(client => client.email === 'igor-won@example.test');
    const won = await request(app.port, 'PATCH', '/api/clients/' + lead.id, {
      cookie: elena,
      headers: browser,
      body: {stageId: 'stage-4', inLeadBase: false, stage: 'В проекте', stageHistory: [...(lead.stageHistory || []), {at: '2026-11-18', stageId: 'stage-4'}]},
    });
    assert.equal(won.status, 200, JSON.stringify(won.json));
    const project = won.json.state.projects.find(item => item.sourceClientId === lead.id);
    assert.ok(project, 'выигранная сделка должна создать проект');
    assert.equal(project.devStage, 'dev-start');
    assert.equal(won.json.state.clients.find(client => client.id === lead.id).project, project.id);

    const anna = await login(app.port, 'anna', 'demo-pass-1');
    const alexey = await login(app.port, 'alexey', 'demo-pass-1');
    const beforeAnna = await request(app.port, 'GET', '/api/projects/' + project.id, {cookie: anna});
    assert.equal(beforeAnna.status, 404);
    const pavel = await login(app.port, 'pavel', 'demo-pass-1');
    const dmitry = await login(app.port, 'dmitry', 'demo-pass-1');
    assert.equal((await request(app.port, 'GET', '/api/projects/' + project.id, {cookie: pavel})).status, 200);
    assert.equal((await request(app.port, 'GET', '/api/projects/' + project.id, {cookie: dmitry})).status, 200);
    assert.equal((await request(app.port, 'GET', '/api/projects/' + project.id, {cookie: admin})).json.project.devStage, 'dev-start');

    const joined = await request(app.port, 'PATCH', '/api/projects/' + project.id, {
      cookie: pavel,
      headers: browser,
      body: {members: [...new Set([...(project.members || []), 'anna', 'dev2'])]},
    });
    assert.equal(joined.status, 200, JSON.stringify(joined.json));
    const annaTask = await request(app.port, 'POST', '/api/tasks', {
      cookie: pavel,
      headers: browser,
      body: {projectId: project.id, title: 'Сверстать экран', assigneeId: 'anna', due: '2026-12-01', start: '2026-11-18', estimate: 8, remaining: 8, type: 'work', status: 'В очереди'},
    });
    assert.equal(annaTask.status, 201, JSON.stringify(annaTask.json));
    const alexeyTask = await request(app.port, 'POST', '/api/tasks', {
      cookie: pavel,
      headers: browser,
      body: {projectId: project.id, title: 'Подключить оплату', assigneeId: 'dev2', due: '2026-12-02', start: '2026-11-18', estimate: 8, remaining: 8, type: 'work', status: 'В очереди'},
    });
    assert.equal(alexeyTask.status, 201, JSON.stringify(alexeyTask.json));
    const annaId = annaTask.json.state.tasks.find(task => task.title === 'Сверстать экран').id;
    const alexeyId = alexeyTask.json.state.tasks.find(task => task.title === 'Подключить оплату').id;

    const annaTasks = await request(app.port, 'GET', '/api/tasks', {cookie: anna});
    assert.ok(annaTasks.json.tasks.some(task => task.id === annaId));
    assert.ok(annaTasks.json.tasks.every(task => task.assigneeId === 'anna'));
    assert.equal((await request(app.port, 'GET', '/api/tasks/' + alexeyId, {cookie: anna})).status, 404);
    const annaProject = await request(app.port, 'GET', '/api/projects/' + project.id, {cookie: anna});
    assert.equal(annaProject.status, 200);
    assert.equal(annaProject.json.project.devStage, 'dev-start');

    const alexeyTasks = await request(app.port, 'GET', '/api/tasks', {cookie: alexey});
    assert.ok(alexeyTasks.json.tasks.some(task => task.id === alexeyId));
    assert.ok(alexeyTasks.json.tasks.every(task => task.assigneeId === 'dev2'));
    assert.equal((await request(app.port, 'GET', '/api/tasks/' + annaId, {cookie: alexey})).status, 404);

    for (const cookie of [pavel, admin]) {
      const tasks = await request(app.port, 'GET', '/api/tasks', {cookie});
      assert.ok(tasks.json.tasks.some(task => task.id === annaId));
      assert.ok(tasks.json.tasks.some(task => task.id === alexeyId));
    }
    const pmTasks = await request(app.port, 'GET', '/api/tasks', {cookie: dmitry});
    assert.equal(pmTasks.json.tasks.some(task => task.id === annaId), false);

    const blocked = await request(app.port, 'PATCH', '/api/projects/' + project.id, {
      cookie: anna,
      headers: browser,
      body: {devStage: 'dev-support'},
    });
    assert.equal(blocked.status, 403);
    for (const stageId of ['dev-r1', 'dev-r2', 'dev-r3', 'dev-rework', 'dev-rollout', 'dev-training', 'dev-support']) {
      const moved = await request(app.port, 'PATCH', '/api/projects/' + project.id, {
        cookie: pavel,
        headers: browser,
        body: {devStage: stageId},
      });
      assert.equal(moved.status, 200, stageId + ' ' + JSON.stringify(moved.json));
      assert.equal(moved.json.state.projects.find(item => item.id === project.id).devStage, stageId);
    }
    const finished = await request(app.port, 'GET', '/api/projects/' + project.id, {cookie: admin});
    assert.equal(finished.json.project.devStage, 'dev-support');
    assert.equal(finished.json.project.status, undefined);
    const devColumn = await request(app.port, 'GET', '/api/projects/' + project.id, {cookie: anna});
    assert.equal(devColumn.json.project.devStage, 'dev-support');
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
