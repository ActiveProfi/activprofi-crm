(function(root){
function addDays(day, count){
  const date = new Date(String(day) + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}
function contactQueue(items, today){
  const week = addDays(today, 7);
  const rows = [];
  for (const item of items || []) {
    if (item.inLeadBase || item.kind === 'lost') continue;
    const when = String(item.when || '');
    const day = when.slice(0, 10);
    if (when && day < today) rows.push({...item, tone: 'overdue', label: 'Просрочено'});
    else if (day === today) rows.push({...item, tone: 'today', label: 'Сегодня'});
    else if (when && day <= week && item.kind !== 'won') rows.push({...item, tone: 'soon', label: 'На неделе'});
    else if ((!item.next || !when) && item.kind === 'open') rows.push({...item, tone: 'empty', label: 'Нет следующего шага'});
  }
  const order = {overdue: 0, today: 1, soon: 2, empty: 3};
  rows.sort((a, b) => order[a.tone] - order[b.tone] || String(a.when).localeCompare(String(b.when)) || String(a.name).localeCompare(String(b.name), 'ru'));
  return rows;
}
const api = {contactQueue, addDays};
if (typeof module !== 'undefined') module.exports = api;
root.ManagerGuide = api;
})(globalThis);
