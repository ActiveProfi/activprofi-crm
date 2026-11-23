const net = require('node:net');
const tls = require('node:tls');

function mailSettings(env = process.env) {
  const host = String(env.SMTP_HOST || '').trim();
  const secure = String(env.SMTP_SECURE || '') === '1';
  return {
    configured: Boolean(host && String(env.SMTP_FROM || '').trim()),
    host,
    port: Number(env.SMTP_PORT || (secure ? 465 : 587)),
    secure,
    allowPlain: String(env.SMTP_SECURE || '') === '0',
    user: String(env.SMTP_USER || ''),
    pass: String(env.SMTP_PASS || ''),
    from: String(env.SMTP_FROM || '').trim(),
    fromName: String(env.SMTP_FROM_NAME || 'АктивПрофи').trim() || 'АктивПрофи',
  };
}

function mimeWord(value) {
  return '=?UTF-8?B?' + Buffer.from(String(value || ''), 'utf8').toString('base64') + '?=';
}

function wrapBase64(buffer) {
  return buffer.toString('base64').replace(/.{1,76}/g, '$&\r\n').replace(/\r\n$/, '');
}

function buildRaw({from, fromName, to, subject, text, attachments = []}) {
  const encodedText = wrapBase64(Buffer.from(String(text || ''), 'utf8'));
  const fromHeader = `${mimeWord(fromName)} <${from}>`;
  if (!attachments.length) {
    return [`From: ${fromHeader}`, `To: <${to}>`, `Subject: ${mimeWord(subject || 'Сообщение')}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', encodedText].join('\r\n');
  }
  const boundary = 'crm_' + Buffer.from(String(Date.now())).toString('hex');
  const parts = [
    `From: ${fromHeader}`, `To: <${to}>`, `Subject: ${mimeWord(subject || 'Сообщение')}`, 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', encodedText,
  ];
  for (const file of attachments) {
    const name = String(file.name || 'file').replace(/[\r\n"]/g, '_');
    parts.push(`--${boundary}`, `Content-Type: ${file.mime || 'application/octet-stream'}`, `Content-Disposition: attachment; filename="${name}"`, 'Content-Transfer-Encoding: base64', '', wrapBase64(file.bytes));
  }
  parts.push(`--${boundary}--`, '');
  return parts.join('\r\n');
}

function explainSmtp(error, reply) {
  const text = String(reply || error?.message || '');
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH/.test(text)) return 'Нет связи с почтовым сервером. Проверьте адрес и порт в настройках почты.';
  if (/^535\b/.test(text) || /authentication/i.test(text)) return 'Почта не приняла логин или пароль. Для Яндекса и Mail.ru нужен пароль приложения, не обычный пароль ящика.';
  if (/^550\b|^553\b|^554\b/.test(text)) return 'Почтовый сервер отклонил получателя или отправителя: ' + text.slice(0, 180);
  if (text) return 'Письмо не ушло: ' + text.slice(0, 180);
  return 'Письмо не ушло. Проверьте настройки почты.';
}

function createSmtp({settings, connect}) {
  function openSocket() {
    if (connect) return connect(settings);
    if (settings.secure) return tls.connect({host: settings.host, port: settings.port, servername: settings.host});
    return net.connect({host: settings.host, port: settings.port});
  }

  function send({to, subject, text, attachments}) {
    if (!settings.configured) {
      const error = new Error('Почта не подключена — обратитесь к администратору');
      error.code = 'MAIL_OFF';
      return Promise.reject(error);
    }
    const raw = buildRaw({from: settings.from, fromName: settings.fromName, to, subject, text, attachments});
    return new Promise((resolve, reject) => {
      let socket = openSocket();
      let buffer = '';
      const queue = [];
      let stage = 'banner';
      let upgraded = false;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error instanceof Error ? error : new Error(explainSmtp(error)));
      };
      const write = (line) => socket.write(line + '\r\n');
      const pump = () => {
        if (!queue.length || settled) return;
        const item = queue.shift();
        if (stage === 'banner') {
          stage = 'ehlo';
          write('EHLO activprofi');
        } else if (stage === 'ehlo') {
          const canTls = /STARTTLS/i.test(item.text);
          if (!settings.secure && canTls && !settings.allowPlain && !upgraded) {
            stage = 'starttls';
            write('STARTTLS');
            return;
          }
          if (settings.user) {
            stage = 'auth-user';
            write('AUTH LOGIN');
          } else {
            stage = 'mail';
            write(`MAIL FROM:<${settings.from}>`);
          }
        } else if (stage === 'starttls') {
          const plain = socket;
          const secureSocket = tls.connect({socket: plain, servername: settings.host});
          secureSocket.on('secureConnect', () => {
            upgraded = true;
            stage = 'ehlo';
            socket = secureSocket;
            buffer = '';
            bind(secureSocket);
            write('EHLO activprofi');
          });
          secureSocket.on('error', (error) => fail(new Error(explainSmtp(error))));
          return;
        } else if (stage === 'auth-user') {
          stage = 'auth-pass';
          write(Buffer.from(settings.user).toString('base64'));
        } else if (stage === 'auth-pass') {
          stage = 'auth-done';
          write(Buffer.from(settings.pass).toString('base64'));
        } else if (stage === 'auth-done') {
          stage = 'mail';
          write(`MAIL FROM:<${settings.from}>`);
        } else if (stage === 'mail') {
          stage = 'rcpt';
          write(`RCPT TO:<${to}>`);
        } else if (stage === 'rcpt') {
          stage = 'data';
          write('DATA');
        } else if (stage === 'data') {
          stage = 'body';
          const stuffed = raw.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
          socket.write(stuffed + '\r\n.\r\n');
        } else if (stage === 'body') {
          stage = 'quit';
          write('QUIT');
          settled = true;
          socket.end();
          resolve({to, subject});
        }
      };
      const reply = (lines) => {
        const last = lines[lines.length - 1] || '';
        const code = Number(last.slice(0, 3));
        if (code >= 400) return fail(new Error(explainSmtp(null, last)));
        queue.push({code, text: lines.join('\n')});
        pump();
      };
      const bind = (current) => {
        current.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          let index;
          const lines = [];
          while ((index = buffer.indexOf('\n')) >= 0) {
            lines.push(buffer.slice(0, index).replace(/\r$/, ''));
            buffer = buffer.slice(index + 1);
            if (/^\d{3} /.test(lines[lines.length - 1])) reply(lines.splice(0, lines.length));
          }
        });
      };
      socket.on('error', (error) => fail(new Error(explainSmtp(error))));
      bind(socket);
    });
  }

  return {settings, send};
}

module.exports = {mailSettings, createSmtp, buildRaw, explainSmtp};
