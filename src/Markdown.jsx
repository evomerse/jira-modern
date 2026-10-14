import React from 'react';

// Rendu Markdown minimal (titres, listes, tableaux, code, gras) + clés de tickets cliquables.
function inline(text, onOpen, prefix) {
  const out = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|\b([A-Z][A-Z0-9]+-\d+)\b/g;
  let last = 0;
  let n = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${prefix}-${n++}`;
    const [, linkText, href, bold, code, ticket] = m;
    if (href !== undefined) out.push(<a key={key} className="ext" href={href} target="_blank" rel="noreferrer">{linkText} ↗</a>);
    else if (bold !== undefined) out.push(<strong key={key}>{inline(bold, onOpen, key)}</strong>);
    else if (code !== undefined) out.push(<code key={key}>{code}</code>);
    else out.push(<a key={key} className="tk" onClick={() => onOpen?.(ticket)}>{ticket}</a>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export default function Markdown({ text, onOpen }) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (l.startsWith('```')) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      blocks.push(<pre key={blocks.length} className="md-code">{buf.join('\n')}</pre>);
    } else if (/^\s*\|/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const head = cells(l);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={blocks.length} className="md-table">
          <table>
            <thead><tr>{head.map((h, k) => <th key={k}>{inline(h, onOpen, `h${k}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r, a) => <tr key={a}>{r.map((c, b) => <td key={b}>{inline(c, onOpen, `c${a}-${b}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
    } else if (/^\s*([-*•])\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l)) {
      const ordered = /^\s*\d+[.)]\s+/.test(l);
      const items = [];
      const re = ordered ? /^\s*\d+[.)]\s+/ : /^\s*([-*•])\s+/;
      while (i < lines.length && re.test(lines[i])) items.push(lines[i++].replace(re, ''));
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(<Tag key={blocks.length}>{items.map((t, k) => <li key={k}>{inline(t, onOpen, `li${k}`)}</li>)}</Tag>);
    } else if (/^#{1,4}\s+/.test(l)) {
      blocks.push(<h4 key={blocks.length}>{inline(l.replace(/^#{1,4}\s+/, ''), onOpen, 'h')}</h4>);
      i++;
    } else {
      const buf = [lines[i++]];
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*\|)/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) buf.push(lines[i++]);
      blocks.push(<p key={blocks.length}>{inline(buf.join(' '), onOpen, `p${blocks.length}`)}</p>);
    }
  }
  return <div className="md">{blocks}</div>;
}
