// Proxy local : évite les blocages CORS vers Jira et l'API Claude.
// Les clés ne sont ni stockées ni journalisées ici : elles arrivent dans les en-têtes
// de chaque requête depuis le navigateur de l'utilisateur (page Paramètres).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = process.env.PORT || 8787;
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

const readBody = (req) => new Promise((res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => res(Buffer.concat(c))); });
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

async function jira(req, res, rest) {
  const base = String(req.headers['x-jira-url'] || '').replace(/\/+$/, '');
  const email = req.headers['x-jira-email'];
  const token = req.headers['x-jira-token'];
  if (!/^https:\/\/[a-z0-9-]+\.atlassian\.net$/i.test(base)) return send(res, 400, { error: 'URL Jira invalide (https://xxx.atlassian.net)' });
  if (!email || !token) return send(res, 400, { error: 'Email ou token Jira manquant (Paramètres)' });
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
  const r = await fetch(base + rest, {
    method: req.method,
    headers: {
      authorization: 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64'),
      accept: req.headers.accept || 'application/json',
      ...(body?.length ? { 'content-type': 'application/json' } : {}),
    },
    body: body?.length ? body : undefined,
  });
  res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
  res.end(Buffer.from(await r.arrayBuffer()));
}

async function claude(req, res) {
  const key = req.headers['x-claude-key'];
  if (!key) return send(res, 400, { error: 'Clé API Claude manquante (Paramètres)' });
  const body = await readBody(req);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body,
  });
  res.writeHead(r.status, { 'content-type': 'application/json' });
  res.end(Buffer.from(await r.arrayBuffer()));
}

/* ---------- ChatGPT (OpenAI) et Gemini (Google) : proxy minimal, clé fournie par chaque utilisateur ---------- */
const AI_PROVIDERS = {
  openai: {
    base: 'https://api.openai.com',
    header: 'x-openai-key',
    allowed: /^\/v1\/(chat\/completions|models)(\?.*)?$/,
    auth: (k) => ({ authorization: `Bearer ${k}` }),
  },
  gemini: {
    base: 'https://generativelanguage.googleapis.com',
    header: 'x-gemini-key',
    allowed: /^\/v1beta\/models(\/[\w.\-]+:generateContent)?(\?.*)?$/,
    auth: (k) => ({ 'x-goog-api-key': k }),
  },
};

async function aiProxy(req, res, provider, rest) {
  const cfg = AI_PROVIDERS[provider];
  const key = req.headers[cfg.header];
  if (!key) return send(res, 400, { error: `Clé API ${provider === 'openai' ? 'OpenAI' : 'Gemini'} manquante (Paramètres)` });
  if (!cfg.allowed.test(rest)) return send(res, 403, { error: 'Chemin non autorisé' });
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
  const r = await fetch(cfg.base + rest, {
    method: req.method,
    headers: { ...cfg.auth(key), 'content-type': 'application/json' },
    body: body?.length ? body : undefined,
  });
  res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
  res.end(Buffer.from(await r.arrayBuffer()));
}

/* ---------- Claude Code (CLI local, connecté au compte de l'utilisateur) ---------- */
const here = path.dirname(fileURLToPath(import.meta.url));

function claudeBin() {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
    return out.split(/\r?\n/).find(Boolean) || null;
  } catch { return null; }
}

const run = (bin, args, input, timeout = 180000, cwd = undefined) => new Promise((resolve) => {
  const viaShell = /\.(cmd|bat)$/i.test(bin);
  const p = spawn(viaShell ? `"${bin}"` : bin, viaShell ? args.map((a) => `"${a}"`) : args, { shell: viaShell, windowsHide: true, cwd });
  let out = '', err = '';
  const t = setTimeout(() => p.kill(), timeout);
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (err += d));
  p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: String(e.message) }); });
  p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  if (input) p.stdin.end(input); else p.stdin.end();
});

async function claudeCodeStatus(res) {
  const bin = claudeBin();
  if (!bin) return send(res, 200, { installed: false });
  const v = await run(bin, ['--version'], null, 15000);
  const a = await run(bin, ['auth', 'status', '--json'], null, 15000);
  let auth = {};
  try { auth = JSON.parse(a.out); } catch { /* sortie non JSON */ }
  send(res, 200, { installed: true, version: v.out.trim(), loggedIn: !!auth.loggedIn, method: auth.authMethod, email: auth.email });
}

async function claudeCodeChat(req, res) {
  const bin = claudeBin();
  if (!bin) return send(res, 400, { error: "Claude Code n'est pas installé sur cette machine." });
  const { prompt, sessionId, allowWrite: wantWrite, model, context, mode } = JSON.parse((await readBody(req)).toString() || '{}');
  if (!prompt) return send(res, 400, { error: 'Message vide' });
  const custom = mode === 'jql' || mode === 'custom';
  const allowWrite = custom ? false : !!wantWrite;
  const base = String(req.headers['x-jira-url'] || '');
  if (!/^https:\/\/[a-z0-9-]+\.atlassian\.net\/?$/i.test(base)) return send(res, 400, { error: 'URL Jira invalide (Paramètres)' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-modern-'));
  try {
    const mcp = path.join(dir, 'mcp.json');
    const sys = path.join(dir, 'system.txt');
    fs.writeFileSync(mcp, JSON.stringify({
      mcpServers: {
        jira: {
          command: process.execPath,
          args: ['--use-system-ca', path.join(here, 'jira-mcp.js')],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            JIRA_URL: base,
            JIRA_EMAIL: String(req.headers['x-jira-email'] || ''),
            JIRA_TOKEN: String(req.headers['x-jira-token'] || ''),
            ALLOW_WRITE: allowWrite ? '1' : '0',
            DEFAULT_FILTER: String(req.headers['x-cds-filter'] || ''),
            DOC_ROOT: String(req.headers['x-doc-root'] || ''),
            DOC_SPACE: String(req.headers['x-doc-space'] || ''),
          },
        },
      },
    }));
    fs.writeFileSync(sys, custom ? String(context || '') : [
      "Tu es l'assistant IA de l'équipe CDS Team-IT, intégré à une interface Jira Service Management.",
      'Réponds en français, de façon concise. Consulte Jira avec les outils plutôt que d\'inventer.',
      allowWrite ? 'Tu peux commenter et changer le statut des tickets, uniquement sur demande explicite.' : 'Tu es en lecture seule : tu ne peux pas modifier Jira.',
      context ? `Contexte courant : ${context}` : '',
    ].join('\n'));

    const tools = ['mcp__jira__search_issues', 'mcp__jira__count_issues', 'mcp__jira__get_issue', 'mcp__jira__find_user', 'mcp__jira__confluence_search', 'mcp__jira__confluence_spaces', 'mcp__jira__confluence_get_page', 'mcp__jira__confluence_children'];
    if (allowWrite) tools.push('mcp__jira__add_comment', 'mcp__jira__transition_issue');
    const args = [
      '-p', '--output-format', 'json',
      '--mcp-config', mcp, '--strict-mcp-config',
      '--tools', '', '--allowedTools', tools.join(','),
      '--append-system-prompt-file', sys,
    ];
    if (model) args.push('--model', model);
    if (sessionId && !custom) args.push('--resume', sessionId);

    const r = await run(bin, args, prompt, 180000, dir);
    let j;
    try { j = JSON.parse(r.out); } catch { /* sortie non JSON */ }
    if (!j) return send(res, 502, { error: (r.err || r.out || 'Réponse vide de Claude Code').slice(0, 800) });
    if (j.is_error) return send(res, 502, { error: String(j.result || 'Erreur Claude Code').slice(0, 800) });
    send(res, 200, { text: j.result, sessionId: j.session_id });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------- Dépannage : autorisation d'exécution des scripts PowerShell (Windows) ---------- */
const ps = (cmd) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], null, 20000);

async function powershellPolicy(req, res) {
  if (process.platform !== 'win32') return send(res, 400, { error: 'Disponible uniquement sous Windows.' });
  let setError = '';
  if (req.method === 'POST') {
    // Portée « utilisateur courant » : aucun droit administrateur requis, réversible.
    const r = await ps('Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force');
    setError = (r.err || '').trim();
  }
  const r = await ps('Get-ExecutionPolicy -List | ForEach-Object { $_.Scope.ToString() + "=" + $_.ExecutionPolicy.ToString() }');
  const list = {};
  r.out.split('\n').map((l) => l.trim()).filter(Boolean).forEach((l) => { const [k, v] = l.split('='); list[k] = v; });
  const order = ['MachinePolicy', 'UserPolicy', 'Process', 'CurrentUser', 'LocalMachine'];
  const effective = order.map((k) => list[k]).find((v) => v && v !== 'Undefined') || 'Restricted';
  const locked = ['MachinePolicy', 'UserPolicy'].some((k) => list[k] && list[k] !== 'Undefined');
  send(res, 200, { effective, list, locked, ok: !['Restricted', 'AllSigned'].includes(effective), error: setError });
}

http.createServer(async (req, res) => {
  try {
    const url = req.url || '/';
    if (url.startsWith('/api/')) {
      // Protège le proxy local contre les pages web tierces (CSRF / DNS rebinding).
      const host = String(req.headers.host || '');
      const origin = req.headers.origin;
      const local = (h) => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h);
      if (!local(host)) return send(res, 403, { error: 'Hôte non autorisé' });
      if (origin && !local(new URL(origin).host)) return send(res, 403, { error: 'Origine non autorisée' });
    }
    const ai = url.match(/^\/api\/(openai|gemini)(\/.*)$/);
    if (ai) return await aiProxy(req, res, ai[1], ai[2]);
    if (url === '/api/system/powershell-policy' && ['GET', 'POST'].includes(req.method)) return await powershellPolicy(req, res);
    if (url === '/api/claude-code/status') return await claudeCodeStatus(res);
    if (url === '/api/claude-code/chat' && req.method === 'POST') return await claudeCodeChat(req, res);
    if (url.startsWith('/api/jira/')) return await jira(req, res, url.slice('/api/jira'.length));
    if (url === '/api/claude' && req.method === 'POST') return await claude(req, res);
    if (url.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    let file = path.join(dist, decodeURIComponent(url.split('?')[0]));
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
    if (!fs.existsSync(file)) return send(res, 404, { error: 'Lancez "npm run build" ou "npm run dev"' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    send(res, 502, { error: String(e.message || e) });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Proxy prêt sur http://127.0.0.1:${PORT}`));
