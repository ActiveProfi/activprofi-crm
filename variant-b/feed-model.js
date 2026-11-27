(function (root) {
  function textOf(value) {
    const raw = typeof value === 'string' ? value : (value?.text || '');
    return String(raw).replace(/\[\[[^\]]+\]\]/g, '').trim();
  }
  function whenOf(value, fallback) {
    const raw = typeof value === 'string' ? value : '';
    const dated = raw.match(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/);
    return dated ? dated[0] : (fallback || '');
  }
  function clientFeed(state, client) {
    if (!client) return [];
    const items = [];
    for (const note of client.notes || []) {
      items.push({kind: 'note', label: 'Заметка', at: whenOf(note), text: textOf(note), source: 'note'});
    }
    for (const talk of state.communications || []) {
      if (talk.entityType === 'client' && talk.entityId === client.id) {
        items.push({kind: 'call', label: 'Звонок', at: talk.createdAt || '', text: textOf(talk.title || talk.note || ''), id: talk.id, source: 'call'});
      }
    }
    const email = String(client.email || '').trim().toLowerCase();
    for (const mail of state.outbox || []) {
      if (email && String(mail.to || '').trim().toLowerCase() === email) {
        items.push({kind: 'mail', label: 'Письмо', at: mail.createdAt || mail.at || '', text: textOf(mail.subject || mail.body || ''), id: mail.id, source: 'mail'});
      }
    }
    for (const conversation of state.conversations || []) {
      if (conversation.clientId !== client.id) continue;
      const channel = conversation.channel === 'mail' || conversation.provider === 'mail' ? 'mail' : 'telegram';
      for (const message of state.externalMessages || []) {
        if (message.conversationId !== conversation.id || message.status === 'draft') continue;
        items.push({kind: channel, label: channel === 'mail' ? 'Письмо' : 'Telegram', at: message.at || '', text: textOf(message.text), id: message.id, source: 'message'});
      }
    }
    items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return items;
  }
  function projectFeed(state, projectId) {
    return (state.messages || []).filter(message => message.projectId === projectId).map(message => ({
      kind: 'team', label: 'Команда', at: message.at || '', text: textOf(message.text), id: message.id, from: message.from, to: message.to, source: 'team',
    })).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }
  const api = {clientFeed, projectFeed};
  if (typeof module !== 'undefined') module.exports = api;
  root.ClientFeed = api;
})(globalThis);
