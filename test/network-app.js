// Loaded by network.html: buttons that make requests for Choro's network tools.
const log = (line) => (document.getElementById('log').textContent += line + '\n');
const on = (id, fn) => document.getElementById(id).addEventListener('click', fn);

on('get', async () => log('GET → ' + JSON.stringify(await (await fetch('/api/echo?who=choro&n=1')).json())));
on('post', async () => {
  const r = await fetch('/api/echo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ city: 'Sofia', note: 'Тест 🎉' }) });
  log('POST → ' + (await r.text()));
});
on('form-post', () => {
  const x = new XMLHttpRequest();
  x.open('POST', '/api/echo');
  x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
  x.onload = () => log('XHR → ' + x.responseText);
  x.send('name=Ana&lang=bg');
});
on('login', () => {
  const x = new XMLHttpRequest();
  x.open('POST', '/api/login');
  x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
  x.onload = () => log('login → ' + x.status);
  x.send('user=ana&password=hunter2');
});
on('fail', async () => log('500 → ' + (await fetch('/api/fail?code=500')).status));
on('missing', async () => log('404 → ' + (await fetch('/no-such-file.json')).status));
on('offline', () => fetch('http://127.0.0.1:9/unreachable').catch((e) => log('unreachable → ' + e.message)));
on('secret', async () => log('auth → ' + (await fetch('/api/echo?private=1', { headers: { Authorization: 'Bearer super-secret-token' } })).status));
on('ws', () => {
  const ws = new WebSocket(location.origin.replace('http', 'ws') + '/ws');
  ws.onopen = () => ws.send('hello from the page');
  ws.onmessage = (e) => { log('WS ← ' + e.data); ws.close(); };
});
on('burst', () => { for (let i = 0; i < 10; i++) fetch('/api/echo?burst=' + i); });
