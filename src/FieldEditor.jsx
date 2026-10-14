import React, { useEffect, useState } from 'react';
import { adfToText, searchUsers } from './api.js';

/* Édition générique des champs Jira, pilotée par les métadonnées d'édition (editmeta / transition fields). */

// Texte → document ADF (paragraphes + retours à la ligne).
export function toAdf(text) {
  const paragraphs = String(text).split(/\n{2,}/).map((p) => {
    const content = [];
    p.split('\n').forEach((line, i) => {
      if (i > 0) content.push({ type: 'hardBreak' });
      if (line) content.push({ type: 'text', text: line });
    });
    return { type: 'paragraph', content };
  });
  return { type: 'doc', version: 1, content: paragraphs };
}

// Quel éditeur utiliser pour ce champ ? null = non éditable ici.
export function kindOf(meta) {
  const sc = meta?.schema || {};
  const { type: t, system: sys } = sc;
  const cus = sc.custom || '';
  const av = meta.allowedValues;
  if (sys === 'description' || sys === 'environment' || cus.endsWith(':textarea')) return 'adf';
  if (t === 'string') return 'string';
  if (t === 'number') return 'number';
  if (t === 'date') return 'date';
  if (t === 'datetime') return 'datetime';
  if (t === 'user') return 'user';
  if (t === 'array') {
    if (sc.items === 'string') return 'labels';
    if (av?.length && ['option', 'component', 'version'].includes(sc.items)) return 'multi';
    return null;
  }
  if (av?.length && ['priority', 'option', 'resolution', 'issuetype', 'securitylevel', 'component', 'version'].includes(t)) return 'select';
  return null;
}

const label = (v) => v?.name || v?.value || v?.title || v?.displayName || String(v?.id ?? '');

const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// Valeur actuelle (format Jira) → valeur de brouillon du formulaire.
export function toDraft(kind, v) {
  switch (kind) {
    case 'adf': return adfToText(v).trim();
    case 'string': return v || '';
    case 'number': return v ?? '';
    case 'date': return v || '';
    case 'datetime': return v ? toLocalInput(v) : '';
    case 'user': return v ? { accountId: v.accountId, displayName: v.displayName } : null;
    case 'select': return v?.id || '';
    case 'multi': return (v || []).map((x) => x.id);
    case 'labels': return v || [];
    default: return null;
  }
}

// Brouillon → valeur attendue par l'API Jira.
export function toApi(kind, d) {
  switch (kind) {
    case 'adf': return d && d.trim() ? toAdf(d) : null;
    case 'string': return d;
    case 'number': return d === '' || d == null ? null : Number(d);
    case 'date': return d || null;
    case 'datetime': return d ? new Date(d).toISOString().replace('Z', '+0000') : null;
    case 'user': return d ? { accountId: d.accountId } : null;
    case 'select': return d ? { id: d } : null;
    case 'multi': return (d || []).map((id) => ({ id }));
    case 'labels': return d || [];
    default: return undefined;
  }
}

// Texte d'affichage d'une valeur Jira quelconque.
export function valueText(v) {
  if (v == null || v === '') return '—';
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}T/.test(v) ? new Date(v).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.length ? v.map(valueText).join(', ') : '—';
  if (v.type === 'doc') return adfToText(v).trim() || '—';
  return label(v);
}

function UserPicker({ s, issueKey, value, onChange }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState([]);
  useEffect(() => {
    if (q.trim().length < 2) { setList([]); return undefined; }
    const h = setTimeout(() => searchUsers(s, q, issueKey).then((u) => setList(u.filter((x) => x.active !== false))).catch(() => setList([])), 300);
    return () => clearTimeout(h);
  }, [q, s, issueKey]);
  return (
    <div className="userpick">
      <div className="muted small">Actuel : {value ? value.displayName : 'Non assigné'}</div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher une personne…" />
      <div className="userpick-list">
        <div className="userpick-item" onClick={() => { onChange(null); setQ(''); setList([]); }}>— Non assigné</div>
        {list.map((u) => (
          <div key={u.accountId} className="userpick-item" onClick={() => { onChange({ accountId: u.accountId, displayName: u.displayName }); setQ(''); setList([]); }}>
            {u.displayName}
          </div>
        ))}
      </div>
    </div>
  );
}

function LabelsInput({ value, onChange }) {
  const [text, setText] = useState(value.join(', '));
  return (
    <input
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.split(',').map((x) => x.trim().replace(/\s+/g, '-')).filter(Boolean));
      }}
      placeholder="étiquette1, étiquette2"
    />
  );
}

// Champ de saisie adapté au type du champ Jira.
export function FieldInput({ s, issueKey, meta, kind, value, onChange }) {
  const av = meta.allowedValues || [];
  switch (kind) {
    case 'adf':
      return <textarea className="commentbox" rows={6} value={value} onChange={(e) => onChange(e.target.value)} />;
    case 'string':
      return <input value={value} onChange={(e) => onChange(e.target.value)} />;
    case 'number':
      return <input type="number" value={value} onChange={(e) => onChange(e.target.value)} />;
    case 'date':
      return <input type="date" value={value} onChange={(e) => onChange(e.target.value)} />;
    case 'datetime':
      return <input type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)} />;
    case 'user':
      return <UserPicker s={s} issueKey={issueKey} value={value} onChange={onChange} />;
    case 'select':
      return (
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {!meta.required && <option value="">—</option>}
          {av.map((v) => <option key={v.id} value={v.id}>{label(v)}</option>)}
        </select>
      );
    case 'multi':
      return (
        <div className="multi">
          {av.map((v) => (
            <label key={v.id} className="row gap check">
              <input type="checkbox" checked={value.includes(v.id)} onChange={(e) => onChange(e.target.checked ? [...value, v.id] : value.filter((x) => x !== v.id))} />
              <span>{label(v)}</span>
            </label>
          ))}
        </div>
      );
    case 'labels':
      return <LabelsInput value={value} onChange={onChange} />;
    default:
      return null;
  }
}
