import { useCallback, useEffect, useRef, useState } from 'react';
import { searchIssues } from './api.js';

const INBOX_KEY = 'jira-modern.inbox.v1';
const SNAP_KEY = 'jira-modern.snapshot.v1';
const FIELDS = ['summary', 'status', 'priority', 'assignee', 'updated'];

const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } };

export const TYPES = {
  new: { icon: '🆕', label: 'Nouveau ticket à prendre en charge' },
  assigned: { icon: '👤', label: 'Ticket qui vous est assigné' },
  updated: { icon: '🔄', label: 'Mise à jour d\'un ticket suivi' },
};

export const notifSupported = () => typeof Notification !== 'undefined';

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; g.gain.value = 0.06;
    o.start(); o.stop(ctx.currentTime + 0.18);
  } catch { /* audio indisponible */ }
}

export function showDesktop(title, body, onClick) {
  if (!notifSupported() || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag: title + body, requireInteraction: false });
    n.onclick = () => { window.desktop?.show?.(); window.focus(); onClick?.(); n.close(); };
  } catch { /* notification refusée */ }
}

/**
 * Surveille Jira (tickets à prendre en charge, assignés à moi, suivis) et alimente la boîte de réception.
 * Le premier passage sert de référence : il ne notifie rien.
 */
export function useInbox(s, onOpen) {
  const [items, setItems] = useState(() => read(INBOX_KEY, []));
  const [lastCheck, setLastCheck] = useState(null);
  const [error, setError] = useState('');
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  const persist = (next) => { setItems(next); write(INBOX_KEY, next); };

  const check = useCallback(async () => {
    if (!s.jiraUrl || !s.jiraEmail || !s.jiraToken) return;
    const n = s.notif;
    try {
      const [todo, mine, watched] = await Promise.all([
        searchIssues(s, s.todoJql, FIELDS, 50),
        searchIssues(s, 'assignee = currentUser() AND resolution = Unresolved', FIELDS, 50),
        searchIssues(s, 'watcher = currentUser() AND resolution = Unresolved AND updated >= -7d', FIELDS, 50).catch(() => []),
      ]);
      const snap = read(SNAP_KEY, null);
      const now = { todo: {}, mine: {}, watched: {} };
      const fresh = [];
      const info = (i) => ({ updated: i.fields.updated, status: i.fields.status?.name });
      const mk = (type, i, detail) => ({
        id: `${type}:${i.key}:${i.fields.updated}`, type, key: i.key, title: i.fields.summary, detail,
        priority: i.fields.priority?.name, at: new Date().toISOString(), read: false,
      });

      todo.forEach((i) => { now.todo[i.key] = info(i); if (snap && !snap.todo[i.key]) fresh.push(mk('new', i, 'À prendre en charge')); });
      mine.forEach((i) => {
        now.mine[i.key] = info(i);
        if (!snap) return;
        const old = snap.mine[i.key];
        if (!old) fresh.push(mk('assigned', i, 'Assigné à vous'));
        else if (old.status !== i.fields.status?.name) fresh.push(mk('updated', i, `Statut : ${old.status} → ${i.fields.status?.name}`));
        else if (old.updated !== i.fields.updated) fresh.push(mk('updated', i, 'Ticket mis à jour'));
      });
      watched.forEach((i) => {
        now.watched[i.key] = info(i);
        if (!snap || now.mine[i.key]) return;
        const old = snap.watched[i.key];
        if (old && old.updated !== i.fields.updated) {
          fresh.push(mk('updated', i, old.status !== i.fields.status?.name ? `Statut : ${old.status} → ${i.fields.status?.name}` : 'Ticket suivi mis à jour'));
        }
      });
      write(SNAP_KEY, now);

      const wanted = fresh.filter((f) => n.types[f.type]);
      if (wanted.length) {
        setItems((cur) => {
          const have = new Set(cur.map((x) => x.id));
          const next = [...wanted.filter((w) => !have.has(w.id)), ...cur].slice(0, 200);
          write(INBOX_KEY, next);
          return next;
        });
        if (n.enabled) {
          wanted.slice(0, 3).forEach((w) => showDesktop(`${TYPES[w.type].icon} ${w.key}`, `${w.title}\n${w.detail}`, () => openRef.current?.(w.key)));
          if (wanted.length > 3) showDesktop('Team-IT CDS', `+ ${wanted.length - 3} autre(s) notification(s)`);
          if (n.sound) beep();
        }
      }
      setError('');
      setLastCheck(new Date());
    } catch (e) {
      setError(e.message);
    }
  }, [s]);

  useEffect(() => {
    if (!s.jiraUrl || !s.jiraEmail || !s.jiraToken) return undefined;
    check();
    const h = setInterval(check, Math.max(30, Number(s.notif.interval) || 60) * 1000);
    return () => clearInterval(h);
  }, [check, s.notif.interval, s.jiraUrl, s.jiraEmail, s.jiraToken]);

  const markRead = (id) => persist(items.map((x) => (x.id === id ? { ...x, read: true } : x)));
  const markAll = () => persist(items.map((x) => ({ ...x, read: true })));
  const clear = () => persist([]);
  return { items, unread: items.filter((x) => !x.read).length, lastCheck, error, check, markRead, markAll, clear };
}
