import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadSettings, saveSettings, DEFAULTS, DEFAULT_REPLIES, PROVIDERS, aiConfigured } from './settings.js';
import { jira, jiraBlobRaw, searchIssues, countIssues, getComments, postComment, listModels, findDocs, getDocPage, postInternalDocNote, adfToText, getIssueFull, updateFields, assignIssue, getTransitionsFull, doTransitionWith, getMyself } from './api.js';
import { FieldInput, kindOf, toDraft, toApi, valueText } from './FieldEditor.jsx';
import { ask, generateJql, claudeOnce, docSystemPrompt, replySystemPrompt } from './agent.js';
import { useInbox, showDesktop, notifSupported, TYPES } from './notify.js';
import Markdown from './Markdown.jsx';
import Attachments from './Attachments.jsx';
import { applyTheme, THEMES } from './theme.js';

const FIELDS = ['summary', 'status', 'priority', 'assignee', 'updated', 'created', 'issuetype'];
const fmt = (d) => (d ? new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const ready = (s) => s.jiraUrl && s.jiraEmail && s.jiraToken;
const person = (a) => ({ id: a?.accountId || null, name: a?.displayName || 'Non assigné' });
const esc = (t) => String(t).replace(/(["\\])/g, '\\$1');

// Une chaîne ressemble-t-elle à du JQL (plutôt qu'à une phrase) ?
const looksLikeJql = (t) =>
  /\s(AND|OR)\s|ORDER BY|^\s*filter\s*=|\b[\w."[\]]+\s*(=|!=|~|<=|>=|<|>)\s*\S|\b(in|not in)\s*\(/i.test(t) &&
  !/^[A-Za-zÀ-ÿ' ]+$/.test(t.trim());

/* ---------- Petits composants ---------- */
// Texte de commentaire avec mentions (@Nom) mises en forme.
function RichText({ text }) {
  const parts = String(text || '').split(/\u0001([^\u0002]*)\u0002/);
  return <>{parts.map((t, i) => (i % 2 ? <span key={i} className="mention">{t}</span> : t))}</>;
}

const COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];
function Avatar({ name, size = 28 }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  const c = COLORS[[...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % COLORS.length];
  return <span className="avatar" style={{ width: size, height: size, background: c, fontSize: size * 0.4 }}>{initials}</span>;
}

function Person({ p, onPerson, size = 24 }) {
  return (
    <a className="person" onClick={(e) => { e.stopPropagation(); onPerson(p); }} title={`Voir les tickets de ${p.name}`}>
      <Avatar name={p.name} size={size} />{p.name}
    </a>
  );
}

/* ---------- Recherche globale de tickets ---------- */
function GlobalSearch({ s, onOpen, onResults }) {
  const [q, setQ] = useState('');
  const [scope, setScope] = useState('cds');
  const [res, setRes] = useState(null);
  const [focus, setFocus] = useState(false);
  const box = useRef(null);

  const buildJql = useCallback((term) => {
    const t = term.trim();
    const words = t.split(/\s+/);
    const body = /^[A-Za-z][A-Za-z0-9]+-\d+$/.test(t)
      ? `key = "${t.toUpperCase()}"`
      : `text ~ "${esc(words.slice(0, -1).concat(words[words.length - 1].length >= 3 ? words[words.length - 1] + '*' : words[words.length - 1]).join(' '))}"`;
    return `${scope === 'cds' ? `filter = ${s.filterId} AND ` : ''}${body} ORDER BY updated DESC`;
  }, [s.filterId, scope]);

  useEffect(() => {
    if (!ready(s) || q.trim().length < 2) { setRes(null); return undefined; }
    const h = setTimeout(async () => {
      try { setRes({ issues: await searchIssues(s, buildJql(q), FIELDS, 8) }); } catch (e) { setRes({ error: e.message }); }
    }, 350);
    return () => clearTimeout(h);
  }, [q, s, buildJql]);

  useEffect(() => {
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setFocus(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);

  return (
    <div className="gsearch" ref={box}>
      <div className="row gap">
        <input
          value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => setFocus(true)}
          placeholder="Rechercher un ticket : clé, mot du titre ou de la description…"
          onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) { onResults(buildJql(q), `Recherche : ${q}`); setFocus(false); } }}
        />
        <select value={scope} onChange={(e) => setScope(e.target.value)} title="Périmètre">
          <option value="cds">Tickets CDS</option>
          <option value="all">Tout Jira</option>
        </select>
      </div>
      {focus && res && (
        <div className="gs-pop">
          {res.error && <div className="pad err-t">{res.error}</div>}
          {res.issues?.map((i) => (
            <div key={i.key} className="gs-item" onClick={() => { onOpen(i.key); setFocus(false); }}>
              <b>{i.key}</b> <span>{i.fields.summary}</span>
              <small className="muted">{i.fields.status?.name} · {i.fields.assignee?.displayName || 'Non assigné'}</small>
            </div>
          ))}
          {res.issues && !res.issues.length && <div className="pad muted">Aucun ticket trouvé.</div>}
          {res.issues?.length > 0 && (
            <div className="gs-item foot" onClick={() => { onResults(buildJql(q), `Recherche : ${q}`); setFocus(false); }}>Voir tous les résultats →</div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- Dashboard ---------- */
function Dashboard({ s, onOpen, onPerson, onJql, goSettings }) {
  const [state, setState] = useState({ loading: true });

  const load = useCallback(async () => {
    if (!ready(s)) return setState({ needSettings: true });
    setState((p) => ({ ...p, loading: true, error: null }));
    try {
      const pid = s.plannedFieldId;
      const num = (pid.match(/\d+$/) || [''])[0];
      const [issues, counts, scheduled] = await Promise.all([
        searchIssues(s, s.baseJql, FIELDS, 100),
        Promise.all(s.kpis.map((k) => countIssues(s, k.jql).catch(() => null))),
        num
          ? searchIssues(s, `filter = ${s.filterId} AND cf[${num}] is not EMPTY`, ['summary', 'status', pid], 100)
              .then((r) => r.map((i) => ({ ...i, planned: i.fields[pid] })))
              .catch(() => [])
          : Promise.resolve([]),
      ]);
      setState({ issues, counts, scheduled, at: new Date() });
    } catch (e) {
      setState({ error: e.message });
    }
  }, [s]);

  useEffect(() => { load(); }, [load]);

  if (state.needSettings) return <Empty onClick={goSettings} />;
  if (state.error) return <div className="banner err">Erreur Jira : {state.error}<button onClick={load}>Réessayer</button></div>;
  if (!state.issues) return <div className="muted pad">Chargement du tableau de bord…</div>;

  const { issues, counts, scheduled } = state;
  const people = Object.values(issues.reduce((a, i) => {
    const p = person(i.fields.assignee);
    (a[p.id || 'none'] ||= { ...p, n: 0 }).n++;
    return a;
  }, {})).sort((a, b) => b.n - a.n);
  const statuses = Object.entries(issues.reduce((a, i) => { const k = i.fields.status?.name || '—'; a[k] = (a[k] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...statuses.map((x) => x[1]));

  const group = (g) => s.kpis.filter((k) => (k.group || 'tickets') === g);
  const Tile = ({ k }) => (
    <div className={`kpi click ${k.tone || 'blue'}`} onClick={() => onJql(`${k.jql} ORDER BY updated DESC`, k.label)} title="Voir les tickets">
      <div className="kpi-n">{counts[s.kpis.indexOf(k)] ?? '–'}</div>
      <div className="kpi-l">{k.label}</div>
    </div>
  );

  return (
    <div className="stack">
      <div className="row between">
        <h1>CDS TEAM-IT</h1>
        <div className="row gap">
          <span className="muted small">Actualisé à {state.at.toLocaleTimeString('fr-FR')}</span>
          <button onClick={load} disabled={state.loading}>{state.loading ? '…' : 'Actualiser'}</button>
        </div>
      </div>

      <div className="grid2">
        <section className="card">
          <h2>Nombre de tickets</h2>
          <div className="kpis">{group('tickets').map((k) => <Tile key={k.label} k={k} />)}</div>
        </section>
        <section className="card">
          <h2>Indicateurs équipe CDS · Prise en charge &amp; garanties de temps</h2>
          <div className="kpis wide">{group('sla').map((k) => <Tile key={k.label} k={k} />)}</div>
        </section>
      </div>

      <div className="grid2">
        <section className="card">
          <h2>Responsable par ticket <span className="muted small">· clique sur une personne</span></h2>
          <table>
            <thead><tr><th>Personne</th><th>Nombre</th><th>%</th></tr></thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id || 'none'} className="click" onClick={() => onPerson(p)}>
                  <td><span className="person"><Avatar name={p.name} />{p.name}</span></td>
                  <td><b>{p.n}</b></td>
                  <td className="muted">{Math.round((p.n / issues.length) * 100)} %</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card">
          <h2>État des tickets <span className="muted small">({issues.length})</span></h2>
          {statuses.map(([k, n]) => (
            <div key={k} className="bar-row click" onClick={() => onJql(`filter = ${s.filterId} AND status = "${esc(k)}" ORDER BY updated DESC`, `Statut : ${k}`)}>
              <span>{k}</span><div className="bar"><i style={{ width: `${(n / max) * 100}%` }} /></div><b>{n}</b>
            </div>
          ))}
        </section>
      </div>

      <div className="grid2">
        <section className="card">
          <h2>Actions planifiées</h2>
          <Calendar items={scheduled} onOpen={onOpen} />
        </section>
        <section className="card">
          <h2>Flux d'activité</h2>
          <ul className="feed">
            {issues.slice(0, 12).map((i) => (
              <li key={i.key} onClick={() => onOpen(i.key)}>
                <b>{i.key}</b> {i.fields.summary}
                <div className="muted small row gap">
                  <span>{i.fields.status?.name}</span>·
                  <Person p={person(i.fields.assignee)} onPerson={onPerson} size={18} />·
                  <span>{fmt(i.fields.updated)}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function Calendar({ items, onOpen }) {
  const [m, setM] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const days = [];
  const lead = (m.getDay() + 6) % 7;
  const n = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
  for (let i = 0; i < lead; i++) days.push(null);
  for (let d = 1; d <= n; d++) days.push(d);
  const key = (d) => `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const at = (d) => items.filter((i) => (i.planned || '').slice(0, 10) === key(d));
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div>
      <div className="row between">
        <button onClick={() => setM(new Date(m.getFullYear(), m.getMonth() - 1, 1))}>‹</button>
        <b>{m.toLocaleString('fr-FR', { month: 'long', year: 'numeric' })}</b>
        <button onClick={() => setM(new Date(m.getFullYear(), m.getMonth() + 1, 1))}>›</button>
      </div>
      <div className="cal">
        {['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((d, i) => <div key={i} className="cal-h">{d}</div>)}
        {days.map((d, i) => (
          <div key={i} className={`cal-d ${d && key(d) === today ? 'today' : ''}`}>
            {d && <span>{d}</span>}
            {d && at(d).map((it) => <a key={it.key} title={it.fields.summary} onClick={() => onOpen(it.key)}>{it.key}</a>)}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Tickets : liste + filtre intelligent ---------- */
function TicketsPage({ s, preset, onOpen, onPerson, goSettings }) {
  const initial = preset?.jql || `filter = ${s.filterId} ORDER BY updated DESC`;
  const [jql, setJql] = useState(initial);
  const [nl, setNl] = useState('');
  const [issues, setIssues] = useState(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (q) => {
    setErr(''); setBusy(true);
    try { setIssues(await searchIssues(s, q, FIELDS, 100)); setJql(q); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }, [s]);

  useEffect(() => { if (ready(s)) run(initial); }, []); // eslint-disable-line

  const applyNl = async (e) => {
    e?.preventDefault();
    const t = nl.trim();
    if (!t) return;
    if (looksLikeJql(t)) { setNote('JQL appliqué tel quel.'); return run(t); }
    setBusy(true); setErr(''); setNote('✦ Claude construit le filtre…');
    try {
      const q = await generateJql(s, t);
      if (!q) throw new Error('Claude n\'a pas renvoyé de requête.');
      setNote(`✦ Filtre généré pour « ${t} »`);
      await run(q);
    } catch (e2) { setErr(e2.message); setNote(''); setBusy(false); }
  };

  const F = `filter = ${s.filterId}`;
  const chips = [
    ['Tous (CDS)', `${F} ORDER BY updated DESC`],
    ['Non assignés', `${F} AND assignee is EMPTY ORDER BY priority ASC, updated DESC`],
    ['Bloquants & majeurs', `${F} AND priority in ("P1 - Blocker", "P2 - Major") ORDER BY priority ASC`],
    ['Mes tickets', `${F} AND assignee = currentUser() ORDER BY updated DESC`],
    ["Mis à jour aujourd'hui", `${F} AND updated >= startOfDay() ORDER BY updated DESC`],
  ];

  if (!ready(s)) return <Empty onClick={goSettings} />;
  const p = preset?.person;
  return (
    <div className="stack">
      <div className="row between wrap gap">
        <div className="row gap">
          {p && <Avatar name={p.name} size={40} />}
          <div>
            <h1>{preset?.title || 'Tickets'}</h1>
            <span className="muted small">{issues ? `${issues.length} ticket(s)` : '…'}</span>
          </div>
        </div>
        {p?.id && (
          <button onClick={() => run(`assignee = "${p.id}" AND resolution = Unresolved ORDER BY updated DESC`)}>Voir hors filtre CDS</button>
        )}
      </div>

      <form className="card smart" onSubmit={applyNl}>
        <div className="row gap">
          <span className="spark">✦</span>
          <input
            className="grow" value={nl} onChange={(e) => setNl(e.target.value)}
            placeholder="Décris le filtre (« bloquants non assignés cette semaine ») ou colle un JQL"
          />
          <button className="primary" disabled={busy}>{busy ? '…' : 'Appliquer'}</button>
        </div>
        {note && <div className="small muted">{note}</div>}
        <div className="chips">
          {chips.map(([l, q]) => <button type="button" key={l} className="chip sm" onClick={() => { setNote(''); run(q); }}>{l}</button>)}
        </div>
      </form>

      <div className="row gap">
        <input className="grow mono" value={jql} onChange={(e) => setJql(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') run(jql); }} title="JQL courant (modifiable)" />
        <button onClick={() => run(jql)}>Exécuter</button>
      </div>
      {err && <div className="banner err">{err}</div>}

      <div className="card tablewrap">
        <table>
          <thead><tr><th>Clé</th><th>Résumé</th><th>Statut</th><th>Priorité</th><th>Assigné</th><th>Mis à jour</th></tr></thead>
          <tbody>
            {(issues || []).map((i) => (
              <tr key={i.key} className="click" onClick={() => onOpen(i.key)}>
                <td><b>{i.key}</b></td><td>{i.fields.summary}</td>
                <td><span className="pill">{i.fields.status?.name}</span></td>
                <td>{i.fields.priority?.name || '—'}</td>
                <td><Person p={person(i.fields.assignee)} onPerson={onPerson} /></td>
                <td className="muted">{fmt(i.fields.updated)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {issues && !issues.length && <p className="muted pad">Aucun résultat.</p>}
      </div>
    </div>
  );
}

/* ---------- Documentation du ticket (page Confluence affichée directement) ---------- */
const docCache = new Map(); // clé de ticket → { results, selected, tried }

// Nettoie le HTML Confluence : pas de scripts, liens absolus, images chargées via le proxy.
function sanitizeDoc(html, base) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed,form,link,meta,base').forEach((n) => n.remove());
  doc.body.querySelectorAll('*').forEach((el) => {
    [...el.attributes].forEach((a) => { if (/^on/i.test(a.name) || a.name === 'style') el.removeAttribute(a.name); });
    if (el.tagName === 'A') {
      const h = el.getAttribute('href') || '';
      if (/^javascript:/i.test(h)) el.removeAttribute('href');
      else if (h.startsWith('/')) el.setAttribute('href', base + h);
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noreferrer');
    }
    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') || '';
      el.removeAttribute('srcset');
      el.removeAttribute('src');
      if (src.startsWith('/')) el.setAttribute('data-src', src);
      else if (src.startsWith(base)) el.setAttribute('data-src', src.slice(base.length));
    }
  });
  return doc.body.innerHTML;
}

function DocPanel({ s, issueKey, summary, description, onNote }) {
  const [state, setState] = useState(() => docCache.get(issueKey) || null); // { results, selected, tried }
  const [searching, setSearching] = useState(false);
  const [page, setPage] = useState(null); // { loading, title, space, url, html, error }
  const [big, setBig] = useState(false);
  const [q, setQ] = useState('');
  const [ai, setAi] = useState(null); // { loading, text, error }
  const [note, setNote] = useState({}); // id de page → 'busy' | 'done' | message d'erreur
  const body = useRef(null);
  const base = s.jiraUrl.replace(/\/+$/, '');

  // text : titre du ticket (1re ligne) + extrait de description, ou requête saisie à la main.
  const runSearch = useCallback(async (text) => {
    setSearching(true); setPage(null); setAi(null);
    try {
      const { results, tried } = await findDocs(s, text);
      const next = { results, selected: results[0]?.id || null, tried };
      docCache.set(issueKey, next);
      setState(next);
    } catch (e) {
      setState({ results: [], selected: null, tried: [], error: e.message });
    } finally { setSearching(false); }
  }, [s, issueKey]);

  const ticketText = `${summary}
${(description || '').slice(0, 400)}`;

  // Recherche automatique à l'ouverture du ticket (gratuite : aucun appel à l'IA).
  useEffect(() => {
    setState(docCache.get(issueKey) || null); setPage(null); setAi(null); setQ('');
    if (s.autoDoc && summary && !docCache.has(issueKey)) runSearch(ticketText);
  }, [issueKey, summary, s.autoDoc]); // eslint-disable-line

  // Charge la page sélectionnée.
  useEffect(() => {
    const id = state?.selected;
    if (!id) { setPage(null); return undefined; }
    let live = true;
    setPage({ loading: true });
    getDocPage(s, id)
      .then((p) => { if (live) setPage({ ...p, html: sanitizeDoc(p.html, base) }); })
      .catch((e) => { if (live) setPage({ error: e.message }); });
    return () => { live = false; };
  }, [state?.selected, s, base]);

  // Images : récupérées avec les identifiants via le proxy local.
  useEffect(() => {
    if (!page?.html || !body.current) return;
    let live = true;
    const made = [];
    body.current.querySelectorAll('img[data-src]').forEach(async (img) => {
      // 1) API REST des pièces jointes (accepte le token API) ; 2) chemin de téléchargement d'origine.
      const att = img.getAttribute('data-linked-resource-id');
      const host = img.getAttribute('data-linked-resource-container-id');
      const paths = [];
      if (att && host) paths.push(`/wiki/rest/api/content/${host}/child/attachment/att${att}/download`);
      paths.push(img.getAttribute('data-src'));
      for (const path of paths) {
        try {
          const blob = await jiraBlobRaw(s, path);
          if (!/^image\//.test(blob.type)) continue; // page de connexion HTML, etc.
          if (!live) return;
          const u = URL.createObjectURL(blob);
          made.push(u);
          img.removeAttribute('loading');
          img.src = u;
          return;
        } catch { /* on essaie le chemin suivant */ }
      }
      img.title = "Image non chargée : ouvre la page dans Confluence pour la voir";
      img.alt = `[image non chargée : ${img.alt || 'pièce jointe'}]`;
    });
    return () => { live = false; made.forEach((u) => URL.revokeObjectURL(u)); };
  }, [page?.html, s]);

  const askAi = async () => {
    setAi({ loading: true });
    try {
      const t = await claudeOnce(s, `Trouve la documentation et la procédure applicables au ticket ${issueKey}.`, docSystemPrompt(s));
      setAi({ text: t });
    } catch (e) { setAi({ error: e.message }); }
  };

  const none = state && !state.results.length && !searching;
  return (
    <section className="card doc">
      <div className="row between wrap gap">
        <h2 style={{ margin: 0 }}>📚 Documentation</h2>
        <form className="row gap doc-search" onSubmit={(e) => { e.preventDefault(); if (q.trim()) runSearch(q.trim()); }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Chercher dans Confluence…" />
          <button>Chercher</button>
        </form>
      </div>

      {!state && !searching && (
        <div className="row gap wrap">
          <button className="primary" onClick={() => runSearch(ticketText)}>Chercher la documentation de ce ticket</button>
          <span className="muted small">Recherche directe dans Confluence, sans IA.</span>
        </div>
      )}
      {searching && <div className="typing inline"><i /><i /><i /></div>}
      {state?.error && <div className="banner err">{state.error}</div>}

      {state?.results.length > 1 && (
        <div className="chips">
          {state.results.map((r) => (
            <button key={r.id} className={`chip sm ${r.id === state.selected ? 'on' : ''}`} title={r.excerpt}
              onClick={() => { const n = { ...state, selected: r.id }; docCache.set(issueKey, n); setState(n); }}>
              {r.title}{r.space ? ` · ${r.space}` : ''}
            </button>
          ))}
        </div>
      )}

      {page?.loading && <div className="muted small">Chargement de la page…</div>}
      {page?.error && <div className="banner err">{page.error}</div>}
      {page?.html && (
        <div className="doc-viewer">
          <div className="row between wrap gap doc-head">
            <b>{page.title}</b>
            <div className="row gap">
              <button
                disabled={note[state.selected] === 'busy' || note[state.selected] === 'done'}
                title="Crée une note interne contenant le lien vers cette page"
                onClick={async () => {
                  const id = state.selected;
                  setNote((n) => ({ ...n, [id]: 'busy' }));
                  try { await postInternalDocNote(s, issueKey, page.title, page.url); setNote((n) => ({ ...n, [id]: 'done' })); onNote?.(); }
                  catch (e) { setNote((n) => ({ ...n, [id]: e.message })); }
                }}
              >
                {note[state.selected] === 'busy' ? '…' : note[state.selected] === 'done' ? '✓ Note interne créée' : '📎 Rattacher à une note interne'}
              </button>
              <button onClick={() => setBig(!big)}>{big ? 'Réduire' : 'Agrandir'}</button>
              <a className="ext" href={page.url} target="_blank" rel="noreferrer">Ouvrir dans Confluence ↗</a>
            </div>
          </div>
          {note[state.selected] && !['busy', 'done'].includes(note[state.selected]) && <div className="banner err">{note[state.selected]}</div>}
          <div ref={body} className={`conf ${big ? 'big' : ''}`} dangerouslySetInnerHTML={{ __html: page.html }} />
        </div>
      )}

      {none && (
        <div className="stack doc-none">
          <div className="banner warn">⚠️ Aucune documentation trouvée pour ce ticket.
            <span className="small"> Recherches : {state.tried.map((t) => `« ${t} »`).join(', ')}</span></div>
        </div>
      )}

      {state && (
        <div className="row gap wrap">
          <button className={none ? 'primary' : 'ghost'} onClick={askAi} disabled={ai?.loading}>
            {ai?.loading ? 'Claude cherche…' : none ? '✦ Demander l\'aide de l\'IA' : '✦ Pas la bonne doc ? Demander l\'aide de l\'IA'}
          </button>
        </div>
      )}
      {ai?.loading && <div className="typing inline"><i /><i /><i /></div>}
      {ai?.error && <div className="banner err">{ai.error}</div>}
      {ai?.text && <div className="ai-doc"><Markdown text={ai.text} onOpen={() => {}} /></div>}
    </section>
  );
}

// Remplace {{prenom}}, {{ticket}}, {{agent}} dans un modèle de réponse.
function fillReply(tpl, { reporter, ticket, agent }) {
  const raw = String(reporter || '').trim();
  const first = raw && !raw.includes('@') && !/no-?reply|donotreply/i.test(raw) ? raw.split(/\s+/)[0] : '';
  return String(tpl)
    .replace(/\{\{prenom\}\}/g, first)
    .replace(/\{\{ticket\}\}/g, ticket || '')
    .replace(/\{\{agent\}\}/g, agent || '')
    .replace(/Bonjour ,/g, 'Bonjour,');
}

/* ---------- Ticket en grand ---------- */

// Champ éditable en place : affichage + crayon, puis formulaire adapté au type du champ Jira.
function EditableField({ s, issueKey, fieldId, meta, value, name, variant = 'row', onSaved, extra, render }) {
  const kind = meta ? kindOf(meta) : null;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const start = () => { setDraft(toDraft(kind, value)); setErr(''); setEditing(true); };
  const save = async () => {
    setBusy(true); setErr('');
    try {
      if (fieldId === 'assignee') await assignIssue(s, issueKey, draft?.accountId || null);
      else await updateFields(s, issueKey, { [fieldId]: toApi(kind, draft) });
      setEditing(false);
      await onSaved();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const view = render ? render(value) : (
    variant === 'title' ? <h1 className="issue-title">{valueText(value)}</h1>
      : variant === 'block' ? <div className="desc-big">{valueText(value) === '—' ? <span className="muted">Aucune description.</span> : valueText(value)}</div>
        : <span>{valueText(value)}</span>
  );
  const pencil = kind && !editing && <button className="pencil" title="Modifier" onClick={start}>✎</button>;

  const form = editing && (
    <div className="edit-form">
      <FieldInput s={s} issueKey={issueKey} meta={meta} kind={kind} value={draft} onChange={setDraft} />
      {err && <div className="banner err">{err}</div>}
      <div className="row gap">
        <button className="primary" onClick={save} disabled={busy}>{busy ? '…' : 'Enregistrer'}</button>
        <button onClick={() => setEditing(false)}>Annuler</button>
      </div>
    </div>
  );

  if (variant === 'title') {
    return <div>{!editing && <div className="row gap">{view}{pencil}</div>}{form}</div>;
  }
  if (variant === 'block') {
    return (
      <div>
        <div className="row between"><h2 style={{ margin: 0 }}>{name}</h2>{pencil}</div>
        {!editing && view}{form}
      </div>
    );
  }
  return (
    <div className="kv">
      <div className="row between"><span className="muted small">{name}{meta?.required ? ' *' : ''}</span>{pencil}</div>
      {!editing && <div className="row gap wrap">{view}{extra}</div>}
      {form}
    </div>
  );
}

// Fenêtre de saisie des champs exigés par une transition (ex. résolution).
function TransitionDialog({ s, issueKey, tr, onClose, onDone }) {
  const required = Object.entries(tr.fields || {}).filter(([, f]) => f.required && !f.hasDefaultValue);
  const [drafts, setDrafts] = useState(() => Object.fromEntries(required.map(([id, f]) => [id, toDraft(kindOf(f), null)])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setBusy(true); setErr('');
    try {
      const fields = {};
      required.forEach(([id, f]) => { fields[id] = toApi(kindOf(f), drafts[id]); });
      await doTransitionWith(s, issueKey, tr.id, fields);
      onDone();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal card stack" onClick={(e) => e.stopPropagation()}>
        <h2>{tr.name}</h2>
        <p className="muted small">Cette transition demande des informations avant de continuer.</p>
        {required.map(([id, f]) => (
          <label key={id}>{f.name} *
            {kindOf(f)
              ? <FieldInput s={s} issueKey={issueKey} meta={f} kind={kindOf(f)} value={drafts[id]} onChange={(v) => setDrafts({ ...drafts, [id]: v })} />
              : <span className="warn-t small">Champ non supporté ici : effectue cette transition dans Jira.</span>}
          </label>
        ))}
        {err && <div className="banner err">{err}</div>}
        <div className="row gap">
          <button className="primary" onClick={submit} disabled={busy || required.some(([, f]) => !kindOf(f))}>{busy ? '…' : 'Valider'}</button>
          <button onClick={onClose}>Annuler</button>
        </div>
      </div>
    </div>
  );
}

const CORE_FIELDS = ['priority', 'assignee', 'reporter', 'labels', 'components', 'fixVersions', 'versions', 'duedate', 'environment'];
const HIDDEN_FIELDS = new Set(['summary', 'description', 'comment', 'attachment', 'issuelinks', 'worklog', 'timetracking', 'issuetype', 'project', 'parent', 'subtasks', 'status', 'resolution']);

function IssueView({ s, issueKey, onClose, onChanged, onPerson }) {
  const [issue, setIssue] = useState(null);
  const [trans, setTrans] = useState([]);
  const [comments, setComments] = useState([]);
  const [me, setMe] = useState(null);
  const [err, setErr] = useState('');
  const [dlg, setDlg] = useState(null); // transition en attente de champs
  const [mode, setMode] = useState('internal'); // 'internal' = note interne, 'public' = réponse au client
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  const [drafting, setDrafting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [i, t, c] = await Promise.all([getIssueFull(s, issueKey), getTransitionsFull(s, issueKey), getComments(s, issueKey)]);
      setIssue(i); setTrans(t); setComments(c);
    } catch (e) { setErr(e.message); }
  }, [s, issueKey]);
  useEffect(() => { setIssue(null); setErr(''); load(); window.scrollTo?.(0, 0); }, [load, issueKey]);
  useEffect(() => { getMyself(s).then(setMe).catch(() => {}); }, [s]);

  const saved = async () => { await load(); onChanged?.(); };

  const go = async (t) => {
    const needs = Object.values(t.fields || {}).some((f) => f.required && !f.hasDefaultValue);
    if (needs) { setDlg(t); return; }
    try { await doTransitionWith(s, issueKey, t.id); await saved(); } catch (e) { setErr(e.message); }
  };

  const send = async () => {
    if (!text.trim()) return;
    setBusy(true); setErr('');
    try {
      await postComment(s, issueKey, text.trim(), mode === 'public');
      setText(''); setConfirmSend(false);
      await load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const draft = async () => {
    setDrafting(true); setErr('');
    try {
      const t = await claudeOnce(s, `Rédige une réponse au demandeur pour le ticket ${issueKey}.`, replySystemPrompt);
      setMode('public'); setText(t.trim());
    } catch (e) { setErr(e.message); } finally { setDrafting(false); }
  };

  const f = issue?.fields;
  const edit = issue?.editmeta?.fields || {};
  const jiraLink = `${s.jiraUrl.replace(/\/+$/, '')}/browse/${issueKey}`;

  // Champs éditables supportés : d'abord les principaux, puis les champs personnalisés par nom.
  const names = issue?.names || {};
  const ids = Object.keys(edit).filter((id) => !HIDDEN_FIELDS.has(id) && kindOf(edit[id]));
  const core = CORE_FIELDS.filter((id) => ids.includes(id));
  const others = ids.filter((id) => !CORE_FIELDS.includes(id)).sort((a, b) => String(edit[a].name).localeCompare(String(edit[b].name), 'fr'));
  const unsupported = Object.keys(edit).filter((id) => !HIDDEN_FIELDS.has(id) && !kindOf(edit[id])).length;

  const fieldRow = (id) => (
    <EditableField
      key={id} s={s} issueKey={issueKey} fieldId={id} meta={edit[id]} name={edit[id].name || names[id] || id}
      value={f[id]} onSaved={saved}
      render={id === 'assignee' ? (v) => <Person p={person(v)} onPerson={onPerson} /> : undefined}
      extra={id === 'assignee' && me && f.assignee?.accountId !== me.accountId ? (
        <button className="linkbtn inline" onClick={async () => { try { await assignIssue(s, issueKey, me.accountId); await saved(); } catch (e) { setErr(e.message); } }}>Me l'assigner</button>
      ) : null}
    />
  );

  return (
    <div className="stack issue">
      <div className="row between wrap gap">
        <button onClick={onClose}>← Retour</button>
        <a className="ext" href={jiraLink} target="_blank" rel="noreferrer">Ouvrir dans Jira ↗</a>
      </div>
      {err && <div className="banner err">{err}</div>}
      {!f && !err && <div className="muted pad">Chargement du ticket…</div>}
      {f && (
        <>
          <div>
            <div className="muted small">{f.issuetype?.name} · {issueKey}</div>
            <EditableField s={s} issueKey={issueKey} fieldId="summary" meta={edit.summary} value={f.summary} variant="title" onSaved={saved} />
          </div>
          <div className="row gap wrap">
            <span className="pill big">{f.status?.name}</span>
            {trans.map((t) => <button key={t.id} onClick={() => go(t)}>{t.name}</button>)}
          </div>

          <div className="issue-grid">
            <div className="stack">
              <section className="card">
                <EditableField s={s} issueKey={issueKey} fieldId="description" meta={edit.description} name="Description" value={f.description} variant="block" onSaved={saved} />
              </section>

              <Attachments s={s} items={f.attachment || []} />

              <DocPanel s={s} issueKey={issueKey} summary={f.summary} description={adfToText(f.description)} onNote={load} />

              <section className="card stack">
                <h2>Activité ({comments.length})</h2>
                {comments.map((c) => (
                  <div key={c.id} className={`comment-big ${c.public ? 'pub' : 'int'}`}>
                    <Avatar name={c.author} size={34} />
                    <div className="grow">
                      <div className="row gap wrap">
                        <b>{c.author}</b>
                        <span className={`tag ${c.public ? 'pub' : 'int'}`}>{c.public ? 'Réponse au client' : '🔒 Note interne'}</span>
                        <span className="muted small">{fmt(c.created)}</span>
                      </div>
                      <div className="desc-big"><RichText text={c.text} /></div>
                    </div>
                  </div>
                ))}
                {!comments.length && <p className="muted">Aucun commentaire.</p>}

                <div className={`composer-big ${mode}`}>
                  <div className="tabs">
                    <button type="button" className={mode === 'public' ? 'on' : ''} onClick={() => { setMode('public'); setConfirmSend(false); }}>✉ Répondre au client</button>
                    <button type="button" className={mode === 'internal' ? 'on' : ''} onClick={() => { setMode('internal'); setConfirmSend(false); }}>🔒 Note interne</button>
                    <span className="grow" />
                    <button type="button" className="ghost" onClick={draft} disabled={drafting}>{drafting ? '✦ Rédaction…' : '✦ Proposer une réponse'}</button>
                  </div>
                  {mode === 'public' && (s.replies || []).length > 0 && (
                    <div className="stdreply">
                      <label className="small muted" htmlFor="stdreply">Réponse standardisée</label>
                      <select
                        id="stdreply" value="" title="Insère un modèle de réponse, modifiable avant l'envoi"
                        onChange={(e) => {
                          const tpl = s.replies.find((r) => r.id === e.target.value);
                          if (!tpl) return;
                          const filled = fillReply(tpl.text, { reporter: f.reporter?.displayName, ticket: issueKey, agent: me?.displayName });
                          setText((cur) => (cur.trim() ? `${cur.trimEnd()}\n\n${filled}` : filled));
                          setConfirmSend(false);
                        }}
                      >
                        <option value="">— Choisir un modèle à insérer —</option>
                        {s.replies.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
                      </select>
                    </div>
                  )}
                  <textarea
                    rows={5} value={text} onChange={(e) => { setText(e.target.value); setConfirmSend(false); }}
                    placeholder={mode === 'public' ? 'Votre réponse sera visible par le demandeur…' : "Note visible uniquement par l'équipe support…"}
                  />
                  <div className="row gap wrap">
                    {mode === 'public' && !confirmSend && (
                      <button className="primary" disabled={busy || !text.trim()} onClick={() => setConfirmSend(true)}>Envoyer au client</button>
                    )}
                    {mode === 'public' && confirmSend && (
                      <>
                        <span className="small warn-t">Le demandeur recevra ce message. Confirmer ?</span>
                        <button className="primary" disabled={busy} onClick={send}>{busy ? '…' : 'Oui, envoyer'}</button>
                        <button onClick={() => setConfirmSend(false)}>Annuler</button>
                      </>
                    )}
                    {mode === 'internal' && (
                      <button className="primary" disabled={busy || !text.trim()} onClick={send}>{busy ? '…' : 'Ajouter la note interne'}</button>
                    )}
                  </div>
                </div>
              </section>
            </div>

            <aside className="card stack side-details">
              <h2>Détails</h2>
              <div className="kv"><span className="muted small">Statut</span><div><span className="pill">{f.status?.name}</span></div></div>
              {!ids.includes('assignee') && (
                <div className="kv"><span className="muted small">Assigné</span><div><Person p={person(f.assignee)} onPerson={onPerson} /></div></div>
              )}
              {core.map(fieldRow)}
              {others.map(fieldRow)}
              <div className="kv"><span className="muted small">Créé le</span><div>{fmt(f.created)}</div></div>
              <div className="kv"><span className="muted small">Mis à jour</span><div>{fmt(f.updated)}</div></div>
              {unsupported > 0 && (
                <p className="muted small">{unsupported} autre(s) champ(s) (pièces jointes, liens, temps…) se modifient dans <a className="ext" href={jiraLink} target="_blank" rel="noreferrer">Jira ↗</a>.</p>
              )}
            </aside>
          </div>
        </>
      )}
      {dlg && <TransitionDialog s={s} issueKey={issueKey} tr={dlg} onClose={() => setDlg(null)} onDone={async () => { setDlg(null); await saved(); }} />}
    </div>
  );
}

/* ---------- Boîte de réception ---------- */
function InboxPage({ inbox, onOpen, s, goSettings }) {
  const [onlyUnread, setOnlyUnread] = useState(false);
  const list = onlyUnread ? inbox.items.filter((x) => !x.read) : inbox.items;
  const perm = notifSupported() ? Notification.permission : 'unsupported';
  return (
    <div className="stack narrow">
      <div className="row between wrap gap">
        <h1>Boîte de réception {inbox.unread > 0 && <span className="badge">{inbox.unread}</span>}</h1>
        <div className="row gap wrap">
          <button onClick={() => setOnlyUnread(!onlyUnread)}>{onlyUnread ? 'Tout afficher' : 'Non lus seulement'}</button>
          <button onClick={inbox.markAll} disabled={!inbox.unread}>Tout marquer comme lu</button>
          <button onClick={inbox.clear} disabled={!inbox.items.length}>Vider</button>
        </div>
      </div>
      <div className="muted small">
        {inbox.error ? <span className="err-t">Erreur de surveillance : {inbox.error}</span>
          : inbox.lastCheck ? `Dernière vérification à ${inbox.lastCheck.toLocaleTimeString('fr-FR')} · toutes les ${s.notif.interval}s` : 'Surveillance en attente…'}
        {' · '}
        {perm === 'granted' ? 'Notifications bureau activées' : perm === 'denied' ? 'Notifications bloquées par le navigateur' : (
          <a className="ext" onClick={() => Notification.requestPermission().then(() => goSettings())}>Activer les notifications bureau</a>
        )}
      </div>
      <div className="card inbox">
        {list.map((n) => (
          <div key={n.id} className={`inbox-item ${n.read ? '' : 'unread'}`} onClick={() => { inbox.markRead(n.id); onOpen(n.key); }}>
            <span className="inbox-ic">{TYPES[n.type]?.icon}</span>
            <div className="grow">
              <div><b>{n.key}</b> {n.title}</div>
              <div className="muted small">{TYPES[n.type]?.label} · {n.detail}{n.priority ? ` · ${n.priority}` : ''} · {fmt(n.at)}</div>
            </div>
            {!n.read && <span className="dot" />}
          </div>
        ))}
        {!list.length && (
          <p className="muted pad">{inbox.items.length ? 'Aucune notification non lue.' : 'Aucune notification pour le moment. Les nouveaux tickets à prendre en charge, tes assignations et les mises à jour des tickets suivis apparaîtront ici.'}</p>
        )}
      </div>
    </div>
  );
}

/* ---------- Assistant IA ---------- */
function Assistant({ s, context, goSettings, onOpen }) {
  const [log, setLog] = useState([]); // {role:'user'|'ai'|'step'|'err', text}
  const [hist, setHist] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef(null);
  const ta = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [log, busy]);
  useEffect(() => {
    if (!ta.current) return;
    ta.current.style.height = 'auto';
    ta.current.style.height = Math.min(ta.current.scrollHeight, 140) + 'px';
  }, [input]);

  const reset = () => { setLog([]); setHist([]); setSessionId(null); };
  useEffect(() => { reset(); }, [s.aiMode]); // eslint-disable-line

  const send = async (text) => {
    if (!text.trim() || busy) return;
    setInput(''); setBusy(true);
    setLog((l) => [...l, { role: 'user', text }]);
    try {
      if (s.aiMode === 'code') {
        const r = await fetch('/api/claude-code/chat', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-jira-url': s.jiraUrl, 'x-jira-email': s.jiraEmail, 'x-jira-token': s.jiraToken, 'x-cds-filter': s.filterId,
          },
          body: JSON.stringify({ prompt: text, sessionId, allowWrite: s.allowWrite, context }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        setSessionId(j.sessionId);
        setLog((l) => [...l, { role: 'ai', text: j.text }]);
      } else {
        const r = await ask(
          s, [...hist, { role: 'user', content: text }], context,
          async (msg) => window.confirm(msg),
          (step) => setLog((l) => [...l, { role: 'step', text: step }]),
        );
        setHist(r.messages);
        setLog((l) => [...l, { role: 'ai', text: r.text }]);
      }
    } catch (e) {
      setLog((l) => [...l, { role: 'err', text: e.message }]);
    } finally { setBusy(false); }
  };

  if (!ready(s)) {
    return <div className="pad stack"><p>Renseigne d'abord ta connexion Jira.</p><button className="primary" onClick={goSettings}>Ouvrir les paramètres</button></div>;
  }
  if (!aiConfigured(s)) {
    return (
      <div className="pad stack">
        <p>Connecte ton IA pour activer l'assistant : <b>{PROVIDERS[s.aiMode]?.label}</b> n'a pas encore de clé.</p>
        <button className="primary" onClick={goSettings}>Ouvrir les paramètres</button>
      </div>
    );
  }
  const suggestions = [
    ['🚨', 'Résume les tickets bloquants et majeurs'],
    ['👤', 'Qui est le plus chargé dans l\'équipe ?'],
    ['⏱', 'Quels tickets risquent de dépasser leur GTR ?'],
    ['📝', 'Prépare un point d\'équipe CDS'],
  ];
  return (
    <div className="chat">
      <div className="chat-log">
        {!log.length && (
          <div className="welcome">
            <div className="bot-big">✦</div>
            <h3>Que puis-je faire pour toi ?</h3>
            <p className="muted small">Je consulte Jira en direct{s.allowWrite ? ' et peux commenter / changer les statuts' : ' (lecture seule)'}.</p>
            {suggestions.map(([ic, x]) => <button key={x} className="sugg" onClick={() => send(x)}><span>{ic}</span>{x}</button>)}
          </div>
        )}
        {log.map((m, i) => {
          if (m.role === 'step') return <div key={i} className="step">⚙ {m.text}</div>;
          if (m.role === 'user') return <div key={i} className="bubble user">{m.text}</div>;
          return (
            <div key={i} className={`ai-row ${m.role}`}>
              <span className="bot">✦</span>
              <div className="bubble ai">{m.role === 'err' ? m.text : <Markdown text={m.text} onOpen={onOpen} />}</div>
            </div>
          );
        })}
        {busy && <div className="ai-row"><span className="bot">✦</span><div className="bubble ai typing"><i /><i /><i /></div></div>}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); send(input); }}>
        <textarea
          ref={ta} rows={1} value={input} onChange={(e) => setInput(e.target.value)}
          placeholder="Demande à Claude…"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); } }}
        />
        <button className="primary send" disabled={busy || !input.trim()} title="Envoyer">↑</button>
      </form>
      {log.length > 0 && <button className="linkbtn" onClick={reset}>Nouvelle conversation</button>}
    </div>
  );
}

/* ---------- Paramètres ---------- */
function ClaudeCodeStatus() {
  const [st, setSt] = useState(null);
  const check = useCallback(async () => {
    setSt({ loading: true });
    try { setSt(await (await fetch('/api/claude-code/status')).json()); } catch (e) { setSt({ error: e.message }); }
  }, []);
  useEffect(() => { check(); }, [check]);
  let cls = 'warn', text = 'Vérification…';
  if (st && !st.loading) {
    if (st.error) { cls = 'bad'; text = `Serveur local injoignable : ${st.error}`; }
    else if (!st.installed) { cls = 'bad'; text = "Claude Code n'est pas installé sur cette machine (voir étape 1)."; }
    else if (!st.loggedIn) { cls = 'warn'; text = `Claude Code ${st.version} installé, mais non connecté (voir étape 2).`; }
    else { cls = 'ok'; text = `Connecté${st.email ? ` : ${st.email}` : ''} · ${st.version}${st.method ? ` · ${st.method}` : ''}`; }
  }
  return (
    <div className={`status ${cls}`}>
      <span>● {text}</span>
      <button onClick={check}>Vérifier</button>
    </div>
  );
}

function Settings({ s, onSave }) {
  const [d, setD] = useState(s);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState('');
  const upd = (patch) => { setD((p) => ({ ...p, ...patch })); setSaved(false); };
  const set = (k) => (e) => upd({ [k]: e.target.value });
  const setKpi = (i, k, v) => upd({ kpis: d.kpis.map((x, j) => (j === i ? { ...x, [k]: v } : x)) });
  const testJira = async () => {
    setTest('Test en cours…');
    try {
      const me = await jira(d, '/rest/api/3/myself');
      setTest(`✓ Connecté en tant que ${me.displayName || me.emailAddress}`);
    } catch (e) { setTest('✗ ' + e.message); }
  };
  return (
    <div className="stack narrow">
      <h1>Paramètres</h1>
      <p className="muted">Ces valeurs sont propres à chaque utilisateur et restent dans le stockage local de ce navigateur. Elles ne sont envoyées qu'au proxy local pour appeler Jira et Claude.</p>

      <section className="card stack">
        <h2>Apparence</h2>
        <div className="row gap wrap">
          {THEMES.map(([k, l]) => (
            <button key={k} className={d.theme === k ? 'primary' : ''} onClick={() => { upd({ theme: k }); applyTheme(k); }}>{{ system: '🖥', light: '☀', dark: '🌙' }[k]} {l}</button>
          ))}
        </div>
        <p className="muted small">« Système » suit le réglage clair/sombre de Windows.</p>
      </section>

      <section className="card stack">
        <h2>Jira</h2>
        <label>URL du site<input value={d.jiraUrl} onChange={set('jiraUrl')} placeholder="https://xxx.atlassian.net" /></label>
        <label>Email Atlassian<input value={d.jiraEmail} onChange={set('jiraEmail')} /></label>
        <label>Token API Jira<input type="password" value={d.jiraToken} onChange={set('jiraToken')} autoComplete="off" />
          <span className="muted small">Créer un token : id.atlassian.com → Sécurité → Jetons API</span></label>
        <div className="row gap"><button onClick={testJira}>Tester la connexion</button><span className="small">{test}</span></div>
        {/fetch/i.test(test) && (
          <div className="stack hint">
            <p className="small warn-t">Le serveur local ne répond pas. Si les scripts PowerShell sont bloqués par Windows, autorise-les puis relance l'application :</p>
            <PowerShellFix compact />
          </div>
        )}
      </section>

      <section className="card stack">
        <h2>Assistant IA</h2>
        <p className="muted small">Choisis le fournisseur que tu utilises. Chacun branche sa propre IA : seul le fournisseur choisi est appelé.</p>
        <div className="row gap wrap">
          {Object.entries(PROVIDERS).map(([k, p]) => (
            <button key={k} className={d.aiMode === k ? 'primary' : ''} onClick={() => upd({ aiMode: k })}>{p.label}</button>
          ))}
        </div>
        {d.aiMode === 'code' && (
          <>
            <ClaudeCodeStatus />
            <label className="row gap check">
              <input type="checkbox" checked={d.allowWrite} onChange={(e) => upd({ allowWrite: e.target.checked })} />
              <span>Autoriser Claude à commenter et changer le statut des tickets (désactivé = lecture seule)</span>
            </label>
            <details className="howto" open>
              <summary>Comment connecter Claude Code (à faire une fois par personne)</summary>
              <ol>
                <li><b>Installer Claude Code</b> — dans PowerShell : <code>irm https://claude.ai/install.ps1 | iex</code><br />
                  <span className="muted small">Alternative avec Node.js : <code>npm install -g @anthropic-ai/claude-code</code></span></li>
                <li><b>Se connecter</b> — dans un terminal, lancer <code>claude</code>, puis suivre le lien de connexion avec son compte Claude (abonnement Pro, Max, Team ou Enterprise). Vérifier avec <code>claude auth status</code>.</li>
                <li><b>Lancer cette application sur sa propre machine</b> — <code>npm install</code> puis <code>npm start</code>, et ouvrir <code>http://127.0.0.1:8787</code>. Claude Code utilise la session de la personne qui a lancé l'application.</li>
                <li><b>Renseigner Jira</b> ci-dessus (URL, email, token API), puis cliquer sur « Vérifier » : le statut doit passer au vert.</li>
              </ol>
            </details>
          </>
        )}
        {d.aiMode === 'api' && (
          <>
            <label>Clé API Anthropic<input type="password" value={d.claudeKey} onChange={set('claudeKey')} autoComplete="off" placeholder="sk-ant-…" /></label>
            <label>Modèle<input value={d.claudeModel} onChange={set('claudeModel')} /></label>
          </>
        )}
        {d.aiMode === 'openai' && <ProviderKeyForm s={d} provider="openai" upd={upd} placeholder="sk-…" help="platform.openai.com → API keys" />}
        {d.aiMode === 'gemini' && <ProviderKeyForm s={d} provider="gemini" upd={upd} placeholder="AIza…" help="aistudio.google.com → Get API key" />}
        {d.aiMode === 'groq' && (
          <>
            <details className="howto" open>
              <summary>Tutoriel : créer sa clé Groq gratuite (2 minutes)</summary>
              <ol>
                <li>Ouvre <a className="ext" href="https://console.groq.com" target="_blank" rel="noreferrer">console.groq.com ↗</a> et crée un compte (connexion avec Google, GitHub ou email). <b>Aucune carte bancaire</b> n'est demandée pour l'offre gratuite.</li>
                <li>Dans le menu, clique sur <b>API Keys</b> puis <b>Create API Key</b>. Donne-lui un nom (ex. « Team-IT CDS »).</li>
                <li>Copie la clé affichée, qui commence par <code>gsk_</code>. <b>Elle ne sera plus visible ensuite.</b></li>
                <li>Colle-la ci-dessous, clique sur <b>Tester la clé / charger les modèles</b>, choisis un modèle, puis <b>Enregistrer</b>.</li>
              </ol>
              <p className="muted small">Offre gratuite : des limites de requêtes et de jetons par minute et par jour s'appliquent. Si tu reçois une erreur « rate limit », attends une minute ou choisis un modèle plus léger. Les contenus des tickets que tu soumets à l'assistant sont envoyés à Groq : à éviter pour des données sensibles.</p>
            </details>
            <ProviderKeyForm s={d} provider="groq" upd={upd} placeholder="gsk_…" help="console.groq.com → API Keys" />
          </>
        )}
        {d.aiMode !== 'code' && (
          <p className="muted small">La clé reste dans le stockage local de ce navigateur et n'est envoyée qu'au proxy local, qui la transmet au fournisseur. Les écritures dans Jira (commentaire, statut) demandent une confirmation.</p>
        )}
      </section>

      <section className="card stack">
        <h2>Tableau de bord</h2>
        <label>ID du filtre Jira « en cours CDS »<input value={d.filterId} onChange={set('filterId')} /></label>
        <label>JQL de la liste du dashboard<input className="mono" value={d.baseJql} onChange={set('baseJql')} /></label>
        <label>Champ date d'action planifiée (ID)<input value={d.plannedFieldId} onChange={set('plannedFieldId')} placeholder="customfield_10546" /></label>
        <h3>Compteurs (mêmes requêtes que les gadgets Jira)</h3>
        {d.kpis.map((k, i) => (
          <div className="row gap" key={i}>
            <select value={k.group || 'tickets'} onChange={(e) => setKpi(i, 'group', e.target.value)}>
              <option value="tickets">Tickets</option><option value="sla">Prise en charge</option>
            </select>
            <input style={{ width: 170 }} value={k.label} onChange={(e) => setKpi(i, 'label', e.target.value)} />
            <input className="grow mono" value={k.jql} onChange={(e) => setKpi(i, 'jql', e.target.value)} />
            <button onClick={() => upd({ kpis: d.kpis.filter((_, j) => j !== i) })}>✕</button>
          </div>
        ))}
        <div className="row gap">
          <button onClick={() => upd({ kpis: [...d.kpis, { group: 'tickets', label: 'Nouveau', tone: 'blue', jql: `filter = ${d.filterId}` }] })}>+ Ajouter un compteur</button>
          <button onClick={() => upd({ kpis: DEFAULTS.kpis })}>Réinitialiser</button>
        </div>
      </section>

      <section className="card stack">
        <h2>Réponses standardisées</h2>
        <p className="muted small">Modèles proposés dans « Répondre au client ». Variables : <code>{'{{prenom}}'}</code> (demandeur), <code>{'{{ticket}}'}</code> (clé du ticket), <code>{'{{agent}}'}</code> (toi). Le texte reste modifiable avant l'envoi.</p>
        {(d.replies || []).map((r, i) => (
          <div key={r.id} className="reply-edit">
            <div className="row gap">
              <input className="grow" value={r.title} placeholder="Titre du modèle" onChange={(e) => upd({ replies: d.replies.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} />
              <button onClick={() => upd({ replies: d.replies.filter((_, j) => j !== i) })} title="Supprimer ce modèle">✕</button>
            </div>
            <textarea className="commentbox" rows={6} value={r.text} onChange={(e) => upd({ replies: d.replies.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} />
          </div>
        ))}
        <div className="row gap wrap">
          <button onClick={() => upd({ replies: [...(d.replies || []), { id: `r${Date.now()}`, title: 'Nouveau modèle', text: `Bonjour {{prenom}},\n\n\n\nCordialement,\n{{agent}}` }] })}>+ Ajouter un modèle</button>
          <button onClick={() => upd({ replies: DEFAULT_REPLIES })}>Réinitialiser les modèles</button>
        </div>
      </section>

      <section className="card stack">
        <h2>Notifications</h2>
        <label className="row gap check">
          <input type="checkbox" checked={d.notif.enabled} onChange={(e) => upd({ notif: { ...d.notif, enabled: e.target.checked } })} />
          <span>Notification sur le PC quand un ticket est à prendre en charge, m'est assigné ou est mis à jour</span>
        </label>
        {Object.entries(TYPES).map(([k, t]) => (
          <label key={k} className="row gap check">
            <input type="checkbox" checked={!!d.notif.types[k]} onChange={(e) => upd({ notif: { ...d.notif, types: { ...d.notif.types, [k]: e.target.checked } } })} />
            <span>{t.icon} {t.label}</span>
          </label>
        ))}
        <label className="row gap check">
          <input type="checkbox" checked={d.notif.sound} onChange={(e) => upd({ notif: { ...d.notif, sound: e.target.checked } })} />
          <span>Jouer un son</span>
        </label>
        <label>Vérifier toutes les (secondes)
          <input type="number" min="30" value={d.notif.interval} onChange={(e) => upd({ notif: { ...d.notif, interval: e.target.value } })} />
        </label>
        <label>JQL des tickets « à prendre en charge »<input className="mono" value={d.todoJql} onChange={set('todoJql')} /></label>
        <div className="row gap wrap">
          <button onClick={() => Notification.requestPermission().then(() => setSaved(false))} disabled={!notifSupported()}>Autoriser les notifications du navigateur</button>
          <button onClick={() => showDesktop('Team-IT CDS', 'Test : les notifications fonctionnent ✅')} disabled={!notifSupported()}>Envoyer un test</button>
          <span className="small muted">{notifSupported() ? `État : ${Notification.permission}` : 'Non supporté par ce navigateur'}</span>
        </div>
      </section>

      <section className="card stack">
        <h2>Documentation (Confluence)</h2>
        <p className="muted small">Claude cherche dans <b>tout Confluence</b> (tous les espaces accessibles à ton compte). L'espace et la page ci-dessous ne sont que son point de départ.</p>
        <label>Espace de départ (clé)<input value={d.docSpace} onChange={set('docSpace')} /></label>
        <label>ID de la page de départ « Gestion des incidents »<input value={d.docRootPageId} onChange={set('docRootPageId')} /></label>
        <label className="row gap check">
          <input type="checkbox" checked={d.autoDoc} onChange={(e) => upd({ autoDoc: e.target.checked })} />
          <span>Chercher et afficher automatiquement la documentation quand j'ouvre un ticket
            <span className="muted small"> (recherche directe dans Confluence, sans IA ni token ; l'aide de l'IA reste à la demande)</span></span>
        </label>
      </section>

      <section className="card stack">
        <h2>Dépannage</h2>
        <NetDiag s={d} />
        <hr className="sep" />
        <PowerShellFix />
      </section>

      <InstallCard />

      <div className="row gap">
        <button className="primary" onClick={() => { onSave(d); setSaved(true); }}>Enregistrer</button>
        {saved && <span className="small">✓ Enregistré</span>}
      </div>
    </div>
  );
}

// Diagnostic réseau : teste l'accès à Jira et aux IA, avec la cause exacte en cas d'échec.
function NetDiag({ s }) {
  const [r, setR] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/system/diagnose', { headers: { 'x-jira-url': s.jiraUrl } });
      setR(await res.json());
    } catch (e) { setR({ unreachable: e.message }); } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <div className="row gap wrap">
        <button onClick={run} disabled={busy}>{busy ? 'Test en cours…' : '🌐 Diagnostic réseau'}</button>
        <span className="muted small">Teste l'accès à Jira et aux fournisseurs d'IA depuis ce PC.</span>
      </div>
      {r?.unreachable && <div className="status bad"><span>● Serveur local injoignable ({r.unreachable}). Quitte l'application (icône près de l'horloge) puis rouvre-la.</span></div>}
      {r?.results && (
        <div className="stack">
          {r.results.map((x) => (
            <div key={x.name} className={`status ${x.ok ? 'ok' : 'bad'}`}>
              <span>{x.ok ? '●' : '✗'} <b>{x.name}</b> : {x.ok ? `joignable (HTTP ${x.status}, ${x.ms} ms)` : x.error}</span>
            </div>
          ))}
          <p className="muted small">Mode : {r.engine}{r.proxy ? ` · proxy détecté : ${r.proxy}` : ' · accès direct'}</p>
        </div>
      )}
    </div>
  );
}

// Bouton « Autoriser les scripts PowerShell » : lance Set-ExecutionPolicy pour l'utilisateur courant.
function PowerShellFix({ compact }) {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const call = useCallback(async (apply) => {
    setBusy(true);
    try {
      if (window.desktop?.powershellPolicy) setSt(await window.desktop.powershellPolicy(apply));
      else setSt(await (await fetch('/api/system/powershell-policy', { method: apply ? 'POST' : 'GET' })).json());
    } catch (e) { setSt({ unreachable: true, error: e.message }); } finally { setBusy(false); }
  }, []);
  useEffect(() => { if (!compact) call(false); }, [call, compact]);

  let status = null;
  if (st?.unreachable) status = <div className="status bad"><span>● Serveur local injoignable ({st.error}). Quitte l'application (icône près de l'horloge → Quitter) puis rouvre-la.</span></div>;
  else if (st?.error && !st.effective) status = <div className="status bad"><span>● {st.error}</span></div>;
  else if (st?.effective) {
    if (st.ok) status = <div className="status ok"><span>● Scripts PowerShell autorisés (politique : {st.effective}).</span></div>;
    else if (st.locked) status = <div className="status warn"><span>● Politique « {st.effective} » imposée par l'entreprise : elle ne peut pas être modifiée ici. Contacte le support informatique.</span></div>;
    else status = <div className="status warn"><span>● Scripts bloqués (politique : {st.effective}).</span></div>;
    if (st.error && !st.ok) status = <>{status}<div className="banner err small">{st.error}</div></>;
  }
  return (
    <div className="stack">
      {!compact && <p className="muted small">Si des scripts de l'application (installation, lancement) sont bloqués par Windows, ce bouton exécute : <code>Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force</code>. Aucun droit administrateur requis, effet limité à ton compte.</p>}
      {status}
      <div className="row gap wrap">
        <button className="primary" onClick={() => call(true)} disabled={busy}>{busy ? '…' : '🛡 Autoriser les scripts PowerShell'}</button>
        {!compact && <button onClick={() => call(false)} disabled={busy}>Revérifier</button>}
      </div>
    </div>
  );
}

function ProviderKeyForm({ s, provider, upd, placeholder, help }) {
  const keyField = `${provider}Key`;
  const modelField = `${provider}Model`;
  const [models, setModels] = useState([]);
  const [msg, setMsg] = useState('');
  const load = async () => {
    setMsg('Chargement des modèles…');
    try {
      const list = await listModels(s, provider);
      setModels(list);
      setMsg(list.length ? `✓ Clé valide · ${list.length} modèle(s) disponible(s)` : 'Aucun modèle compatible trouvé.');
    } catch (e) { setMsg('✗ ' + e.message); }
  };
  return (
    <>
      <label>Clé API {{ openai: 'OpenAI', gemini: 'Google (Gemini)', groq: 'Groq' }[provider]}
        <input type="password" value={s[keyField]} onChange={(e) => upd({ [keyField]: e.target.value })} autoComplete="off" placeholder={placeholder} />
        <span className="muted small">Créer une clé : {help}</span>
      </label>
      <label>Modèle
        <input list={`models-${provider}`} value={s[modelField]} onChange={(e) => upd({ [modelField]: e.target.value })} />
        <datalist id={`models-${provider}`}>{models.map((m) => <option key={m} value={m} />)}</datalist>
      </label>
      <div className="row gap wrap">
        <button onClick={load} disabled={!s[keyField]}>Tester la clé / charger les modèles</button>
        <span className="small">{msg}</span>
      </div>
    </>
  );
}

/* ---------- Installation locale ---------- */
function InstallCard() {
  const desktop = !!window.desktop?.isDesktop;
  const [auto, setAuto] = useState(null);
  useEffect(() => { if (desktop) window.desktop.autostart().then(setAuto).catch(() => {}); }, [desktop]);
  const [evt, setEvt] = useState(null);
  const [installed, setInstalled] = useState(() => window.matchMedia?.('(display-mode: standalone)').matches);
  useEffect(() => {
    const onPrompt = (e) => { e.preventDefault(); setEvt(e); };
    const onInstalled = () => { setInstalled(true); setEvt(null); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => { window.removeEventListener('beforeinstallprompt', onPrompt); window.removeEventListener('appinstalled', onInstalled); };
  }, []);
  if (desktop) {
    return (
      <section className="card stack">
        <h2>Application de bureau</h2>
        <div className="status ok"><span>● Application installée : rien d'autre à installer. Le serveur est intégré.</span></div>
        <label className="row gap check">
          <input type="checkbox" checked={!!auto} disabled={auto === null} onChange={async (e) => setAuto(await window.desktop.autostart(e.target.checked))} />
          <span>Lancer automatiquement au démarrage de Windows (réduite près de l'horloge, pour ne manquer aucune notification)</span>
        </label>
        <p className="muted small">Seul l'assistant IA demande un réglage : Claude Code installé et connecté, ou une clé API ChatGPT / Gemini (voir « Assistant IA »).</p>
      </section>
    );
  }
  return (
    <section className="card stack">
      <h2>Installer l'application sur ce PC</h2>
      {installed ? (
        <div className="status ok"><span>● Application installée : tu l'utilises en mode application.</span></div>
      ) : (
        <>
          <p className="muted small">La version web continue de fonctionner. L'installation ajoute une icône et une fenêtre dédiée, sans barre d'onglets.</p>
          <div className="row gap wrap">
            <button className="primary" disabled={!evt} onClick={async () => { evt.prompt(); await evt.userChoice; setEvt(null); }}>
              Installer comme application
            </button>
            {!evt && <span className="small muted">Indisponible ici : utilise le menu Chrome/Edge ⋮ → « Installer Team-IT CDS », ou le script ci-dessous.</span>}
          </div>
        </>
      )}
      <details className="howto">
        <summary>Installation complète sur Windows (serveur local + raccourci bureau)</summary>
        <ol>
          <li>Ouvre le dossier de l'application et double-clique sur <code>install.cmd</code>.</li>
          <li>Le script installe les dépendances, construit l'application et crée le raccourci <b>Team-IT CDS</b> sur le bureau.</li>
          <li>Option : démarrage automatique à l'ouverture de session (le script te le propose).</li>
          <li>Pour la partie assistant, Claude Code doit être installé et connecté (voir plus haut).</li>
        </ol>
        <p className="muted small">Les notifications nécessitent que l'application soit ouverte (fenêtre ou onglet).</p>
      </details>
    </section>
  );
}

function Empty({ onClick }) {
  return (
    <div className="card center stack">
      <h2>Bienvenue</h2>
      <p className="muted">Renseigne ton URL Jira, ton email et ton token API pour afficher ton tableau de bord.</p>
      <button className="primary" onClick={onClick}>Ouvrir les paramètres</button>
    </div>
  );
}

/* ---------- App ---------- */
export default function App() {
  const [s, setS] = useState(loadSettings);
  const [page, setPage] = useState(ready(loadSettings()) ? 'dashboard' : 'settings');
  const [open, setOpen] = useState(null);
  const [ai, setAi] = useState(true);
  const [rev, setRev] = useState(0);
  const [tix, setTix] = useState(null); // { jql, title, person, n }
  const save = (n) => { saveSettings(n); setS(n); setRev((r) => r + 1); };
  const inbox = useInbox(s, (key) => { setOpen(key); });
  useEffect(() => { applyTheme(s.theme); }, [s.theme]);
  const cycleTheme = () => {
    const order = THEMES.map(([k]) => k);
    save({ ...s, theme: order[(order.indexOf(s.theme) + 1) % order.length] });
  };
  useEffect(() => {
    document.title = `${inbox.unread ? `(${inbox.unread}) ` : ''}Team-IT · CDS`;
  }, [inbox.unread]);

  const goJql = useCallback((jql, title, p) => { setTix({ jql, title, person: p, n: Date.now() }); setPage('tickets'); setOpen(null); }, []);
  const goPerson = useCallback((p) => {
    const jql = p.id
      ? `filter = ${s.filterId} AND assignee = "${p.id}" ORDER BY updated DESC`
      : `filter = ${s.filterId} AND assignee is EMPTY ORDER BY priority ASC, updated DESC`;
    goJql(jql, p.id ? `Tickets de ${p.name}` : 'Tickets non assignés', p);
  }, [s.filterId, goJql]);

  const context = useMemo(
    () => `Page « ${page} »${open ? `, ticket ouvert ${open}` : ''}${tix && page === 'tickets' ? `, liste filtrée (${tix.title})` : ''}. Filtre CDS : filter = ${s.filterId}.`,
    [page, open, tix, s.filterId],
  );

  const nav = [['dashboard', 'Tableau de bord'], ['inbox', 'Boîte de réception'], ['tickets', 'Tickets'], ['settings', 'Paramètres']];
  return (
    <div className={`shell ${ai ? 'with-ai' : ''}`}>
      <nav className="side">
        <div className="logo">Team<span>-IT</span> <small>CDS</small></div>
        {nav.map(([k, l]) => (
          <a key={k} className={page === k ? 'on' : ''} onClick={() => { if (k === 'tickets' && page !== 'tickets') setTix(null); setOpen(null); setPage(k); }}>
            {l}{k === 'inbox' && inbox.unread > 0 && <span className="badge">{inbox.unread}</span>}
          </a>
        ))}
        <div className="grow" />
        <a onClick={cycleTheme} title="Changer de thème">{{ system: '🖥 Thème : système', light: '☀ Thème : clair', dark: '🌙 Thème : sombre' }[s.theme] || '🖥 Thème : système'}</a>
        <a onClick={() => setAi(!ai)}>{ai ? 'Masquer' : 'Afficher'} l'assistant</a>
      </nav>
      <main>
        {ready(s) && <GlobalSearch s={s} onOpen={setOpen} onResults={(jql, title) => goJql(jql, title)} />}
        {open && <IssueView key={open} s={s} issueKey={open} onClose={() => setOpen(null)} onChanged={() => setRev((r) => r + 1)} onPerson={goPerson} />}
        <div key={rev} className="page" hidden={!!open}>
          {page === 'dashboard' && <Dashboard s={s} onOpen={setOpen} onPerson={goPerson} onJql={goJql} goSettings={() => setPage('settings')} />}
          {page === 'tickets' && <TicketsPage key={tix?.n || 'base'} s={s} preset={tix} onOpen={setOpen} onPerson={goPerson} goSettings={() => setPage('settings')} />}
          {page === 'inbox' && <InboxPage inbox={inbox} s={s} onOpen={setOpen} goSettings={() => setPage('settings')} />}
          {page === 'settings' && <Settings s={s} onSave={save} />}
        </div>
      </main>
      {ai && (
        <section className="ai">
          <div className="ai-h"><span className="bot">✦</span> Assistant IA <small className="muted">{PROVIDERS[s.aiMode]?.short}</small></div>
          <Assistant s={s} context={context} goSettings={() => setPage('settings')} onOpen={setOpen} />
        </section>
      )}
    </div>
  );
}
