const jiraHeaders = (s) => ({
  'x-jira-url': s.jiraUrl,
  'x-jira-email': s.jiraEmail,
  'x-jira-token': s.jiraToken,
  'content-type': 'application/json',
});

async function parse(r) {
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!r.ok) {
    const msg = data.error || (data.errorMessages || []).join(' ') || `HTTP ${r.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

export const jira = (s, path, init = {}) =>
  fetch('/api/jira' + path, { ...init, headers: { ...jiraHeaders(s), ...(init.headers || {}) } }).then(parse);

export async function searchIssues(s, jql, fields, max = 100) {
  const d = await jira(s, '/rest/api/3/search/jql', {
    method: 'POST',
    body: JSON.stringify({ jql, fields, maxResults: max }),
  });
  return d.issues || [];
}

export async function countIssues(s, jql) {
  const d = await jira(s, '/rest/api/3/search/approximate-count', { method: 'POST', body: JSON.stringify({ jql }) });
  return d.count ?? 0;
}

export const getFields = (s) => jira(s, '/rest/api/3/field');
export const getIssue = (s, key) =>
  jira(s, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,priority,assignee,reporter,description,comment,created,updated,issuetype`);
export const getTransitions = (s, key) =>
  jira(s, `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`).then((d) => d.transitions || []);
export const doTransition = (s, key, id) =>
  jira(s, `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { method: 'POST', body: JSON.stringify({ transition: { id } }) });
export const addComment = (s, key, text) =>
  jira(s, `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
    method: 'POST',
    body: JSON.stringify({ body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } }),
  });

export const claude = (s, payload) =>
  fetch('/api/claude', {
    method: 'POST',
    headers: { 'x-claude-key': s.claudeKey, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(parse);

// Convertit un document Atlassian (ADF) en texte brut.
// opts.marks : entoure les mentions de \u0001…\u0002 pour pouvoir les mettre en forme à l'affichage.
export function adfToText(n, opts = {}) {
  if (!n) return '';
  if (typeof n === 'string') return n;
  if (n.type === 'text') return n.text || '';
  if (n.type === 'mention') {
    const t = n.attrs?.text || '@personne';
    return opts.marks ? `\u0001${t}\u0002` : t;
  }
  if (n.type === 'hardBreak') return '\n';
  if (n.type === 'emoji') return n.attrs?.text || n.attrs?.shortName || '';
  if (n.type === 'inlineCard' || n.type === 'blockCard') return n.attrs?.url || '';
  if (n.type === 'mediaSingle' || n.type === 'media') return n.type === 'media' ? '[pièce jointe]' : (n.content || []).map((c) => adfToText(c, opts)).join('');
  const inner = (n.content || []).map((c) => adfToText(c, opts)).join(n.type === 'doc' ? '\n' : '');
  if (n.type === 'listItem') return `• ${inner.trim()}\n`;
  return ['paragraph', 'heading', 'codeBlock', 'blockquote'].includes(n.type) ? inner + '\n' : inner;
}

// ---- Commentaires façon Jira Service Management : réponse client (publique) / note interne ----
export async function getComments(s, key) {
  // API standard (ADF : mentions, listes, liens structurés) ; jsdPublic distingue réponse client / note interne.
  const d = await jira(s, `/rest/api/3/issue/${encodeURIComponent(key)}/comment?maxResults=100&orderBy=created`);
  return (d.comments || []).map((c) => ({
    id: c.id,
    author: c.author?.displayName || '—',
    created: c.created,
    public: c.jsdPublic === true,
    text: adfToText(c.body, { marks: true }).trim(),
  }));
}

export async function postComment(s, key, text, isPublic) {
  try {
    return await jira(s, `/rest/servicedeskapi/request/${encodeURIComponent(key)}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body: text, public: !!isPublic }),
    });
  } catch (e) {
    // Repli : API Jira standard avec la propriété « commentaire interne » de JSM.
    return jira(s, `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      method: 'POST',
      body: JSON.stringify({
        body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
        properties: [{ key: 'sd.public.comment', value: { internal: !isPublic } }],
      }),
    });
  }
}

// ---- Confluence : recherche et lecture directes (aucun appel à l'IA, donc aucun token consommé) ----
export async function jiraBlob(s, path) {
  const r = await fetch('/api/jira' + path, { headers: jiraHeaders(s) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return URL.createObjectURL(await r.blob());
}

const STOP = new Set(('de la le les des du un une et ou pour sur dans en au aux avec par ce cette ces est sont pas plus sans sous vers chez ' +
  'the a an to of for and in on is are with from by at it as be or not my your demande ticket probleme problème erreur svp merci bonjour').split(' '));

const decodeHtml = (t) => {
  const el = document.createElement('textarea');
  el.innerHTML = String(t || '');
  return el.value;
};

const cleanQ = (t) => String(t || '').replace(/[+\-&|!(){}\[\]^~*?\:"']/g, ' ').replace(/\s+/g, ' ').trim();

// Du plus précis au plus large : titre complet, puis mots-clés.
export function docQueries(summary) {
  const full = cleanQ(summary);
  const words = full.split(' ').filter((w) => w.length >= 3 && !STOP.has(w.toLowerCase()));
  const uniq = [...new Set(words.map((w) => w.toLowerCase()))];
  const out = [full, uniq.slice(0, 4).join(' '), uniq.slice(0, 2).join(' ')].filter(Boolean);
  return [...new Set(out)];
}

export async function searchDocs(s, query) {
  const cql = `type = page AND text ~ "${cleanQ(query)}"`;
  const d = await jira(s, `/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=6`);
  return (d.results || [])
    .filter((r) => r.content?.id)
    .map((r) => ({
      id: r.content.id,
      title: decodeHtml(String(r.title || '').replace(/@@@\w+@@@/g, '')),
      space: r.resultGlobalContainer?.title || '',
      excerpt: decodeHtml(String(r.excerpt || '').replace(/@@@\w+@@@/g, '')).slice(0, 200),
    }));
}

export async function getDocPage(s, id) {
  const d = await jira(s, `/wiki/rest/api/content/${encodeURIComponent(id)}?expand=body.view,space`);
  return {
    id: d.id,
    title: d.title,
    space: d.space?.name || '',
    url: `${s.jiraUrl.replace(/\/+$/, '')}/wiki${d._links?.webui || ''}`,
    html: d.body?.view?.value || '',
  };
}

// ---- Édition des tickets (tout ce que Jira expose via editmeta) ----
export const getIssueFull = (s, key) =>
  jira(s, `/rest/api/3/issue/${encodeURIComponent(key)}?expand=editmeta&fields=*all`);

export const updateFields = (s, key, fields) =>
  jira(s, `/rest/api/3/issue/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify({ fields }) });

export const assignIssue = (s, key, accountId) =>
  jira(s, `/rest/api/3/issue/${encodeURIComponent(key)}/assignee`, { method: 'PUT', body: JSON.stringify({ accountId: accountId || null }) });

export const getTransitionsFull = (s, key) =>
  jira(s, `/rest/api/3/issue/${encodeURIComponent(key)}/transitions?expand=transitions.fields`).then((d) => d.transitions || []);

export const doTransitionWith = (s, key, id, fields) =>
  jira(s, `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
    method: 'POST',
    body: JSON.stringify({ transition: { id }, ...(fields && Object.keys(fields).length ? { fields } : {}) }),
  });

export const searchUsers = (s, query, issueKey) =>
  jira(s, issueKey
    ? `/rest/api/3/user/assignable/search?issueKey=${encodeURIComponent(issueKey)}&query=${encodeURIComponent(query)}&maxResults=8`
    : `/rest/api/3/user/search?query=${encodeURIComponent(query)}&maxResults=8`);

export const getMyself = (s) => jira(s, '/rest/api/3/myself');

// ---- Recherche de documentation avec classement de pertinence ----
const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Groupes de termes équivalents (FR / EN) courants au support IT.
const CONCEPTS = [
  ['password', 'mot de passe', 'mdp', 'credentials', 'reinitialis', 'reset', 'deblocage', 'debloquer', 'verrouill', 'locked', 'unlock'],
  ['log in', 'login', 'connexion', 'connecter', 'authentification', 'authentication', 'sso', 'mfa', '2fa'],
  ['printer', 'imprimante', 'impression', 'print'],
  ['mail', 'email', 'outlook', 'messagerie', 'mailbox'],
  ['vpn', 'teletravail', 'remote'],
  ['laptop', 'ordinateur', 'workstation', 'poste de travail'],
  ['account', 'compte'],
  ['access', 'acces', 'droits', 'permission', 'rights'],
  ['phone', 'telephone', 'smartphone', 'iphone', 'android', 'mobile'],
  ['install', 'installation', 'logiciel', 'software'],
  ['wifi', 'reseau', 'network', 'internet'],
  ['arrivee', 'onboarding', 'nouvel arrivant', 'new joiner', 'depart', 'offboarding'],
];

// Mots mis en avant : [entre crochets], MAJUSCULES, ou noms propres au milieu d'une phrase.
function emphasized(text) {
  const out = new Set();
  String(text || '').replace(/\[([^\]]{2,40})\]/g, (_, g) => { g.split(/\s+/).forEach((w) => out.add(norm(w))); return ''; });
  (String(text || '').match(/\b[A-Z][A-Z0-9]{2,}\b/g) || []).forEach((w) => out.add(norm(w)));
  String(text || '').split(/[.!?\n]/).forEach((sentence) => {
    sentence.trim().split(/\s+/).slice(1).forEach((w) => { if (/^[A-Z][a-zA-Z0-9]{2,}$/.test(w)) out.add(norm(w)); });
  });
  return out;
}

const tokensOf = (text) => [...new Set(norm(cleanQ(text)).split(' ').filter((w) => w.length >= 3 && !STOP.has(w)))];

export async function findDocs(s, text) {
  const raw = String(text || '');
  const summary = raw.split('\n')[0];
  const body = norm(raw);
  const emph = emphasized(summary);
  const words = tokensOf(raw.slice(0, 700));
  const groups = CONCEPTS.filter((g) => g.some((t) => body.includes(t)));

  // Termes de recherche : mots mis en avant d'abord, puis termes de concept, puis mots-clés.
  const titleTerms = [...new Set([
    ...words.filter((w) => emph.has(w)),
    ...groups.map((g) => g[0]),
    ...words,
  ])].slice(0, 5);
  const queries = [
    ...titleTerms.map((t) => `type = page AND title ~ "${cleanQ(t)}"`),
    `type = page AND text ~ "${cleanQ(summary).slice(0, 120)}"`,
    `type = page AND text ~ "${titleTerms.slice(0, 3).map(cleanQ).join(' ')}"`,
  ].filter((q) => !/~ ""$/.test(q));

  const settled = await Promise.allSettled(queries.map((cql) =>
    jira(s, `/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=8`)));
  const firstError = settled.find((r) => r.status === 'rejected')?.reason;
  if (settled.every((r) => r.status === 'rejected')) throw firstError;

  const byId = new Map();
  settled.forEach((r) => {
    if (r.status !== 'fulfilled') return;
    (r.value.results || []).forEach((x) => {
      if (!x.content?.id || byId.has(x.content.id)) return;
      byId.set(x.content.id, {
        id: x.content.id,
        title: decodeHtml(String(x.title || '').replace(/@@@\w+@@@/g, '')),
        space: x.resultGlobalContainer?.title || '',
        excerpt: decodeHtml(String(x.excerpt || '').replace(/@@@\w+@@@/g, '')).slice(0, 200),
      });
    });
  });

  // Score : correspondance dans le titre >> extrait ; mots mis en avant et concepts pondérés.
  const scored = [...byId.values()].map((d) => {
    const t = norm(d.title);
    const e = norm(d.excerpt);
    let score = 0;
    words.forEach((w) => {
      if (t.includes(w)) score += emph.has(w) ? 5 : 3;
      else if (e.includes(w)) score += emph.has(w) ? 2 : 1;
    });
    groups.forEach((g) => {
      if (g.some((x) => t.includes(x))) score += 4;
      else if (g.some((x) => e.includes(x))) score += 1.5;
    });
    return { ...d, score };
  }).sort((a, b) => b.score - a.score);

  return { results: scored.slice(0, 8), tried: queries.map((q) => q.replace(/^type = page AND /, '')) };
}

// Note interne contenant un lien vers une page de documentation (lien cliquable dans Jira).
export async function postInternalDocNote(s, key, title, url) {
  const content = [{
    type: 'paragraph',
    content: [
      { type: 'text', text: '📚 Documentation utilisée : ' },
      { type: 'text', text: title, marks: [{ type: 'link', attrs: { href: url } }] },
    ],
  }];
  try {
    return await jira(s, `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body: { type: 'doc', version: 1, content }, properties: [{ key: 'sd.public.comment', value: { internal: true } }] }),
    });
  } catch {
    return postComment(s, key, `Documentation utilisée : ${title} - ${url}`, false);
  }
}

// ---- Autres fournisseurs d'IA (ChatGPT / Gemini) via le proxy local ----
export const aiFetch = (s, provider, path, body) => {
  const key = { openai: s.openaiKey, gemini: s.geminiKey, groq: s.groqKey }[provider];
  return fetch(`/api/${provider}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', [`x-${provider}-key`]: key },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    const text = await r.text();
    let d;
    try { d = text ? JSON.parse(text) : {}; } catch { d = { error: text }; }
    if (!r.ok) {
      const m = d.error?.message || d.error || `HTTP ${r.status}`;
      const text = typeof m === 'string' ? m : JSON.stringify(m);
      // Modèle retiré ou inaccessible : on dit où le changer.
      const hint = /model/i.test(text) && /(does not exist|not found|no access|not have access|decommission|deprecat)/i.test(text)
        ? ' → Paramètres > Assistant IA : clique sur « Tester la clé / charger les modèles » pour choisir un modèle disponible, puis Enregistrer.'
        : '';
      throw new Error(text + hint);
    }
    return d;
  });
};

// Liste les modèles disponibles pour la clé saisie.
export async function listModels(s, provider) {
  if (provider === 'openai') {
    const d = await aiFetch(s, 'openai', '/v1/models');
    return (d.data || []).map((m) => m.id).filter((id) => /^(gpt|o\d|chatgpt)/i.test(id)).sort();
  }
  if (provider === 'groq') {
    const d = await aiFetch(s, 'groq', '/openai/v1/models');
    return (d.data || []).map((m) => m.id).filter((id) => !/whisper|guard|tts|playai|distil-whisper/i.test(id)).sort();
  }
  const d = await aiFetch(s, 'gemini', '/v1beta/models?pageSize=100');
  return (d.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name).replace(/^models\//, ''))
    .sort();
}

// Télécharge un fichier Jira (pièce jointe) avec les identifiants, via le proxy local.
export async function jiraBlobRaw(s, path) {
  const r = await fetch('/api/jira' + path, { headers: jiraHeaders(s) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.blob();
}
