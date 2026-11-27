function shownProgress(id) {
  const project = M.project(state, id);
  if (project && Number.isFinite(project.completion)) return project.completion;
  return M.progress(state, u(), id);
}

function taskShare(id) {
  const project = M.project(state, id);
  const share = project?.myTasks || M.ownTaskShare(state, u(), id);
  return share.total ? ' · ваши задачи ' + share.done + ' из ' + share.total : '';
}

function hoursReport() {
  const tasks = typeof vt === 'function' ? vt() : [];
  const rate = M.has(state, u(), 'finance.view') ? (Number(state.desk?.hourRate) || 0) : 0;
  const bags = new Map();
  for (const task of tasks) {
    for (const entry of task.timeEntries || []) {
      const key = (entry.by || '') + '|' + task.projectId;
      const bag = bags.get(key) || {userId: entry.by, projectId: task.projectId, hours: 0};
      bag.hours += Number(entry.hours) || 0;
      bags.set(key, bag);
    }
  }
  const rows = [...bags.values()];
  if (!rows.length) return '<section class="panel report-section" id="hours-report"><div class="panel-head"><h2>Часы по людям и проектам</h2></div><p class="hint">Пока никто не записал время. В задаче есть кнопка «Записать время».</p></section>';
  const body = rows.map(row => {
    const cost = rate ? money(Math.round(row.hours * rate)) : 'ставка не задана';
    return [name(row.userId), M.project(state, row.projectId)?.title || 'Проект', String(Math.round(row.hours * 100) / 100), cost];
  });
  return `<section class="panel report-section" id="hours-report"><div class="panel-head"><h2>Часы по людям и проектам</h2></div>${dataTable(['Кто', 'Проект', 'Часы', 'Стоимость'], body)}<p class="report-note">${rate ? 'Стоимость = часы × ставка ' + money(rate) + ' из «Назначений».' : 'Ставку часа задаёт администратор в «Назначениях». Без неё виден только объём часов.'}</p></section>`;
}

function projectHoursLine(project) {
  const tasks = (state.tasks || []).filter(task => task.projectId === project.id);
  const hours = tasks.reduce((sum, task) => sum + M.loggedHours(task), 0);
  const estimate = tasks.reduce((sum, task) => sum + (Number(task.estimate) || 0), 0);
  const rate = Number(state.desk?.hourRate) || 0;
  const cost = M.has(state, u(), 'finance.view') ? (rate ? money(Math.round(hours * rate)) : 'ставка не задана') : '';
  const paid = M.projectPaid(state, project.id);
  const moneyLine = M.has(state, u(), 'finance.view') ? `<p><span>Оплачено из бюджета</span><strong>${money(paid)} из ${money(project.budget || 0)}</strong></p><p><span>Стоимость часов</span><strong>${cost}</strong></p>` : '';
  return `<p><span>Часы</span><strong>${hours} из оценки ${estimate}</strong></p>${moneyLine}`;
}

async function logTime(id) {
  const task = (state.tasks || []).find(item => item.id === id);
  if (!task || !M.canTask(state, u(), task)) throw Error('Нет доступа к задаче');
  const logged = M.loggedHours(task);
  modal('Записать время', `<p>Оценка ${esc(String(task.estimate || 0))} ч. Уже записано ${esc(String(logged))} ч.</p>${field('Часы', 'hours', '1', 'number', true)}${field('Дата', 'date', M.today(), 'date', true)}${area('Комментарий', 'comment', '')}`, 'Записать', async fd => {
    const response = await fetch('/api/tasks/time', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Requested-With': 'ActivProfi'},
      body: JSON.stringify({taskId: id, hours: fd.get('hours'), date: fd.get('date'), comment: fd.get('comment')}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || 'Не удалось записать время');
    if (data.state) adoptWorkspace(data);
    toast('Время записано: ' + (Number(fd.get('hours')) || 0) + ' ч');
  });
}
