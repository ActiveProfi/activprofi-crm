const {M, Access, Leads, Communications, Inbox, Delivery} = require('./models.cjs');
const {contactKeys, assertContactShape} = require('./contacts.cjs');
const {HttpError, domainError} = require('./errors.cjs');
const notify = require('./notify.cjs');
const store = require('./store.cjs');
const {hashPassword} = require('./passwords.cjs');

function same(a, b) {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter(key => !same(before?.[key], after?.[key]));
}

function indexById(list, label) {
  const map = new Map();
  for (const item of list || []) {
    if (!item || typeof item !== 'object' || !item.id || typeof item.id !== 'string' || item.id.length > 80) {
      throw new HttpError(400, 'Некорректный идентификатор: ' + label);
    }
    if (map.has(item.id)) throw new HttpError(400, 'Повторяется идентификатор: ' + label);
    map.set(item.id, item);
  }
  return map;
}

function runDomain(fn) {
  try { return fn(); }
  catch (error) { throw domainError(error); }
}

function ensureLostStage(pipeline) {
  if (!pipeline?.stages?.length) return false;
  if (pipeline.stages.some(stage => stage.kind === 'lost')) return false;
  pipeline.stages.push({id: 'lost-' + pipeline.id, name: 'Отказ', kind: 'lost'});
  return true;
}

function upgradeInPlace(state) {
  const before = JSON.stringify(state);
  Leads.upgrade(state);
  Communications.upgrade(state);
  Inbox.upgrade(state);
  Delivery.upgrade(state);
  for (const list of [state.clients, state.projects, state.tasks]) {
    for (const item of list || []) if (!Number.isFinite(Number(item?.recordRev))) item.recordRev = 1;
  }
  for (const pipeline of state.pipelines || []) ensureLostStage(pipeline);
  state.rolePermissions = state.rolePermissions || {};
  if (!state.pmRightsVersion) {
    state.rolePermissions.pm = {...(state.rolePermissions.pm || {}), 'projects.create': true, 'tasks.assign': true};
    state.pmRightsVersion = 1;
  }
  state.desk = state.desk || {dutyUserId: '', defaultLeaderId: '', defaultPmId: ''};
  M.tidyWorkspace(state);
  return JSON.stringify(state) !== before;
}

function present(state, user) {
  const view = structuredClone(state);
  upgradeInPlace(view);
  const projects = M.visibleProjects(view, user).map(project => {
    const copy = structuredClone(project);
    if (!M.has(view, user, 'finance.view')) delete copy.budget;
    const all = (view.tasks || []).filter(task => task.projectId === project.id);
    const done = all.filter(task => task.status === 'Готово').length;
    copy.completion = all.length ? Math.round(done / all.length * 100) : 0;
    const mine = all.filter(task => task.assigneeId === user.id);
    copy.myTasks = {done: mine.filter(task => task.status === 'Готово').length, total: mine.length};
    return copy;
  });
  const projectIds = new Set(projects.map(project => project.id));
  const clients = M.visibleClients(view, user).map(client => structuredClone(client));
  const clientIds = new Set(clients.map(client => client.id));
  const tasks = M.visibleTasks(view, user).map(task => structuredClone(task));
  const manageLeads = M.has(view, user, 'leads.manage');
  const batches = (view.leadBatches || []).filter(batch => manageLeads || clients.some(client => client.batchId === batch.id)).map(batch => {
    const copy = structuredClone(batch);
    if (M.onProbation(user)) {
      for (const key of ['funnelTotal', 'funnelSent', 'funnelLoads', 'skipped', 'lastDistribution']) delete copy[key];
    }
    return copy;
  });
  const communications = (view.communications || []).filter(item => {
    try { return Communications.allowed(view, user, item.entityType, item.entityId); }
    catch { return false; }
  }).map(item => structuredClone(item));
  const voice = M.has(view, user, 'voice.manage')
    ? (view.voiceCampaigns || []).filter(item => item.ownerId === user.id || user.role === 'admin' || user.role === 'rop').map(item => structuredClone(item))
    : [];
  const conversations = Inbox.visible(view, user).map(item => structuredClone(item));
  const conversationIds = new Set(conversations.map(item => item.id));
  const externalMessages = (view.externalMessages || []).filter(item => conversationIds.has(item.conversationId) && (item.status !== 'draft' || item.authorId === user.id)).map(item => structuredClone(item));
  return {
    schema: view.schema,
    leadsVersion: view.leadsVersion,
    manualFunnelVersion: view.manualFunnelVersion,
    coldStageVersion: view.coldStageVersion,
    googleClientId: view.googleClientId || '',
    users: (view.users || []).map(item => {
      const copy = structuredClone(item);
      delete copy.password;
      delete copy.password_hash;
      return copy;
    }),
    rolePermissions: structuredClone(view.rolePermissions || {}),
    permissionAudit: user.role === 'admin' ? structuredClone(view.permissionAudit || []) : [],
    pipelines: structuredClone(view.pipelines || []),
    projects,
    clients,
    tasks,
    materials: (view.materials || []).filter(item => projectIds.has(item.projectId)).map(item => structuredClone(item)),
    messages: (view.messages || []).filter(item => projectIds.has(item.projectId)).map(item => structuredClone(item)),
    outbox: (view.outbox || []).filter(item => projectIds.has(item.projectId)).map(item => structuredClone(item)),
    leadBatches: batches,
    communications,
    voiceCampaigns: voice,
    messengerChannels: structuredClone(view.messengerChannels || []),
    conversations,
    externalMessages,
    desk: structuredClone(view.desk || {dutyUserId: '', defaultLeaderId: '', defaultPmId: ''}),
    revision: view.revision,
  };
}

function workspacePayload(db, user) {
  const state = store.load(db);
  if (upgradeInPlace(state)) store.save(db, state);
  const actor = state.users.find(item => item.id === user.id) || user;
  const view = present(state, actor);
  view.revision = store.revision(db);
  return {revision: view.revision, user: store.publicUser(actor), state: view};
}

function pullSecrets(incoming) {
  const clone = structuredClone(incoming || {});
  const passwords = {};
  for (const user of clone.users || []) {
    if (user && user.password) passwords[user.id] = String(user.password);
    if (user) delete user.password;
  }
  return {clone, passwords, accepted: {}};
}

function applyUsers(state, actor, presented, incoming, secrets) {
  if (actor.role !== 'admin') secrets.passwords = {};
  const prev = indexById(presented.users, 'сотрудник');
  const next = indexById(incoming.users, 'сотрудник');
  const changes = [];
  for (const [id, user] of next) {
    const before = prev.get(id);
    if (!before) {
      if (state.users.some(item => item.id === id)) throw new HttpError(403, 'Нет доступа к сотруднику');
      changes.push({type: 'create', user});
      continue;
    }
    if (!same(before, user) || secrets.passwords[id]) changes.push({type: 'update', user, before});
  }
  const rolesChanged = !same(presented.rolePermissions || {}, incoming.rolePermissions || {});
  if (!changes.length && !rolesChanged) return;
  if (actor.role !== 'admin') throw new HttpError(403, 'Права изменяет только администратор');
  if (rolesChanged) {
    for (const [role, values] of Object.entries(incoming.rolePermissions || {})) {
      if (!same((state.rolePermissions || {})[role], values)) runDomain(() => Access.setRole(state, actor, role, values));
    }
  }
  for (const change of changes) {
    const input = {
      name: change.user.name,
      role: change.user.role,
      active: change.user.active !== false,
      permissionsUntil: change.user.permissionsUntil || '',
      assignmentCategory: change.user.assignmentCategory || '',
      permissionOverrides: change.user.permissionOverrides || {},
    };
    if (change.type === 'create') {
      const login = String(change.user.login || '').trim().toLowerCase();
      const password = secrets.passwords[change.user.id];
      if (!/^[a-z0-9._-]{3,32}$/.test(login)) throw new HttpError(400, 'Логин: 3–32 символа, латиница, цифры, точка, _ или -');
      if (!password || password.length < 8) throw new HttpError(400, 'Пароль нового сотрудника — не короче 8 символов');
      if (state.users.some(item => String(item.login || '').toLowerCase() === login)) throw new HttpError(409, 'Такой логин уже занят');
      state.users.push({id: change.user.id, name: change.user.name || login, role: change.user.role || 'sales', active: true, login});
      runDomain(() => Access.setUser(state, actor, change.user.id, input));
      const saved = state.users.find(item => item.id === change.user.id);
      saved.login = login;
      saved.mustChangePassword = true;
      saved.probation = saved.role !== 'admin' && (change.user.probation === true || (change.user.probation !== false && ['sales', 'sales_intern'].includes(saved.role)));
      secrets.accepted[change.user.id] = password;
    } else {
      const profileChanged = !same(change.before, change.user);
      if (profileChanged) runDomain(() => Access.setUser(state, actor, change.user.id, input));
      if (change.user.login) {
        const login = String(change.user.login).trim().toLowerCase();
        if (!/^[a-z0-9._-]{3,32}$/.test(login)) throw new HttpError(400, 'Проверьте логин');
        const current = state.users.find(item => item.id === change.user.id);
        const own = String(current?.login || '').trim().toLowerCase();
        const taken = state.users.some(item => item.id !== change.user.id && String(item.login || '').trim().toLowerCase() === login);
        if (taken) {
          // Форма настроек не меняет логин. Повтор чужого логина в карточке не должен блокировать роль и права.
          if (!own || own === login) throw new HttpError(409, 'Такой логин уже занят');
        } else if (current) current.login = login;
      }
      if (secrets.passwords[change.user.id]) {
        if (secrets.passwords[change.user.id].length < 8) throw new HttpError(400, 'Пароль — не короче 8 символов');
        secrets.accepted[change.user.id] = secrets.passwords[change.user.id];
        const savedUser = state.users.find(item => item.id === change.user.id);
        if (savedUser && change.user.id !== actor.id) savedUser.mustChangePassword = true;
      }
      if (Object.prototype.hasOwnProperty.call(change.user, 'probation')) {
        const savedUser = state.users.find(item => item.id === change.user.id);
        if (savedUser) savedUser.probation = savedUser.role !== 'admin' && change.user.probation === true;
      }
      if (Object.prototype.hasOwnProperty.call(change.user, 'telegram')) {
        const raw = String(change.user.telegram || '').trim().replace(/^@/, '');
        if (raw && !/^([A-Za-z][A-Za-z0-9_]{4,31}|\d{3,20})$/.test(raw)) throw new HttpError(400, 'Telegram: username от 5 символов или числовой id');
        const savedUser = state.users.find(item => item.id === change.user.id);
        if (savedUser) savedUser.telegram = raw;
      }
      if (Object.prototype.hasOwnProperty.call(change.user, 'sipuniExtension')) {
        const raw = String(change.user.sipuniExtension || '').trim();
        if (raw && !/^\d{2,8}$/.test(raw)) throw new HttpError(400, 'Внутренний номер Sipuni — от 2 до 8 цифр');
        const savedUser = state.users.find(item => item.id === change.user.id);
        if (savedUser) savedUser.sipuniExtension = raw;
      }
    }
  }
}

function applyPipelines(state, user, incoming) {
  if (same(state.pipelines, incoming)) return;
  if (!M.has(state, user, 'pipelines.manage')) throw new HttpError(403, 'Настройка воронок недоступна');
  if (!Array.isArray(incoming) || !incoming.length) throw new HttpError(400, 'Нужна хотя бы одна воронка');
  const ids = new Set();
  const stageIds = new Set();
  for (const pipeline of incoming) {
    if (!pipeline?.id || !String(pipeline.name || '').trim()) throw new HttpError(400, 'Проверьте название воронки');
    if (ids.has(pipeline.id)) throw new HttpError(400, 'Повторяется воронка');
    ids.add(pipeline.id);
    if (!Array.isArray(pipeline.stages) || !pipeline.stages.length) throw new HttpError(400, 'В воронке нужен хотя бы один этап');
    if (!pipeline.stages.some(stage => stage.kind === 'lost')) throw new HttpError(400, 'В воронке нужен этап отказа');
    const local = new Set();
    for (const stage of pipeline.stages) {
      if (!stage?.id || !String(stage.name || '').trim()) throw new HttpError(400, 'Проверьте этап');
      if (!['open', 'won', 'lost'].includes(stage.kind)) throw new HttpError(400, 'Некорректный тип этапа');
      if (local.has(stage.id)) throw new HttpError(400, 'Повторяется этап');
      local.add(stage.id);
      stageIds.add(stage.id);
    }
  }
  for (const client of state.clients) {
    if (client.pipelineId && !ids.has(client.pipelineId)) throw new HttpError(400, 'Нельзя удалить воронку, в которой есть клиенты');
    if (client.stageId && !stageIds.has(client.stageId)) throw new HttpError(400, 'Нельзя убрать этап, на котором есть клиенты');
  }
  state.pipelines = incoming;
}

const PROJECT_SHELL = ['title', 'client', 'type', 'status', 'progress', 'deadline', 'next', 'leaderId', 'pmId', 'members', 'start', 'due', 'budget', 'description'];

function applyProjects(state, user, presented, incoming) {
  const prev = indexById(presented.projects, 'проект');
  const next = indexById(incoming.projects, 'проект');
  for (const [id, project] of next) {
    const before = prev.get(id);
    if (!before) {
      if (state.projects.some(item => item.id === id)) throw new HttpError(403, 'Нет доступа к проекту');
      if (!M.has(state, user, 'projects.create')) throw new HttpError(403, 'Создание проектов недоступно');
      if (!String(project.title || '').trim() || !String(project.client || '').trim()) throw new HttpError(400, 'Заполните название и заказчика');
      if (project.start && project.due && project.start > project.due) throw new HttpError(400, 'Начало позже срока');
      const team = runDomain(() => M.normalizeProjectTeam(state.users, user, project, null));
      state.projects.push({
        ...project,
        id,
        leaderId: team.leaderId,
        pmId: team.pmId,
        members: team.members,
        devStage: Delivery.stageById(project.devStage) ? project.devStage : 'dev-start',
        budget: M.has(state, user, 'finance.view') ? Number(project.budget) || 0 : 0,
        recipients: project.recipients || [],
        board: project.board || {notes: [], links: [], comments: []},
        mockup: project.mockup || {name: '', data: ''},
      });
      continue;
    }
    if (same(before, project)) continue;
    const current = state.projects.find(item => item.id === id);
    if (!current || !M.canProject(state, user, id)) throw new HttpError(403, 'Нет доступа к проекту');
    const keys = changedKeys(before, project);
    const shell = keys.filter(key => PROJECT_SHELL.includes(key) && !(key === 'budget' && !M.has(state, user, 'finance.view')));
    if (shell.length && !M.canManage(state, user, id)) throw new HttpError(403, 'Настройки проекта меняет руководитель или админ');
    if (shell.some(key => key === 'members' || key === 'leaderId' || key === 'pmId')) {
      const team = runDomain(() => M.normalizeProjectTeam(state.users, user, project, before));
      project.leaderId = team.leaderId;
      project.pmId = team.pmId;
      project.members = team.members;
      for (const key of ['leaderId', 'pmId', 'members']) {
        if (!shell.includes(key) && !same(before[key], project[key])) shell.push(key);
      }
    }
    if (project.start && project.due && project.start > project.due) throw new HttpError(400, 'Начало позже срока');
    for (const key of [...shell, ...keys.filter(key => ['board', 'mockup', 'sheets', 'recipients'].includes(key))]) {
      if (key === 'budget' && !M.has(state, user, 'finance.view')) continue;
      current[key] = project[key];
    }
    if (keys.includes('devStage') && project.devStage !== current.devStage) {
      runDomain(() => Delivery.moveProject(state, user, id, project.devStage));
    }
  }
}

function clientIndex(clients) {
  const map = new Map();
  for (const client of clients) for (const key of contactKeys(client)) map.set(key.kind + '\0' + key.value, client.id);
  return map;
}

function rememberClient(index, client) {
  for (const key of contactKeys(client)) {
    const token = key.kind + '\0' + key.value;
    const owner = index.get(token);
    if (owner && owner !== client.id) throw new HttpError(409, 'Такой контакт уже есть в базе (телефон, email или профиль)');
    index.set(token, client.id);
  }
}

function forgetClient(index, client) {
  for (const key of contactKeys(client)) {
    const token = key.kind + '\0' + key.value;
    if (index.get(token) === client.id) index.delete(token);
  }
}

function applyClients(state, user, presented, incoming) {
  const prev = indexById(presented.clients, 'клиент');
  const next = indexById(incoming.clients, 'клиент');
  const index = clientIndex(state.clients);
  for (const [id, client] of next) {
    const before = prev.get(id);
    if (!before) {
      if (state.clients.some(item => item.id === id)) throw new HttpError(403, 'Нет доступа к клиенту');
      if (!M.has(state, user, 'clients.edit')) throw new HttpError(403, 'Добавление клиентов недоступно');
      const created = {...client, id, ownerId: M.has(state, user, 'leads.manage') && !M.onProbation(user) ? (client.ownerId || '') : user.id};
      if (!String(created.name || '').trim()) throw new HttpError(400, 'Заполните имя');
      if (created.amount != null && (!Number.isFinite(Number(created.amount)) || Number(created.amount) < 0)) throw new HttpError(400, 'Некорректная сумма');
      created.amount = Number(created.amount) || 0;
      if (created.project && !M.canProject(state, user, created.project)) throw new HttpError(403, 'Нет доступа к проекту');
      if (!created.inLeadBase) {
        const pipeline = state.pipelines.find(item => item.id === created.pipelineId);
        if (!pipeline?.stages.some(stage => stage.id === created.stageId)) throw new HttpError(400, 'Выберите этап воронки');
      }
      assertContactShape(created);
      rememberClient(index, created);
      state.clients.push(created);
      Delivery.ensureFromWon(state, created, user.id);
      continue;
    }
    if (same(before, client)) continue;
    const current = state.clients.find(item => item.id === id);
    if (!current || !M.canClient(state, user, current) || !M.has(state, user, 'clients.edit')) throw new HttpError(403, 'Нет доступа к клиенту');
    if ((client.ownerId || '') !== (current.ownerId || '') && (!M.has(state, user, 'leads.manage') || M.onProbation(user))) throw new HttpError(403, 'Назначать менеджера может руководитель отдела или админ');
    if (client.project && client.project !== current.project && !M.canProject(state, user, client.project)) throw new HttpError(403, 'Нет доступа к проекту');
    if (!client.inLeadBase && client.stageId) {
      const pipeline = state.pipelines.find(item => item.id === client.pipelineId);
      if (!pipeline?.stages.some(stage => stage.id === client.stageId)) throw new HttpError(400, 'Этап не найден');
    }
    if (!String(client.name || '').trim()) throw new HttpError(400, 'Заполните имя');
    const nextClient = {...client, id, amount: Number(client.amount) || 0};
    if (!M.has(state, user, 'leads.manage') || M.onProbation(user)) nextClient.ownerId = current.ownerId || '';
    assertContactShape(nextClient);
    forgetClient(index, current);
    rememberClient(index, nextClient);
    const previousProject = current.project;
    Object.assign(current, nextClient);
    if ((!current.project || !state.projects.some(item => item.id === current.project)) && previousProject && state.projects.some(item => item.id === previousProject)) {
      current.project = previousProject;
    }
    Delivery.ensureFromWon(state, current, user.id);
  }
}

function applyBatches(state, user, presented, incoming) {
  const prev = indexById(presented.leadBatches, 'база');
  const next = indexById(incoming.leadBatches, 'база');
  const can = M.has(state, user, 'leads.manage') && !M.onProbation(user);
  for (const [id, batch] of next) {
    const before = prev.get(id);
    if (!before) {
      if (state.leadBatches.some(item => item.id === id)) throw new HttpError(403, 'Нет доступа к базе лидов');
      if (!can) throw new HttpError(403, 'Импорт баз недоступен');
      state.leadBatches.push(batch);
      continue;
    }
    if (!same(before, batch)) {
      if (!can) throw new HttpError(403, 'Изменение базы лидов недоступно');
      const index = state.leadBatches.findIndex(item => item.id === id);
      if (index >= 0) state.leadBatches[index] = batch;
    }
  }
}

function applyTasks(state, user, presented, incoming) {
  const prev = indexById(presented.tasks, 'задача');
  const next = indexById(incoming.tasks, 'задача');
  for (const [id, task] of next) {
    const before = prev.get(id);
    if (!before) {
      if (state.tasks.some(item => item.id === id)) throw new HttpError(403, 'Нет доступа к задаче');
      const created = runDomain(() => {
        const copy = structuredClone(state);
        return M.addTask(copy, user, {...task, assigneeId: task.assigneeId || ''});
      });
      state.tasks.push({...created, id});
      continue;
    }
    if (same(before, task)) continue;
    const patch = {};
    for (const key of changedKeys(before, task)) patch[key] = task[key];
    const updated = runDomain(() => {
      const copy = structuredClone(state);
      return M.updateTask(copy, user, id, patch);
    });
    const index = state.tasks.findIndex(item => item.id === id);
    state.tasks[index] = updated;
  }
}

function applyProjectList(state, user, presented, incoming, name, onWrite) {
  const prev = indexById(presented[name], name);
  const next = indexById(incoming[name], name);
  const visible = new Set(M.visibleProjects(state, user).map(project => project.id));
  for (const [id, item] of next) {
    if (!visible.has(item.projectId)) throw new HttpError(403, 'Нет доступа к проекту');
    const before = prev.get(id);
    if (!before) {
      if (state[name].some(row => row.id === id)) throw new HttpError(403, 'Нет доступа');
      onWrite(item, null);
      state[name].push(item);
      continue;
    }
    if (!same(before, item)) onWrite(item, before);
    if (!same(before, item)) {
      const index = state[name].findIndex(row => row.id === id);
      state[name][index] = item;
    }
  }
}

function applyCommunications(state, user, presented, incoming) {
  const prev = indexById(presented.communications, 'коммуникация');
  const next = indexById(incoming.communications, 'коммуникация');
  for (const [id, item] of next) {
    const before = prev.get(id);
    if (!before) {
      if (state.communications.some(row => row.id === id)) throw new HttpError(403, 'Нет доступа к коммуникации');
      if (item.createdBy !== user.id) throw new HttpError(403, 'Нельзя сохранить чужую коммуникацию');
      if (!Communications.allowed(state, user, item.entityType, item.entityId)) throw new HttpError(403, 'Нет доступа к коммуникации');
      state.communications.push(item);
      continue;
    }
    if (!same(before, item)) {
      if (before.createdBy !== user.id && user.role !== 'admin') throw new HttpError(403, 'Нет доступа к коммуникации');
      const index = state.communications.findIndex(row => row.id === id);
      state.communications[index] = item;
    }
  }
}

function applyVoice(state, user, presented, incoming) {
  const prev = indexById(presented.voiceCampaigns, 'обзвон');
  const next = indexById(incoming.voiceCampaigns, 'обзвон');
  for (const [id, item] of next) {
    const before = prev.get(id);
    if (!M.has(state, user, 'voice.manage')) throw new HttpError(403, 'Обзвон недоступен');
    if (!before) {
      if (state.voiceCampaigns.some(row => row.id === id)) throw new HttpError(403, 'Нет доступа к кампании');
      if (item.ownerId !== user.id) throw new HttpError(403, 'Кампанию можно создать только от своего имени');
      state.voiceCampaigns.push(item);
      continue;
    }
    if (!same(before, item)) {
      if (before.ownerId !== user.id && !M.has(state, user, 'clients.all')) throw new HttpError(403, 'Нет доступа к кампании');
      const index = state.voiceCampaigns.findIndex(row => row.id === id);
      state.voiceCampaigns[index] = item;
    }
  }
}

function applyInbox(state, user, presented, incoming) {
  if (!same(presented.messengerChannels, incoming.messengerChannels)) {
    if (user.role !== 'admin') throw new HttpError(403, 'Каналы настраивает админ');
    state.messengerChannels = incoming.messengerChannels || [];
  }
  const prev = indexById(presented.conversations, 'переписка');
  const next = indexById(incoming.conversations, 'переписка');
  for (const [id, item] of next) {
    const before = prev.get(id);
    if (!before) {
      if (state.conversations.some(row => row.id === id)) throw new HttpError(403, 'Нет доступа к переписке');
      const client = state.clients.find(row => row.id === item.clientId);
      if (item.clientId && !Inbox.canClient(state, user, client)) throw new HttpError(403, 'Нет доступа к переписке клиента');
      if (!item.clientId && !M.has(state, user, 'inbox.unassigned')) throw new HttpError(403, 'Нет доступа к непривязанным диалогам');
      state.conversations.push(item);
      continue;
    }
    if (same(before, item)) continue;
    if (!Inbox.canRead(state, user, before)) throw new HttpError(403, 'Нет доступа к переписке');
    for (const key of changedKeys(before, item)) {
      if (key === 'readBy') continue;
      if (key === 'clientId') {
        if (!M.has(state, user, 'inbox.unassigned')) throw new HttpError(403, 'Нет прав на привязку диалога');
        const client = state.clients.find(row => row.id === item.clientId);
        if (!Inbox.canClient(state, user, client)) throw new HttpError(403, 'Нет прав на привязку диалога');
        continue;
      }
      throw new HttpError(403, 'Нельзя изменять это поле переписки');
    }
    const index = state.conversations.findIndex(row => row.id === id);
    state.conversations[index] = {...state.conversations[index], ...item, id};
  }
  const known = new Set(state.conversations.map(item => item.id));
  const prevMessages = indexById(presented.externalMessages, 'сообщение');
  const nextMessages = indexById(incoming.externalMessages, 'сообщение');
  for (const [id, item] of nextMessages) {
    if (!known.has(item.conversationId)) throw new HttpError(403, 'Нет доступа к переписке');
    const conversation = state.conversations.find(row => row.id === item.conversationId);
    if (!Inbox.canRead(state, user, conversation)) throw new HttpError(403, 'Нет доступа к переписке');
    const before = prevMessages.get(id);
    if (!before) {
      if (state.externalMessages.some(row => row.id === id)) throw new HttpError(403, 'Нет доступа к сообщению');
      const ownDraft = item.direction === 'outbound' && item.status === 'draft' && item.authorId === user.id && M.has(state, user, 'inbox.reply');
      const demo = item.direction === 'inbound' && item.status === 'demo' && conversation.demo;
      if (!ownDraft && !demo) throw new HttpError(403, 'Нельзя добавить это сообщение');
      if (String(item.text || '').length > 4096) throw new HttpError(400, 'Сообщение длиннее 4096 символов');
      state.externalMessages.push(item);
      continue;
    }
    if (!same(before, item)) throw new HttpError(403, 'Сообщения мессенджера не редактируются из CRM');
  }
}

function applyGoogle(state, user, incoming) {
  const next = incoming || '';
  if ((state.googleClientId || '') === next) return;
  const can = user.role === 'admin' || state.projects.some(project => M.canManage(state, user, project.id));
  if (!can) throw new HttpError(403, 'Подключение таблицы настраивает руководитель проекта или админ');
  state.googleClientId = String(next).slice(0, 200);
}

function saveRecords(db, user, items) {
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'Нет изменений для сохранения');
  let events = [];
  const result = db.transaction(() => {
    const state = store.load(db);
    upgradeInPlace(state);
    const before = structuredClone(state);
    const actor = state.users.find(item => item.id === user.id);
    if (!actor) throw new HttpError(401, 'Пользователь не найден');
    const names = {client: 'clients', project: 'projects', task: 'tasks'};
    const fresh = new Set();
    const presented = present(state, actor);
    const incoming = structuredClone(presented);
    for (const change of items) {
      const listName = names[change?.kind];
      if (!listName || !change.id) throw new HttpError(400, 'Некорректная запись');
      const server = (state[listName] || []).find(item => item.id === change.id);
      const rev = Number(change.rev) || 0;
      if (server && rev !== (Number(server.recordRev) || 1)) {
        throw new HttpError(409, 'Эту карточку уже изменили. Текст в форме сохранён — откройте карточку заново и перенесите правки.');
      }
      if (!server) fresh.add(change.id);
      const copy = structuredClone(change.data || {});
      copy.id = change.id;
      copy.recordRev = server ? (Number(server.recordRev) || 1) : 1;
      const index = incoming[listName].findIndex(item => item.id === change.id);
      if (index >= 0) incoming[listName][index] = copy;
      else incoming[listName].push(copy);
    }
    applyProjects(state, actor, presented, incoming);
    applyClients(state, actor, presented, incoming);
    applyTasks(state, actor, presented, incoming);
    for (const change of items) {
      const row = (state[names[change.kind]] || []).find(item => item.id === change.id);
      if (row) row.recordRev = fresh.has(change.id) ? 1 : (Number(row.recordRev) || 1) + 1;
    }
    events = notify.publish(db, before, state, actor.id);
    store.save(db, state);
    const next = store.bump(db);
    const view = present(state, actor);
    view.revision = next;
    return {revision: next, user: store.publicUser(actor), state: view};
  });
  notify.deliver(db, events);
  return result;
}

function mergeWorkspace(db, user, revision, incoming) {
  let events = [];
  const result = db.transaction(() => {
    const current = store.revision(db);
    if (Number(revision) !== current) throw new HttpError(409, 'Данные изменились на сервере. Обновите страницу и повторите действие.');
    const state = store.load(db);
    const actor = state.users.find(item => item.id === user.id);
    if (!actor) throw new HttpError(401, 'Пользователь не найден');
    let dirty = upgradeInPlace(state);
    const secrets = pullSecrets(incoming);
    const clean = secrets.clone;
    const presented = present(state, actor);
    presented.revision = current;
    applyUsers(state, actor, presented, clean, secrets);
    applyPipelines(state, actor, clean.pipelines);
    applyProjects(state, actor, presented, clean);
    applyClients(state, actor, presented, clean);
    applyBatches(state, actor, presented, clean);
    applyTasks(state, actor, presented, clean);
    applyProjectList(state, actor, presented, clean, 'materials', (item, before) => {
      if (before && before.projectId !== item.projectId) throw new HttpError(403, 'Нельзя перенести материал в другой проект');
      item.createdBy = before?.createdBy || actor.id;
    });
    applyProjectList(state, actor, presented, clean, 'messages', (item, before) => {
      if (before) throw new HttpError(403, 'Сообщения обсуждения не редактируются');
      if (item.from !== actor.id) throw new HttpError(403, 'Нельзя отправить сообщение от другого пользователя');
      if (!String(item.text || '').trim() || String(item.text).length > 4000) throw new HttpError(400, 'Введите сообщение до 4000 символов');
    });
    applyProjectList(state, actor, presented, clean, 'outbox', (item, before) => {
      if (before) throw new HttpError(403, 'Подготовленное письмо не редактируется');
      item.createdBy = actor.id;
    });
    applyCommunications(state, actor, presented, clean);
    applyVoice(state, actor, presented, clean);
    applyInbox(state, actor, presented, clean);
    applyGoogle(state, actor, clean.googleClientId);
    if (clean.desk && !same(state.desk, clean.desk)) {
      if (actor.role !== 'admin') throw new HttpError(403, 'Назначения по умолчанию меняет администратор');
      const rate = Math.round(Number(clean.desk.hourRate) || 0);
      state.desk = {
        dutyUserId: String(clean.desk.dutyUserId || ''),
        defaultLeaderId: String(clean.desk.defaultLeaderId || ''),
        defaultPmId: String(clean.desk.defaultPmId || ''),
        hourRate: rate > 0 ? rate : 0,
      };
    }
    const passwords = {};
    for (const [id, password] of Object.entries(secrets.accepted)) passwords[id] = hashPassword(password);
    const changed = dirty || !same(present(storeSnapshot(state), actor), presented) || Object.keys(passwords).length > 0;
    // Сравнение через повторное чтение не нужно: сохраняем, если секреты или JSON состояния изменились.
    const changedState = JSON.stringify(stable(stripVolatile(state))) !== JSON.stringify(stable(stripVolatile(store.load(db))));
    if (changedState || Object.keys(passwords).length || dirty) {
      const before = store.load(db);
      events = notify.publish(db, before, state, actor.id);
      store.save(db, state, {passwords, dropSessionsFor: Object.keys(passwords), keepSession: user.sessionHash, keepUserId: actor.id});
      const next = store.bump(db);
      const view = present(state, actor);
      view.revision = next;
      return {revision: next, user: store.publicUser(actor), state: view};
    }
    return {revision: current, user: store.publicUser(actor), state: presented};
  });
  notify.deliver(db, events);
  return result;
}

function stripVolatile(state) {
  const copy = structuredClone(state);
  delete copy.revision;
  return copy;
}

function storeSnapshot(state) {
  return state;
}

module.exports = {present, workspacePayload, mergeWorkspace, saveRecords, same, upgradeInPlace, ensureLostStage};
