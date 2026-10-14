import { claude, aiFetch, jira, searchIssues, countIssues, getIssue, addComment, getTransitions, doTransition, adfToText } from './api.js';

// Outils communs à tous les fournisseurs d'IA (Claude, ChatGPT, Gemini) : Jira + Confluence.
const TOOLS = [
  {
    name: 'search_issues',
    description: 'Recherche des tickets Jira avec une requête JQL. Retourne clé, résumé, statut, priorité, assigné.',
    input_schema: { type: 'object', properties: { jql: { type: 'string' }, max: { type: 'integer' } }, required: ['jql'] },
  },
  {
    name: 'count_issues',
    description: 'Compte les tickets correspondant à une requête JQL.',
    input_schema: { type: 'object', properties: { jql: { type: 'string' } }, required: ['jql'] },
  },
  {
    name: 'find_user',
    description: 'Trouve un utilisateur Jira par nom ou email ; retourne son accountId.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'get_issue',
    description: "Lit le détail d'un ticket : description et commentaires.",
    input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  },
  {
    name: 'confluence_search',
    description: 'Cherche dans TOUT Confluence (tous les espaces). Retourne titre, espace, id, lien et extrait.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, space: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'confluence_get_page',
    description: "Lit le contenu texte d'une page Confluence par son id.",
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'confluence_children',
    description: "Liste les pages descendantes d'une page Confluence (par défaut la page racine de documentation).",
    input_schema: { type: 'object', properties: { id: { type: 'string' } } },
  },
  {
    name: 'add_comment',
    description: "Ajoute un commentaire à un ticket (écriture, validée par l'utilisateur).",
    input_schema: { type: 'object', properties: { key: { type: 'string' }, text: { type: 'string' } }, required: ['key', 'text'] },
  },
  {
    name: 'transition_issue',
    description: "Change le statut d'un ticket. Sans transition_name, liste les transitions possibles. Écriture validée par l'utilisateur.",
    input_schema: { type: 'object', properties: { key: { type: 'string' }, transition_name: { type: 'string' } }, required: ['key'] },
  },
];

const row = (i) => ({
  key: i.key,
  summary: i.fields.summary,
  status: i.fields.status?.name,
  priority: i.fields.priority?.name,
  assignee: i.fields.assignee?.displayName || null,
  updated: i.fields.updated,
});

const htmlText = (html) => {
  const d = new DOMParser().parseFromString(String(html || ''), 'text/html');
  d.querySelectorAll('script,style').forEach((n) => n.remove());
  return (d.body.innerText || d.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
};

async function runTool(s, name, input, confirm) {
  const base = s.jiraUrl.replace(/\/+$/, '');
  if (name === 'search_issues') {
    const issues = await searchIssues(s, input.jql, ['summary', 'status', 'priority', 'assignee', 'updated'], Math.min(input.max || 25, 50));
    return JSON.stringify(issues.map(row));
  }
  if (name === 'count_issues') return String(await countIssues(s, input.jql));
  if (name === 'find_user') {
    const users = await jira(s, `/rest/api/3/user/search?query=${encodeURIComponent(input.query)}&maxResults=5`);
    return JSON.stringify(users.map((u) => ({ accountId: u.accountId, displayName: u.displayName, active: u.active })));
  }
  if (name === 'get_issue') {
    const i = await getIssue(s, input.key);
    return JSON.stringify({
      ...row(i),
      description: adfToText(i.fields.description).slice(0, 4000),
      comments: (i.fields.comment?.comments || []).slice(-10).map((c) => ({ author: c.author?.displayName, text: adfToText(c.body).slice(0, 1000) })),
    });
  }
  if (name === 'confluence_search') {
    const q = String(input.query).replace(/["\\]/g, ' ');
    const sp = input.space ? String(input.space).replace(/["\\]/g, '') : '';
    const cql = `${sp ? `space = "${sp}" AND ` : ''}type = page AND text ~ "${q}"`;
    const d = await jira(s, `/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=10`);
    return JSON.stringify((d.results || []).map((r) => ({
      id: r.content?.id, title: r.title, space: r.resultGlobalContainer?.title,
      url: base + '/wiki' + (r.content?._links?.webui || r.url || ''), excerpt: htmlText(r.excerpt).slice(0, 240),
    })));
  }
  if (name === 'confluence_children') {
    const d = await jira(s, `/wiki/rest/api/content/${encodeURIComponent(input.id || s.docRootPageId)}/descendant/page?limit=100`);
    return JSON.stringify((d.results || []).map((r) => ({ id: r.id, title: r.title, url: base + '/wiki' + (r._links?.webui || '') })));
  }
  if (name === 'confluence_get_page') {
    const d = await jira(s, `/wiki/rest/api/content/${encodeURIComponent(input.id)}?expand=body.view`);
    return JSON.stringify({ id: d.id, title: d.title, url: base + '/wiki' + (d._links?.webui || ''), text: htmlText(d.body?.view?.value).slice(0, 9000) });
  }
  if (name === 'add_comment') {
    if (!(await confirm(`Ajouter ce commentaire sur ${input.key} ?\n\n${input.text}`))) return "Refusé par l'utilisateur.";
    await addComment(s, input.key, input.text);
    return 'Commentaire ajouté.';
  }
  if (name === 'transition_issue') {
    const list = await getTransitions(s, input.key);
    if (!input.transition_name) return JSON.stringify(list.map((t) => t.name));
    const t = list.find((x) => x.name.toLowerCase() === input.transition_name.toLowerCase());
    if (!t) return `Transition introuvable. Disponibles : ${list.map((x) => x.name).join(', ')}`;
    if (!(await confirm(`Passer ${input.key} à « ${t.name} » ?`))) return "Refusé par l'utilisateur.";
    await doTransition(s, input.key, t.id);
    return 'Transition effectuée.';
  }
  return 'Outil inconnu.';
}

const SYSTEM = `Tu es l'assistant IA de l'équipe CDS Team-IT, intégré à une interface Jira Service Management.
Réponds en français, de façon concise. Utilise les outils pour consulter Jira et Confluence plutôt que d'inventer.
Pour toute écriture (commentaire, transition), l'utilisateur doit valider : n'agis que si c'est demandé.
Contexte courant : {{CONTEXT}}`;

const MAX_TURNS = 8;
const exec = async (s, name, input, confirm, onStep) => {
  onStep?.(`${name} ${JSON.stringify(input)}`);
  try { return await runTool(s, name, input, confirm); } catch (e) { return `Erreur : ${e.message}`; }
};

/* ----- Claude (API Anthropic) ----- */
async function askClaude(s, history, system, confirm, onStep) {
  const messages = [...history];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const r = await claude(s, { model: s.claudeModel, max_tokens: 2048, system, tools: TOOLS, messages });
    messages.push({ role: 'assistant', content: r.content });
    const uses = r.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) return { messages, text: r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') };
    const results = [];
    for (const u of uses) results.push({ type: 'tool_result', tool_use_id: u.id, content: await exec(s, u.name, u.input, confirm, onStep) });
    messages.push({ role: 'user', content: results });
  }
  return { messages, text: "Trop d'étapes sans conclusion." };
}

/* ----- ChatGPT (API OpenAI, chat completions) ----- */
async function askOpenAI(s, history, system, confirm, onStep) {
  const messages = [...history];
  const tools = TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const r = await aiFetch(s, 'openai', '/v1/chat/completions', {
      model: s.openaiModel,
      messages: [{ role: 'system', content: system }, ...messages],
      tools,
    });
    const m = r.choices?.[0]?.message;
    if (!m) throw new Error('Réponse OpenAI vide');
    messages.push(m);
    if (!m.tool_calls?.length) return { messages, text: m.content || '' };
    for (const c of m.tool_calls) {
      let args = {};
      try { args = JSON.parse(c.function.arguments || '{}'); } catch { /* arguments invalides */ }
      messages.push({ role: 'tool', tool_call_id: c.id, content: await exec(s, c.function.name, args, confirm, onStep) });
    }
  }
  return { messages, text: "Trop d'étapes sans conclusion." };
}

/* ----- Gemini (API Google) ----- */
async function askGemini(s, history, system, confirm, onStep) {
  // Les messages saisis par l'interface ({role, content}) sont convertis au format Gemini.
  const contents = history.map((m) => (m.parts ? m : { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content ?? '') }] }));
  const tools = [{ functionDeclarations: TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema })) }];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const r = await aiFetch(s, 'gemini', `/v1beta/models/${encodeURIComponent(s.geminiModel)}:generateContent`, {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools,
    });
    const content = r.candidates?.[0]?.content;
    if (!content) throw new Error(r.promptFeedback?.blockReason ? `Gemini : requête bloquée (${r.promptFeedback.blockReason})` : 'Réponse Gemini vide');
    contents.push(content);
    const calls = (content.parts || []).filter((p) => p.functionCall);
    if (!calls.length) return { messages: contents, text: (content.parts || []).map((p) => p.text || '').join('') };
    const responses = [];
    for (const p of calls) {
      const out = await exec(s, p.functionCall.name, p.functionCall.args || {}, confirm, onStep);
      responses.push({ functionResponse: { name: p.functionCall.name, response: { result: out } } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  return { messages: contents, text: "Trop d'étapes sans conclusion." };
}

// Boucle agentique : appelle le fournisseur choisi, exécute les outils demandés, recommence jusqu'à la réponse finale.
export async function ask(s, history, context, confirm, onStep, system = SYSTEM) {
  const sys = system.replace('{{CONTEXT}}', context);
  if (s.aiMode === 'openai') return askOpenAI(s, history, sys, confirm, onStep);
  if (s.aiMode === 'gemini') return askGemini(s, history, sys, confirm, onStep);
  return askClaude(s, history, sys, confirm, onStep);
}

// ---- Génération de filtre : décrire en français → requête JQL ----
export const jqlSystemPrompt = (filterId) => [
  'Tu convertis une demande en français en requête JQL pour Jira Cloud (site Team-IT, projets ITS et ITC).',
  'Règles :',
  `- Sauf demande contraire, commence par filter = ${filterId} (tickets en cours du CDS) puis ajoute les conditions avec AND.`,
  '- Priorités exactes : "P1 - Blocker" (bloquant), "P2 - Major" (majeur), "P3 - Medium", "P4 - Low" (faible).',
  '- Équipe CDS : assignee in (membersOf(CDS_Reporting)). Non assigné : assignee is EMPTY. Moi : currentUser().',
  '- Pour une personne, utilise l\'outil find_user pour obtenir son accountId, puis assignee = "accountId".',
  '- Dates : updated >= -7d, created >= startOfDay(), etc. Termine par un ORDER BY pertinent.',
  '- Valide si possible avec count_issues. Réponds UNIQUEMENT par la requête JQL finale, sans phrase ni balise ni backticks.',
].join('\n');

export const cleanJql = (t) => String(t || '').replace(/```[a-z]*/gi, '').replace(/`/g, '').trim();

export async function generateJql(s, text) {
  const sys = jqlSystemPrompt(s.filterId);
  if (s.aiMode === 'code') {
    const r = await fetch('/api/claude-code/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-jira-url': s.jiraUrl, 'x-jira-email': s.jiraEmail, 'x-jira-token': s.jiraToken, 'x-cds-filter': s.filterId,
      },
      body: JSON.stringify({ prompt: text, mode: 'jql', context: sys }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return cleanJql(j.text);
  }
  const r = await ask(s, [{ role: 'user', content: text }], '', async () => false, null, sys);
  return cleanJql(r.text);
}

// ---- Appel ponctuel (sans historique) : documentation, brouillon de réponse… ----
export async function claudeOnce(s, prompt, system) {
  if (s.aiMode === 'code') {
    const r = await fetch('/api/claude-code/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-jira-url': s.jiraUrl, 'x-jira-email': s.jiraEmail, 'x-jira-token': s.jiraToken, 'x-cds-filter': s.filterId,
        'x-doc-root': s.docRootPageId, 'x-doc-space': s.docSpace,
      },
      body: JSON.stringify({ prompt, mode: 'custom', context: system }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j.text;
  }
  const r = await ask(s, [{ role: 'user', content: prompt }], '', async () => false, null, system);
  return r.text;
}

export const docSystemPrompt = (s) => `Tu es l'assistant documentation du service desk Team-IT (CDS).
Tu peux lire TOUT Confluence (tous les espaces accessibles) : ne te limite pas à un seul espace.
Point de départ conseillé : espace « ${s.docSpace} », page « Gestion des incidents » (id ${s.docRootPageId}), mais cherche partout si nécessaire.

Démarche pour le ticket demandé :
1. Lis-le avec get_issue (titre, description, type, étiquettes).
2. Cherche la bonne documentation : confluence_search sans restriction d'espace avec plusieurs formulations (mots-clés du ticket, application, symptôme, nom du service), confluence_spaces / confluence_children pour explorer, et regarde aussi la page racine.
3. Lis les 1 à 3 pages les plus pertinentes avec confluence_get_page et vérifie qu'elles correspondent bien au cas du ticket.
4. Réponds en français, en Markdown concis :
   - **Documentation applicable** : liens [titre](url) avec une phrase sur la pertinence ;
   - **Procédure** : étapes tirées de la doc ;
   - **Points d'attention**.

Si tu ne trouves AUCUNE documentation pertinente :
   - dis-le explicitement en première ligne : « ⚠️ Aucune documentation trouvée pour ce cas », et indique ce que tu as cherché ;
   - puis propose TOI-MÊME un plan d'action en étapes, clairement présenté comme « Proposition (non issue de la documentation) » ;
   - suggère de documenter ce cas dans Confluence.

EXCEPTION : si le cas relève d'un envoi à l'administrateur / d'une escalade (droits ou accès que le support CDS n'a pas, demande hors périmètre, action réservée aux admins, ou si la documentation le demande), dis-le clairement en tête : « 🔺 À transmettre à l'administrateur », explique pourquoi et indique les informations à fournir — sans proposer de plan que le support ne peut pas exécuter.

N'invente jamais de page, de lien ni de procédure présentée comme officielle.`;

export const replySystemPrompt = [
  'Tu es agent du support IT Team-IT (CDS). Rédige une réponse au demandeur du ticket indiqué.',
  'Lis d\'abord le ticket avec get_issue. Ton professionnel, courtois, en français, clair et actionnable.',
  'Termine par « Cordialement, Support CDS Team-IT ». Réponds UNIQUEMENT par le texte du message, sans commentaire ni balises.',
].join('\n');
