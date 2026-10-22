import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { BOARDS, boardTheme, boardUrl, PIECE_SETS, pieceUrl, prettyName } from './assets';
import { Carousel } from './Carousel';
import type { Settings, ThemeMode } from './storage';

interface Props {
  settings: Settings;
  setSettings: Dispatch<SetStateAction<Settings>>;
}

/** Gear button in the header; opens the appearance settings in a popover. */
export function SettingsMenu({ settings, setSettings }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Close on a click outside or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="settings-menu" ref={root}>
      <button
        className="settings-gear"
        aria-label="Settings"
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Settings"
        onClick={() => setOpen(o => !o)}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            fill="currentColor"
            fillRule="evenodd"
            d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54A.48.48 0 0 0 13.93 2h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.73 8.47a.48.48 0 0 0 .12.61l2.03 1.58c-.04.31-.07.63-.07.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.48.48 0 0 0-.12-.61l-2.01-1.58ZM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2Z"
          />
        </svg>
      </button>
      {open && (
        <section className="panel settings settings-popover" role="dialog" aria-label="Settings">
          <p className="label">Appearance</p>
          <Carousel
            label="Board"
            items={BOARDS}
            selected={settings.board}
            getId={b => b.id}
            getName={b => prettyName(b.id)}
            renderItem={b => <span className="board-thumb" style={{ backgroundImage: `url(${boardUrl(b, true)})` }} />}
            onSelect={id => setSettings(s => ({ ...s, board: id }))}
          />
          <Carousel
            label="Pieces"
            items={PIECE_SETS}
            selected={settings.pieces}
            getId={p => p.id}
            getName={p => prettyName(p.id)}
            renderItem={p => (
              <span className="piece-thumb" style={{ backgroundImage: `url(${boardUrl(boardTheme(settings.board), true)})` }}>
                <img src={pieceUrl(p.id, 'w', 'N')} alt="" loading="lazy" />
              </span>
            )}
            onSelect={id => setSettings(s => ({ ...s, pieces: id }))}
          />
          <label className="check">
            <input type="checkbox" checked={settings.sound} onChange={e => setSettings(s => ({ ...s, sound: e.target.checked }))} />
            Sound
          </label>
          <div className="segmented" role="group" aria-label="Color theme">
            {(['system', 'light', 'dark'] as ThemeMode[]).map(m => (
              <button key={m} aria-pressed={settings.theme === m} onClick={() => setSettings(s => ({ ...s, theme: m }))}>
                {m === 'system' ? 'System' : m === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
