// Serveur MCP (stdio) minimal : expose Jira et Confluence à Claude Code.
// Identifiants reçus par variables d'environnement, jamais écrits sur disque.
//   JIRA_URL, JIRA_EMAIL, JIRA_TOKEN, ALLOW_WRITE=1 (optionnel), DEFAULT_FILTER, DOC_ROOT, DOC_SPACE (optionnels)
import readline from 'node:readline';

const { JIRA_URL = '', JIRA_EMAIL = '', JIRA_TOKEN = '', ALLOW_WRITE = '', DEFAULT_FILTER = '', DOC_ROOT = '', DOC_SPACE = '' } = process.env;
const BASE = JIRA_URL.replace(/\/+$/, '');
const auth = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');

async function jira(path, init = {}) {
  const r = await fetch(BASE + path, {
    ...init,
    headers: { authorization: auth, accept: 'application/json', 'content-type': 'application/json' },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Jira ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const adf = (n) => {
  if (!n) return '';
  if (n.type === 'text') return n.text || '';
  const inner = (n.content || []).map(adf).join('');
  return ['paragraph', 'heading', 'listItem'].includes(n.type) ? inner + '\n' : inner;
};

// HTML Confluence (storage format) → texte brut lisible.
const NL = String.fromCharCode(10);
const htmlToText = (html) =>
  String(html || '')
    .replace(/<\/(p|h[1-6]|li|tr|div)>/gi, NL)
    .replace(/<br\s*\/?>/gi, NL)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .split(NL).map((l) => l.trim()).filter(Boolean).join(NL);

const wikiUrl = (webui) => BASE + '/wiki' + (webui || '');

const row = (i) => ({
  key: i.key,
  summary: i.fields.summary,
  status: i.fields.status?.name,
  priority: i.fields.priority?.name,
  assignee: i.fields.assignee?.displayName || null,
  updated: i.fields.updated,
});

const TOOLS = [
  {
    name: 'search_issues',
    description: `Recherche des tickets Jira par JQL. Le filtre "en cours CDS" est ${DEFAULT_FILTER ? `filter = ${DEFAULT_FILTER}` : 'à préciser'}.`,
    inputSchema: { type: 'object', properties: { jql: { type: 'string' }, max: { type: 'integer' } }, required: ['jql'] },
    run: async ({ jql, max }) => {
      const d = await jira('/rest/api/3/search/jql', {
        method: 'POST',
        body: JSON.stringify({ jql, maxResults: Math.min(max || 25, 50), fields: ['summary', 'status', 'priority', 'assignee', 'updated'] }),
      });
      return (d.issues || []).map(row);
    },
  },
  {
    name: 'count_issues',
    description: 'Compte les tickets correspondant à une requête JQL (identique aux compteurs du tableau de bord).',
    inputSchema: { type: 'object', properties: { jql: { type: 'string' } }, required: ['jql'] },
    run: async ({ jql }) => (await jira('/rest/api/3/search/approximate-count', { method: 'POST', body: JSON.stringify({ jql }) })).count,
  },
  {
    name: 'find_user',
    description: 'Trouve un utilisateur Jira par nom ou email ; retourne son accountId (utile pour assignee = "accountId" en JQL).',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: async ({ query }) => {
      const users = await jira(`/rest/api/3/user/search?query=${encodeURIComponent(query)}&maxResults=5`);
      return users.map((u) => ({ accountId: u.accountId, displayName: u.displayName, active: u.active }));
    },
  },
  {
    name: 'get_issue',
    description: "Détail d'un ticket : description et derniers commentaires.",
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    run: async ({ key }) => {
      const i = await jira(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,priority,assignee,description,comment,updated,issuetype,labels`);
      return {
        ...row(i),
        type: i.fields.issuetype?.name,
        labels: i.fields.labels,
        description: adf(i.fields.description).slice(0, 4000),
        comments: (i.fields.comment?.comments || []).slice(-10).map((c) => ({ author: c.author?.displayName, text: adf(c.body).slice(0, 1000) })),
      };
    },
  },
  {
    name: 'confluence_search',
    description: `Cherche dans TOUT Confluence (tous les espaces accessibles). Retourne titre, espace, id, lien et extrait. Le paramètre space (clé d'espace, ex. ${DOC_SPACE || 'ITG'}) est optionnel pour restreindre la recherche.`,
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, space: { type: 'string' } }, required: ['query'] },
    run: async ({ query, space }) => {
      const q = String(query).replace(/["\\]/g, ' ');
      const sp = space ? String(space).replace(/["\\]/g, '') : '';
      const cql = `${sp ? `space = "${sp}" AND ` : ''}type = page AND text ~ "${q}"`;
      const d = await jira(`/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=10`);
      return (d.results || []).map((r) => ({
        id: r.content?.id,
        title: r.title,
        space: r.resultGlobalContainer?.title,
        url: wikiUrl(r.content?._links?.webui || r.url),
        excerpt: htmlToText(r.excerpt).slice(0, 240),
      }));
    },
  },
  {
    name: 'confluence_spaces',
    description: 'Liste les espaces Confluence accessibles (clé et nom) pour savoir où chercher.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const d = await jira('/wiki/rest/api/space?limit=100&type=global');
      return (d.results || []).map((r) => ({ key: r.key, name: r.name }));
    },
  },
  {
    name: 'confluence_children',
    description: "Liste toutes les pages descendantes d'une page Confluence (par défaut la page racine de documentation).",
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    run: async ({ id }) => {
      const d = await jira(`/wiki/rest/api/content/${encodeURIComponent(id || DOC_ROOT)}/descendant/page?limit=100`);
      return (d.results || []).map((r) => ({ id: r.id, title: r.title, url: wikiUrl(r._links?.webui) }));
    },
  },
  {
    name: 'confluence_get_page',
    description: "Lit le contenu texte d'une page Confluence (par défaut la page racine de documentation).",
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    run: async ({ id }) => {
      const d = await jira(`/wiki/rest/api/content/${encodeURIComponent(id || DOC_ROOT)}?expand=body.storage`);
      return { id: d.id, title: d.title, url: wikiUrl(d._links?.webui), text: htmlToText(d.body?.storage?.value).slice(0, 9000) };
    },
  },
];

if (ALLOW_WRITE === '1') {
  TOOLS.push(
    {
      name: 'add_comment',
      description: 'Ajoute un commentaire à un ticket.',
      inputSchema: { type: 'object', properties: { key: { type: 'string' }, text: { type: 'string' } }, required: ['key', 'text'] },
      run: async ({ key, text }) => {
        await jira(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
          method: 'POST',
          body: JSON.stringify({ body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } }),
        });
        return 'Commentaire ajouté.';
      },
    },
    {
      name: 'transition_issue',
      description: "Change le statut d'un ticket. Sans transition_name, liste les transitions possibles.",
      inputSchema: { type: 'object', properties: { key: { type: 'string' }, transition_name: { type: 'string' } }, required: ['key'] },
      run: async ({ key, transition_name }) => {
        const list = (await jira(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`)).transitions || [];
        if (!transition_name) return list.map((t) => t.name);
        const t = list.find((x) => x.name.toLowerCase() === transition_name.toLowerCase());
        if (!t) throw new Error(`Transition inconnue. Disponibles : ${list.map((x) => x.name).join(', ')}`);
        await jira(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { method: 'POST', body: JSON.stringify({ transition: { id: t.id } }) });
        return `Transition « ${t.name} » effectuée.`;
      },
    },
  );
}

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({ id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'jira', version: '1.1.0' } } });
  }
  if (method === 'tools/list') {
    return send({ id, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return send({ id, error: { code: -32602, message: 'Outil inconnu' } });
    try {
      const out = await tool.run(params.arguments || {});
      return send({ id, result: { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }] } });
    } catch (e) {
      return send({ id, result: { isError: true, content: [{ type: 'text', text: String(e.message || e) }] } });
    }
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: 'Méthode non supportée' } });
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  try { handle(JSON.parse(line)); } catch { /* ligne invalide ignorée */ }
});
