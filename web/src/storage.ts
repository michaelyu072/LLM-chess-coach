import { boardTheme, DEFAULT_BOARD, DEFAULT_PIECES, pieceSet } from './assets';

export type Result ='clean' | 'assisted' | 'failed';

export interface Attempt {
  id: string;
  result: Result;
  wrong: number;
  hints: number;
  ms: number;
  rating: number;
  ts: number;
}

export type ThemeMode = 'system' | 'light' | 'dark';

export interface Settings {
  board: string;
  pieces: string;
  sound: boolean;
  theme: ThemeMode;
}

export const DEFAULT_SETTINGS: Settings = { board: DEFAULT_BOARD, pieces: DEFAULT_PIECES, sound: true, theme: 'system' };

const ATTEMPTS_KEY = 'cpc.attempts.v1';
export const SETTINGS_KEY = 'cpc.settings.v1'; // also read by index.html to avoid a theme flash

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable (private mode etc.) — progress just won't persist
  }
}

export const loadAttempts = () => read<Attempt[]>(ATTEMPTS_KEY, []);
export const saveAttempts = (a: Attempt[]) => write(ATTEMPTS_KEY, a);
export function loadSettings(): Settings {
  const s = { ...DEFAULT_SETTINGS, ...read<Partial<Settings>>(SETTINGS_KEY, {}) };
  // Drop ids that no longer exist (e.g. the old "brown.png" format).
  const theme = (['system', 'light', 'dark'] as const).includes(s.theme) ? s.theme : 'system';
  return { ...s, theme, board: boardTheme(s.board).id, pieces: pieceSet(s.pieces).id };
}
export const saveSettings = (s: Settings) => write(SETTINGS_KEY, s);

export function summarize(attempts: Attempt[]) {
  const clean = attempts.filter(a => a.result === 'clean').length;
  const solved = attempts.filter(a => a.result !== 'failed').length;
  let streak = 0;
  for (let i = attempts.length - 1; i >= 0 && attempts[i].result === 'clean'; i--) streak++;
  let best = 0;
  let run = 0;
  for (const a of attempts) {
    run = a.result === 'clean' ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return {
    total: attempts.length,
    solved,
    clean,
    accuracy: attempts.length ? Math.round((clean / attempts.length) * 100) : 0,
    streak,
    best,
  };
}
