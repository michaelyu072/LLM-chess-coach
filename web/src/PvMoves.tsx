import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Key } from '@lichess-org/chessground/types';
import type { Color } from 'chessops/types';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pvSteps, snapBoardSize } from './position';
import { lineMoves } from './session';

interface Props {
  fen: string;
  moves: string[];
  orientation: Color;
  max?: number;
}

const PREVIEW_TARGET = 200;
const CURSOR_GAP = 16;

/**
 * An engine line as text. Hovering a move shows a small board by the cursor
 * with the line played up to and including that move, arrowed.
 */
export function PvMoves({ fen, moves, orientation, max = 8 }: Props) {
  const steps = useMemo(() => pvSteps(fen, moves, max), [fen, moves, max]);
  const numbered = useMemo(() => lineMoves(fen, steps.map(s => s.san)), [fen, steps]);
  const [hovered, setHovered] = useState<number | null>(null);
  const mouse = useRef({ x: 0, y: 0 });
  const previewEl = useRef<HTMLDivElement | null>(null);
  const size = snapBoardSize(PREVIEW_TARGET);

  // Follow the cursor without re-rendering: write the position straight to the element.
  const place = () => {
    const el = previewEl.current;
    if (!el) return;
    const { x, y } = mouse.current;
    const left = x + CURSOR_GAP + size > window.innerWidth ? x - CURSOR_GAP - size : x + CURSOR_GAP;
    const top = Math.min(y + CURSOR_GAP, window.innerHeight - size - 8);
    el.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
  };

  // A new line from the engine may no longer have the hovered move.
  const step = hovered !== null ? steps[hovered] : undefined;

  return (
    <span
      className="pv-moves"
      onMouseMove={e => {
        mouse.current = { x: e.clientX, y: e.clientY };
        place();
      }}
      onMouseLeave={() => setHovered(null)}
    >
      {numbered.map((m, i) => (
        <span key={i}>
          {i > 0 && ' '}
          {m.number && `${m.number} `}
          <span
            className={`pv-move${hovered === i ? ' hovered' : ''}`}
            onMouseEnter={e => {
              mouse.current = { x: e.clientX, y: e.clientY };
              setHovered(i);
            }}
          >
            {m.san}
          </span>
        </span>
      ))}
      {step &&
        createPortal(
          <div
            ref={el => {
              previewEl.current = el;
              place();
            }}
            className="pv-preview"
            style={{ width: size, height: size }}
          >
            <MiniBoard {...step} orientation={orientation} />
          </div>,
          document.body,
        )}
    </span>
  );
}

interface MiniBoardProps {
  fen: string;
  from: string;
  to: string;
  check: Color | false;
  orientation: Color;
}

function MiniBoard({ fen, from, to, check, orientation }: MiniBoardProps) {
  const el = useRef<HTMLDivElement>(null);
  const cg = useRef<Api>();

  useLayoutEffect(() => {
    if (!el.current) return;
    cg.current = Chessground(el.current, {
      viewOnly: true,
      coordinates: false,
      animation: { enabled: false },
      highlight: { lastMove: true, check: true },
      drawable: { enabled: false, visible: true },
    });
    return () => cg.current?.destroy();
  }, []);

  useEffect(() => {
    const api = cg.current;
    if (!api) return;
    api.set({ fen, orientation, lastMove: [from as Key, to as Key], check });
    api.setAutoShapes([{ orig: from as Key, dest: to as Key, brush: 'blue' }]);
  }, [fen, from, to, check, orientation]);

  return <div ref={el} className="board" />;
}
