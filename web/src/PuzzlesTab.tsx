import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { AnalysisRequest } from './position';
import { PuzzleView } from './PuzzleView';
import { loadIndex, loadPuzzle, type PuzzleIndex } from './puzzleStore';
import type { Puzzle } from './session';
import { SettingsPanel } from './SettingsPanel';
import { loadAttempts, saveAttempts, summarize, type Attempt, type Result, type Settings } from './storage';
import { themeName } from './themes';

const RATING_BANDS: Record<string, [number, number]> = {
  all: [0, 9999],
  '1200-1599': [1200, 1599],
  '1600-1999': [1600, 1999],
  '2000-2399': [2000, 2399],
  '2400+': [2400, 9999],
};

interface Props {
  active: boolean;
  settings: Settings;
  setSettings: Dispatch<SetStateAction<Settings>>;
  onPuzzleChange: (puzzle: Puzzle | null) => void;
  onBoardSize: (px: number | null) => void;
  onPosition: (pos: { fen: string; solved: boolean }) => void;
  onAnalyze: (req: Omit<AnalysisRequest, 'id'>) => void;
}

export function PuzzlesTab({ active, settings, setSettings, onPuzzleChange, onBoardSize, onPosition, onAnalyze }: Props) {
  const [index, setIndex] = useState<PuzzleIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingPuzzle, setLoadingPuzzle] = useState(false);
  const [attempts, setAttempts] = useState<Attempt[]>(loadAttempts);
  const [theme, setTheme] = useState('all');
  const [band, setBand] = useState('all');
  const [current, setCurrent] = useState<Puzzle | null>(null);

  useEffect(() => {
    loadIndex()
      .then(setIndex)
      .catch(e => setError(String(e)));
  }, []);

  useEffect(() => saveAttempts(attempts), [attempts]);
  useEffect(() => onPuzzleChange(current), [current, onPuzzleChange]);

  // Theme options: every theme that is some puzzle's primary theme, counted over all
  // puzzles tagged with it, plus the untagged mix. Same rules as before, on index codes.
  const themeOptions = useMemo(() => {
    if (!index) return [];
    const mixed = index.themes.indexOf('mixed');
    const primaries = new Set(index.primary);
    const counts = new Map<number, number>();
    for (const tags of index.tags) for (const t of tags) if (primaries.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
    counts.set(mixed, index.primary.filter(p => p === mixed).length);
    return [...counts.entries()].map(([t, n]) => [index.themes[t], n] as const).sort((a, b) => b[1] - a[1]);
  }, [index]);

  /** Positions in the index of the puzzles matching the filters. */
  const filtered = useMemo(() => {
    if (!index) return [];
    const [lo, hi] = RATING_BANDS[band];
    const code = index.themes.indexOf(theme);
    const out: number[] = [];
    for (let i = 0; i < index.count; i++) {
      const r = index.rating[i];
      if (r < lo || r > hi) continue;
      if (theme !== 'all' && !(theme === 'mixed' ? index.primary[i] === code : index.tags[i].includes(code))) continue;
      out.push(i);
    }
    return out;
  }, [index, theme, band]);

  const attemptedIds = useMemo(() => new Set(attempts.map(a => a.id)), [attempts]);
  const remaining = index ? filtered.filter(i => !attemptedIds.has(index.id[i])).length : 0;

  // Puzzles load asynchronously (their shard may need downloading); only the
  // latest request may set the current puzzle.
  const request = useRef(0);
  const pickNext = useCallback(() => {
    if (!index || !filtered.length) return setCurrent(null);
    const fresh = filtered.filter(i => !attemptedIds.has(index.id[i]) && index.id[i] !== current?.id);
    const pool = fresh.length ? fresh : filtered;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const mine = ++request.current;
    setLoadingPuzzle(true);
    loadPuzzle(index, pick)
      .then(p => mine === request.current && setCurrent(p))
      .catch(e => mine === request.current && setError(String(e)))
      .finally(() => mine === request.current && setLoadingPuzzle(false));
    // attemptedIds intentionally read at call time only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, filtered]);

  // New puzzle whenever the filter changes (and on first load). Keyed on the
  // filter itself rather than on pickNext: a hot reload re-runs effects and
  // recreates callbacks, which would otherwise swap in a random new puzzle.
  const pickedFor = useRef<string | null>(null);
  useEffect(() => {
    const key = index ? `${theme}|${band}|${index.count}` : null;
    if (key === pickedFor.current) return;
    pickedFor.current = key;
    pickNext();
  }, [index, theme, band, pickNext]);

  const onFinish = useCallback(
    (result: Result, meta: { wrong: number; hints: number; ms: number }) => {
      if (!current) return;
      setAttempts(a => [...a, { id: current.id, result, rating: current.rating, ts: Date.now(), ...meta }]);
    },
    [current],
  );

  const stats = summarize(attempts);
  const recent = attempts.slice(-12);

  if (error) return <p className="error">Could not load puzzles: {error}</p>;
  if (!index || (!current && loadingPuzzle)) return <p className="loading">Loading puzzles…</p>;
  if (!current)
    return (
      <p className="muted">
        No puzzles match this theme and rating.{' '}
        <button onClick={() => (setTheme('all'), setBand('all'))}>Reset filters</button>
      </p>
    );

  return (
    <PuzzleView
      key={current.id}
      puzzle={current}
      active={active}
      pieces={settings.pieces}
      sound={settings.sound}
      onFinish={onFinish}
      onNext={pickNext}
      onBoardSize={onBoardSize}
      onPosition={onPosition}
      onAnalyze={onAnalyze}
    >
      <section className="panel">
        <p className="label">Practice</p>
        <label>
          Theme
          <select value={theme} onChange={e => setTheme(e.target.value)}>
            <option value="all">All themes ({index.count.toLocaleString()})</option>
            {themeOptions.map(([t, n]) => (
              <option key={t} value={t}>
                {t === 'mixed' ? 'Untagged mix' : themeName(t)} ({n.toLocaleString()})
              </option>
            ))}
          </select>
        </label>
        <label>
          Rating
          <select value={band} onChange={e => setBand(e.target.value)}>
            {Object.keys(RATING_BANDS).map(b => (
              <option key={b} value={b}>
                {b === 'all' ? 'Any rating' : b}
              </option>
            ))}
          </select>
        </label>
        <p className="muted">
          {remaining.toLocaleString()} of {filtered.length.toLocaleString()} unplayed in this selection
        </p>
      </section>

      <section className="panel">
        <p className="label">Progress</p>
        <div className="stats">
          <div><strong>{stats.total}</strong><span>played</span></div>
          <div><strong>{stats.accuracy}%</strong><span>first try</span></div>
          <div><strong>{stats.streak}</strong><span>streak</span></div>
          <div><strong>{stats.best}</strong><span>best</span></div>
        </div>
        {recent.length > 0 && (
          <div className="history">
            {recent.map(a => (
              <span key={a.ts} className={`dot ${a.result}`} title={`#${a.id} · ${a.rating} · ${a.result}`} />
            ))}
          </div>
        )}
      </section>

      <SettingsPanel settings={settings} setSettings={setSettings} />
    </PuzzleView>
  );
}
