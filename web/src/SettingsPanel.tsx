import type { Dispatch, SetStateAction } from 'react';
import { BOARDS, boardTheme, boardUrl, PIECE_SETS, pieceUrl, prettyName } from './assets';
import { Carousel } from './Carousel';
import type { Settings, ThemeMode } from './storage';

/** Appearance section shared by every tab's side panel. */
export function SettingsPanel({ settings, setSettings }: { settings: Settings; setSettings: Dispatch<SetStateAction<Settings>> }) {
  return (
    <section className="panel settings">
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
  );
}
