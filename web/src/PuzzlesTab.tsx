import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { AnalysisRequest } from './position';
import { PuzzleView } from './PuzzleView';
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
  const [puzzles, setPuzzles] = useState<Puzzle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>(loadAttempts);
  const [theme, setTheme] = useState('all');
  const [band, setBand] = useState('all');
  const [current, setCurrent] = useState<Puzzle | null>(null);

  useEffect(() => {
    fetch('/puzzles.json')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setPuzzles)
      .catch(e => setError(String(e)));
  }, []);

  useEffect(() => saveAttempts(attempts), [attempts]);
  useEffect(() => onPuzzleChange(current), [current, onPuzzleChange]);

  const themeOptions = useMemo(() => {
    if (!puzzles) return [];
    const counts = new Map<string, number>();
    const primaries = new Set(puzzles.map(p => p.primary_theme));
    for (const p of puzzles) for (const t of p.themes) if (primaries.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
    counts.set('mixed', puzzles.filter(p => p.primary_theme === 'mixed').length);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [puzzles]);

  const filtered = useMemo(() => {
    if (!puzzles) return [];
    const [lo, hi] = RATING_BANDS[band];
    return puzzles.filter(
      p =>
        p.rating >= lo &&
        p.rating <= hi &&
        (theme === 'all' || (theme === 'mixed' ? p.primary_theme === 'mixed' : p.themes.includes(theme))),
    );
  }, [puzzles, theme, band]);

  const attemptedIds = useMemo(() => new Set(attempts.map(a => a.id)), [attempts]);
  const remaining = filtered.filter(p => !attemptedIds.has(p.id)).length;

  const pickNext = useCallback(() => {
    if (!filtered.length) return setCurrent(null);
    const fresh = filtered.filter(p => !attemptedIds.has(p.id) && p.id !== current?.id);
    const pool = fresh.length ? fresh : filtered;
    setCurrent(pool[Math.floor(Math.random() * pool.length)]);
    // attemptedIds intentionally read at call time only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered]);

  // New puzzle whenever the filter changes (and on first load). Keyed on the
  // filter itself rather than on pickNext: a hot reload re-runs effects and
  // recreates callbacks, which would otherwise swap in a random new puzzle.
  const pickedFor = useRef<string | null>(null);
  useEffect(() => {
    const key = puzzles ? `${theme}|${band}|${puzzles.length}` : null;
    if (key === pickedFor.current) return;
    pickedFor.current = key;
    pickNext();
  }, [puzzles, theme, band, pickNext]);

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
  if (!puzzles) return <p className="loading">Loading puzzles…</p>;
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
            <option value="all">All themes ({puzzles.length})</option>
            {themeOptions.map(([t, n]) => (
              <option key={t} value={t}>
                {t === 'mixed' ? 'Untagged mix' : themeName(t)} ({n})
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
          {remaining} of {filtered.length} unplayed in this selection
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
