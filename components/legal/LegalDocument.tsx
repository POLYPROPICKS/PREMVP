// components/legal/LegalDocument.tsx
// Server component — no 'use client'

import styles from './LegalDocument.module.css';

interface LegalDocumentProps {
  text: string;
}

type LineKind = 'h1' | 'h2' | 'h3' | 'hr' | 'meta' | 'section' | 'bullet' | 'table' | 'para' | 'empty';

function classifyLine(line: string): LineKind {
  if (!line.trim() || line.trim() === '---') return line.trim() === '---' ? 'hr' : 'empty';
  if (/^### /.test(line)) return 'h3';
  if (/^## /.test(line))  return 'h2';
  if (/^# /.test(line))   return 'h1';
  if (/^\*\*Last [Uu]pdated/i.test(line.trim()) || /^Last [Uu]pdated:/i.test(line.trim())) return 'meta';
  if (/^\d+\.\s/.test(line.trim())) return 'section';
  if (/^[-*]\s/.test(line.trim())) return 'bullet';
  if (/^[·•]\s/.test(line.trim())) return 'bullet';
  if (line.includes(' | ')) return 'table';
  return 'para';
}

/** Strip markdown bold (**text**) and italic (*text*) for plain rendering */
function stripMd(s: string): string {
  return s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').trim();
}

export default function LegalDocument({ text }: LegalDocumentProps) {
  const lines = text.split('\n');
  // first non-empty line = title (strip leading # if markdown)
  const firstContentIdx = lines.findIndex(l => l.trim() && l.trim() !== '---');
  const rawTitle = firstContentIdx >= 0 ? lines[firstContentIdx].trim() : '';
  const title = rawTitle.replace(/^#+\s*/, '');
  const bodyLines = lines.slice(firstContentIdx + 1);

  return (
    <div className={styles.page}>
      <div className={styles.inner}>

        {/* back to home */}
        <a href="/" className={styles.back}>← Back to PolyProPicks</a>

        {/* document title */}
        {title && <h1 className={styles.docTitle}>{stripMd(title)}</h1>}

        {/* body lines */}
        <div className={styles.body}>
          {bodyLines.map((line, i) => {
            const kind = classifyLine(line);
            if (kind === 'empty') return <div key={i} className={styles.spacer} />;
            if (kind === 'hr')    return <hr key={i} className={styles.hr} />;
            if (kind === 'h1')    return <h1 key={i} className={styles.docTitle} style={{marginTop:24}}>{stripMd(line.replace(/^#+\s*/,''))}</h1>;
            if (kind === 'h2')    return <h2 key={i} className={styles.sectionHead}>{stripMd(line.replace(/^##\s*/,''))}</h2>;
            if (kind === 'h3')    return <h3 key={i} className={styles.subHead}>{stripMd(line.replace(/^###\s*/,''))}</h3>;
            if (kind === 'meta')  return <p key={i} className={styles.meta}>{stripMd(line)}</p>;
            if (kind === 'section') return <h2 key={i} className={styles.sectionHead}>{stripMd(line)}</h2>;
            if (kind === 'bullet') {
              const txt = stripMd(line.trim().replace(/^[-·•*]\s*/, ''));
              return (
                <div key={i} className={styles.bullet}>
                  <span className={styles.bulletDot} aria-hidden="true">·</span>
                  <span>{txt}</span>
                </div>
              );
            }
            if (kind === 'table') {
              const [left, right] = line.split(' | ');
              return (
                <div key={i} className={styles.tableRow}>
                  <span className={styles.tableLeft}>{stripMd(left ?? '')}</span>
                  <span className={styles.tableRight}>{stripMd(right ?? '')}</span>
                </div>
              );
            }
            // para — strip markdown bold/italic
            return <p key={i} className={styles.para}>{stripMd(line)}</p>;
          })}
        </div>

        {/* bottom home link */}
        <a href="/" className={styles.back}>← Back to PolyProPicks</a>

      </div>
    </div>
  );
}
