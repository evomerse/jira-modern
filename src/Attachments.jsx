import React, { useCallback, useEffect, useRef, useState } from 'react';
import { jiraBlobRaw } from './api.js';

const isImage = (a) => /^image\//.test(a.mimeType || '');
const isPdf = (a) => a.mimeType === 'application/pdf' || /\.pdf$/i.test(a.filename || '');
const isVideo = (a) => /^video\//.test(a.mimeType || '');
const isAudio = (a) => /^audio\//.test(a.mimeType || '');
const isText = (a) =>
  /^text\//.test(a.mimeType || '') ||
  /(json|xml|csv|log|yaml|yml|ini|conf|md|txt|sql|ps1|bat|sh)$/i.test(a.filename || '') ||
  ['application/json', 'application/xml'].includes(a.mimeType);

const icon = (a) => {
  if (isImage(a)) return '🖼';
  if (isPdf(a)) return '📕';
  if (isVideo(a)) return '🎞';
  if (isAudio(a)) return '🎵';
  if (/zip|rar|7z|tar|gz/i.test(a.filename || '')) return '🗜';
  if (/\.(xlsx?|csv)$/i.test(a.filename || '')) return '📊';
  if (/\.(docx?|rtf|odt)$/i.test(a.filename || '')) return '📝';
  if (/\.(pptx?)$/i.test(a.filename || '')) return '📽';
  if (/\.(msg|eml)$/i.test(a.filename || '')) return '✉';
  return '📄';
};

const size = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);

function Thumb({ s, a }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    if (!isImage(a)) return undefined;
    let url; let live = true;
    jiraBlobRaw(s, `/rest/api/3/attachment/thumbnail/${a.id}?fallback=true`)
      .then((b) => { if (live) { url = URL.createObjectURL(b); setSrc(url); } })
      .catch(() => {});
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [s, a.id]); // eslint-disable-line
  return src ? <img src={src} alt={a.filename} /> : <span className="att-ic">{icon(a)}</span>;
}

// Visionneuse plein écran : image, PDF, texte, vidéo, audio ; sinon téléchargement.
function Viewer({ s, items, index, onIndex, onClose }) {
  const a = items[index];
  const [state, setState] = useState({ loading: true });
  const urlRef = useRef(null);

  useEffect(() => {
    let live = true;
    setState({ loading: true });
    (async () => {
      try {
        const blob = await jiraBlobRaw(s, `/rest/api/3/attachment/content/${a.id}`);
        if (!live) return;
        const typed = blob.type && blob.type !== 'application/octet-stream' ? blob : new Blob([blob], { type: a.mimeType || 'application/octet-stream' });
        if (isText(a) && typed.size < 400000) {
          setState({ text: await typed.text(), blob: typed });
        } else {
          urlRef.current = URL.createObjectURL(typed);
          setState({ url: urlRef.current, blob: typed });
        }
      } catch (e) { if (live) setState({ error: e.message }); }
    })();
    return () => { live = false; if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; } };
  }, [s, a.id]); // eslint-disable-line

  const prev = useCallback(() => onIndex((index - 1 + items.length) % items.length), [index, items.length, onIndex]);
  const next = useCallback(() => onIndex((index + 1) % items.length), [index, items.length, onIndex]);
  useEffect(() => {
    const k = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'ArrowRight') next();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [prev, next, onClose]);

  const download = () => {
    if (!state.blob) return;
    const u = URL.createObjectURL(state.blob);
    const l = document.createElement('a');
    l.href = u; l.download = a.filename;
    document.body.appendChild(l); l.click(); l.remove();
    setTimeout(() => URL.revokeObjectURL(u), 2000);
  };

  let body;
  if (state.loading) body = <div className="viewer-msg">Chargement de « {a.filename} »…</div>;
  else if (state.error) body = <div className="viewer-msg err-t">Impossible de charger le fichier : {state.error}</div>;
  else if (state.text != null) body = <pre className="viewer-text">{state.text}</pre>;
  else if (isImage(a)) body = <img className="viewer-img" src={state.url} alt={a.filename} />;
  else if (isPdf(a)) body = <iframe className="viewer-frame" src={state.url} title={a.filename} />;
  else if (isVideo(a)) body = <video className="viewer-video" src={state.url} controls autoPlay />;
  else if (isAudio(a)) body = <audio src={state.url} controls autoPlay />;
  else {
    body = (
      <div className="viewer-msg">
        <div className="att-big">{icon(a)}</div>
        <p>Ce type de fichier ne peut pas être affiché dans l'application.</p>
        <button className="primary" onClick={download}>Télécharger {a.filename}</button>
      </div>
    );
  }

  return (
    <div className="viewer-bg" onClick={onClose}>
      <div className="viewer" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-head">
          <div className="grow">
            <b>{a.filename}</b>
            <span className="muted small"> · {size(a.size || 0)}{a.author?.displayName ? ` · ${a.author.displayName}` : ''} · {index + 1}/{items.length}</span>
          </div>
          {items.length > 1 && <><button onClick={prev} title="Précédent (←)">‹</button><button onClick={next} title="Suivant (→)">›</button></>}
          <button onClick={download} disabled={!state.blob}>Télécharger</button>
          <button onClick={onClose} title="Fermer (Échap)">✕</button>
        </div>
        <div className="viewer-body">{body}</div>
      </div>
    </div>
  );
}

export default function Attachments({ s, items }) {
  const [open, setOpen] = useState(null);
  if (!items?.length) return null;
  return (
    <section className="card">
      <h2>Pièces jointes ({items.length})</h2>
      <div className="att-grid">
        {items.map((a, i) => (
          <button key={a.id} className="att" onClick={() => setOpen(i)} title={a.filename}>
            <div className="att-thumb"><Thumb s={s} a={a} /></div>
            <div className="att-name">{a.filename}</div>
            <div className="muted small">{size(a.size || 0)}</div>
          </button>
        ))}
      </div>
      {open != null && <Viewer s={s} items={items} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </section>
  );
}
