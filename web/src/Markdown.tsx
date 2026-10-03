import type { ReactNode } from 'react';

// Minimal Markdown for coach replies: paragraphs, bullet and numbered lists,
// headings, **bold**, *italic* and `code`. Builds React elements directly (no
// HTML strings), so model output can't inject markup. Unclosed markers, e.g.
// mid-stream, simply show as typed until their closing half arrives.

const INLINE = /(\*\*[^*\n]+?\*\*|__[^_\n]+?__|`[^`\n]+`|(?<![\w*])\*[^*\s][^*\n]*?\*(?![\w*]))/g;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (/^(\*\*|__).+\1$/.test(part)) return <strong key={i}>{inline(part.slice(2, -2))}</strong>;
    if (/^`.+`$/.test(part)) return <code key={i}>{part.slice(1, -1)}</code>;
    if (/^\*.+\*$/.test(part)) return <em key={i}>{inline(part.slice(1, -1))}</em>;
    return part;
  });
}

type Block =
  | { kind: 'p' | 'h'; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: string[]; start: number };

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

function blocks(text: string): Block[] {
  const out: Block[] = [];
  // Whether the next line may extend the last block (false after a blank line).
  let open = false;
  for (const line of text.split('\n')) {
    const prev = open ? out[out.length - 1] : undefined;
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    const heading = HEADING.exec(line);
    open = true;
    if (!line.trim()) open = false;
    else if (bullet || numbered) {
      const ordered = !bullet;
      const item = bullet ? bullet[1] : numbered![2];
      if (prev?.kind === 'list' && prev.ordered === ordered) prev.items.push(item);
      else out.push({ kind: 'list', ordered, items: [item], start: numbered ? Number(numbered[1]) : 1 });
    } else if (heading) {
      out.push({ kind: 'h', lines: [heading[1]] });
      open = false;
    } else if (prev?.kind === 'p') prev.lines.push(line);
    // An indented or wrapped line continues the previous list item.
    else if (prev?.kind === 'list') prev.items[prev.items.length - 1] += ` ${line.trim()}`;
    else out.push({ kind: 'p', lines: [line] });
  }
  return out;
}

export function Markdown({ text }: { text: string }) {
  return (
    <>
      {blocks(text).map((b, i) => {
        if (b.kind === 'list') {
          const items = b.items.map((it, j) => <li key={j}>{inline(it)}</li>);
          return b.ordered ? <ol key={i} start={b.start}>{items}</ol> : <ul key={i}>{items}</ul>;
        }
        const content = b.lines.flatMap((l, j) => (j ? [<br key={`br${j}`} />, ...inline(l)] : inline(l)));
        return b.kind === 'h' ? <p key={i} className="md-heading"><strong>{content}</strong></p> : <p key={i}>{content}</p>;
      })}
    </>
  );
}
