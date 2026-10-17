import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { DrawShape } from '@lichess-org/chessground/draw';
import type { Key } from '@lichess-org/chessground/types';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { playSound, soundForSan } from './sound';
import type { WalkStep, Walkthrough } from './walkthrough';

interface Props {
  line: Walkthrough;
  sound: boolean;
  onClose: () => void;
}

/** Squares that hold a piece, as "file,rank" (0-7 each). */
function occupied(fen: string): Set<string> {
  const out = new Set<string>();
  fen
    .split(' ')[0]
    .split('/')
    .forEach((rowText, i) => {
      let file = 0;
      for (const ch of rowText) {
        if (/\d/.test(ch)) file += Number(ch);
        else out.add(`${file++},${7 - i}`);
      }
    });
  return out;
}

/**
 * Where the bubble goes: beside the square the piece landed on, extending
 * toward the middle of the board, above or below depending on which side
 * hides fewer pieces.
 */
function bubblePlacement(step: WalkStep, flipped: boolean): { className: string; style: CSSProperties } {
  const display = (square: string) => {
    const file = square.charCodeAt(0) - 97;
    const rank = Number(square[1]) - 1;
    return { col: flipped ? 7 - file : file, row: flipped ? rank : 7 - rank };
  };
  const { col, row } = display(step.to);
  const left = col < 4;
  const pieces = [...occupied(step.fen)].map(key => {
    const [file, rank] = key.split(',').map(Number);
    return display(`${'abcdefgh'[file]}${rank + 1}`);
  });
  const marked = [step.from, ...step.focus].map(display);
  // The bubble spans roughly three squares across and two down.
  const hidden = (above: boolean) => {
    const inside = (p: { col: number; row: number }) =>
      (left ? p.col >= col && p.col <= col + 2 : p.col <= col && p.col >= col - 2) &&
      (above ? p.row < row && p.row >= row - 2 : p.row > row && p.row <= row + 2);
    return pieces.filter(inside).length + 2 * marked.filter(inside).length;
  };
  const towardMiddle = row >= 4;
  const canFlip = towardMiddle ? row <= 5 : row >= 2;
  const above = canFlip && hidden(!towardMiddle) < hidden(towardMiddle) ? !towardMiddle : towardMiddle;
  return {
    className: `walk-bubble ${above ? 'above' : 'below'} ${left ? 'from-left' : 'from-right'}`,
    style: {
      ...(above ? { bottom: `${(8 - row) * 12.5 + 1.5}%` } : { top: `${(row + 1) * 12.5 + 1.5}%` }),
      ...(left ? { left: `${col * 12.5}%` } : { right: `${(7 - col) * 12.5}%` }),
    },
  };
}

/**
 * Plays a coach's line over the board that is on screen. It is a separate,
 * view-only board laid exactly on top, so the puzzle or analysis underneath is
 * untouched and closing it puts the user back where they were.
 */
export function WalkthroughBoard({ line, sound, onClose }: Props) {
  // The visible tab's board; both tabs stay mounted, so pick the one showing.
  const [frame] = useState(() => document.querySelector<HTMLElement>('.tabpanel:not(.tabpanel-hidden) .board-frame'));
  const [flipped] = useState(() => Boolean(frame?.querySelector('.cg-wrap.orientation-black')));
  const boardEl = useRef<HTMLDivElement>(null);
  const cg = useRef<Api>();
  // -1 is the starting position, before the first move is played.
  const [idx, setIdx] = useState(-1);
  const last = line.steps.length - 1;
  const propsRef = useRef({ sound, onClose });
  propsRef.current = { sound, onClose };

  const go = (target: number) =>
    setIdx(cur => {
      const next = Math.max(0, Math.min(last, target));
      if (next === cur + 1 && propsRef.current.sound) playSound(soundForSan(line.steps[next].san));
      return next;
    });
  const goRef = useRef(go);
  goRef.current = go;
  const idxRef = useRef(idx);
  idxRef.current = idx;

  useEffect(() => {
    if (!boardEl.current) return;
    const api = Chessground(boardEl.current, {
      fen: line.startFen,
      orientation: flipped ? 'black' : 'white',
      turnColor: line.steps[0].mover,
      viewOnly: true,
      coordinates: true,
      animation: { enabled: true, duration: 320 },
      highlight: { lastMove: true, check: true },
      drawable: { enabled: false, visible: true },
    });
    cg.current = api;
    const ro = new ResizeObserver(() => api.redrawAll());
    ro.observe(boardEl.current);
    // Let the starting position register before the first move slides.
    const timer = window.setTimeout(() => goRef.current(0), 450);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
      api.destroy();
    };
  }, [line, flipped]);

  useEffect(() => {
    const step = line.steps[idx];
    if (!step || !cg.current) return;
    cg.current.set({
      fen: step.fen,
      lastMove: [step.from as Key, step.to as Key],
      check: step.check,
      turnColor: step.mover === 'white' ? 'black' : 'white',
    });
    const shapes: DrawShape[] = [
      { orig: step.from as Key, dest: step.to as Key, brush: 'paleGreen' },
      ...step.focus.map(sq => ({ orig: sq as Key, brush: 'yellow' })),
    ];
    cg.current.setAutoShapes(shapes);
  }, [idx, line]);

  // ←/→ step, Esc closes. Registered in the capture phase so the board
  // underneath (which uses the same keys) doesn't also react.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, select, textarea')) return;
      const actions: Record<string, () => void> = {
        ArrowRight: () => goRef.current(idxRef.current + 1),
        ' ': () => goRef.current(idxRef.current + 1),
        Enter: () => goRef.current(idxRef.current + 1),
        ArrowLeft: () => goRef.current(idxRef.current - 1),
        Home: () => goRef.current(0),
        End: () => goRef.current(last),
        Escape: () => propsRef.current.onClose(),
      };
      const action = actions[e.key];
      if (!action) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      action();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [last]);

  // No board on screen to play on (e.g. the tab is showing an error).
  useEffect(() => {
    if (!frame) propsRef.current.onClose();
  }, [frame]);
  if (!frame) return null;

  const step = line.steps[idx];
  const place = step && bubblePlacement(step, flipped);
  const atEnd = idx >= last;

  return createPortal(
    <div
      className="walk"
      role="group"
      aria-label="Coach’s line on the board"
      onClick={() => !atEnd && go(idx + 1)}
      title={atEnd ? undefined : 'Click for the next move (→)'}
    >
      <div ref={boardEl} className="board" />
      <button
        className="walk-exit"
        onClick={e => {
          e.stopPropagation();
          onClose();
        }}
        title="Back to my position (Esc)"
      >
        Coach’s line <span aria-hidden="true">×</span>
      </button>
      {step && place && (
        <div key={idx} className={place.className} style={place.style} onClick={e => e.stopPropagation()} aria-live="polite">
          <p className="walk-move">
            <span className={`walk-dot ${step.mover}`} aria-hidden="true" />
            {step.number} {step.san}
          </p>
          <p className="walk-note">{step.note}</p>
          {atEnd && line.evalBefore && line.evalAfter && (
            <p className="walk-eval" title="Stockfish’s evaluation before and after this line (positive favors White)">
              Engine: {line.evalBefore} → {line.evalAfter}
            </p>
          )}
          <div className="walk-controls">
            <div className="stepper" role="group" aria-label="Step through the line">
              <button onClick={() => go(idx - 1)} disabled={idx <= 0} title="Previous move (←)">
                ‹
              </button>
              <button onClick={() => go(idx + 1)} disabled={atEnd} title="Next move (→)">
                ›
              </button>
            </div>
            <span className="walk-count">
              {idx + 1} / {line.steps.length}
            </span>
            {atEnd ? (
              <button className="walk-done" onClick={onClose}>
                Back to my position
              </button>
            ) : (
              <button className="walk-done" onClick={() => go(idx + 1)}>
                Next
              </button>
            )}
          </div>
        </div>
      )}
    </div>,
    frame,
  );
}
