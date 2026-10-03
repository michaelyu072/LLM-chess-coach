import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { boardTheme, boardUrl, pieceUrl } from './assets';
import { BoardTab } from './BoardTab';
import type { CoachContext } from './coach';
import { CoachChat } from './CoachChat';
import { PuzzlesTab } from './PuzzlesTab';
import type { AnalysisRequest } from './position';
import type { Puzzle } from './session';
import { loadSettings, saveSettings, type Settings } from './storage';

const ROLE_NAMES = { P: 'pawn', N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' } as const;

function themeCss(set: string, boardId: string): string {
  const board = boardTheme(boardId);
  const pieces = (Object.keys(ROLE_NAMES) as (keyof typeof ROLE_NAMES)[]).flatMap(r =>
    (['w', 'b'] as const).map(
      c => `.cg-wrap piece.${ROLE_NAMES[r]}.${c === 'w' ? 'white' : 'black'}{background-image:url(${pieceUrl(set, c, r)})}`,
    ),
  );
  // Coordinate label colors per board, as lila does: labels on light squares
  // use the board's dark color and vice versa.
  const coords = board.coordWhite && board.coordBlack
    ? [
        `.cg-wrap.orientation-white .ranks :nth-child(odd),.cg-wrap.orientation-white .files :nth-child(even),` +
          `.cg-wrap.orientation-black .ranks :nth-child(even),.cg-wrap.orientation-black .files :nth-child(odd)` +
          `{color:${board.coordBlack};text-shadow:none}`,
        `.cg-wrap.orientation-white .ranks :nth-child(even),.cg-wrap.orientation-white .files :nth-child(odd),` +
          `.cg-wrap.orientation-black .ranks :nth-child(odd),.cg-wrap.orientation-black .files :nth-child(even)` +
          `{color:${board.coordWhite};text-shadow:none}`,
      ]
    : [];
  return [
    ...pieces,
    `.cg-wrap cg-board{background-image:url(${boardUrl(board)});background-size:cover}`,
    ...coords,
  ].join('\n');
}

const TABS = [
  { id: 'puzzles', label: 'Puzzles' },
  { id: 'board', label: 'Board' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const tabClass = (active: boolean) => (active ? 'tabpanel' : 'tabpanel tabpanel-hidden');

const tabFromHash = (): TabId => (window.location.hash === '#board' ? 'board' : 'puzzles');

export function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [tab, setTab] = useState<TabId>(tabFromHash);
  const [puzzle, setPuzzle] = useState<Puzzle | null>(null);
  // Puzzle board edge, measured in PuzzleView; shared so every tab's board matches.
  const [boardSize, setBoardSize] = useState<number | null>(null);
  // Positions on screen in each tab, so the coach chat knows what you're looking at.
  const [puzzlePos, setPuzzlePos] = useState<{ fen: string; solved: boolean } | null>(null);
  const [boardFen, setBoardFen] = useState<string | null>(null);
  const [analysisRequest, setAnalysisRequest] = useState<AnalysisRequest | null>(null);

  useEffect(() => saveSettings(settings), [settings]);

  // Apply the theme; in "system" mode follow the OS preference live.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      const light = settings.theme === 'light' || (settings.theme === 'system' && media.matches);
      document.documentElement.dataset.theme = light ? 'light' : 'dark';
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [settings.theme]);

  // Tab lives in the URL hash so reloads and back/forward keep it.
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const selectTab = (id: TabId) => {
    window.location.hash = id === 'puzzles' ? '' : id;
    setTab(id);
  };

  // A tab switch moves boards on screen without resizing them; tell chessground
  // to re-measure, or clicks and drops land on the wrong squares.
  useEffect(() => {
    document.body.dispatchEvent(new Event('chessground.resize'));
  }, [tab]);

  const onPuzzleChange = useCallback((p: Puzzle | null) => setPuzzle(p), []);
  const onBoardSize = useCallback((px: number | null) => setBoardSize(px), []);
  const onPuzzlePosition = useCallback((pos: { fen: string; solved: boolean }) => setPuzzlePos(pos), []);
  const onBoardPosition = useCallback((fen: string | null) => setBoardFen(fen), []);
  const onAnalyze = useCallback((req: Omit<AnalysisRequest, 'id'>) => {
    setAnalysisRequest({ ...req, id: Date.now() });
    window.location.hash = 'board';
    setTab('board');
  }, []);

  const coachContext: CoachContext | null =
    tab === 'puzzles'
      ? puzzle && puzzlePos
        ? {
            source: 'puzzle',
            fen: puzzlePos.fen,
            puzzle: {
              id: puzzle.id,
              rating: puzzle.rating,
              themes: puzzle.themes,
              playerColor: puzzle.player_color,
              solved: puzzlePos.solved,
              // Only share the answer once the puzzle is over.
              solution: puzzlePos.solved ? puzzle.solution_san : undefined,
            },
          }
        : null
      : boardFen
        ? { source: 'board', fen: boardFen }
        : null;

  return (
    <div className="app" style={boardSize ? ({ '--board-size': `${boardSize}px` } as CSSProperties) : undefined}>
      <style>{themeCss(settings.pieces, settings.board)}</style>
      <header className="top">
        <h1>
          <span className="logo" aria-hidden="true" /> Chess Puzzle Coach
        </h1>
        <nav className="tabs" role="tablist">
          {TABS.map(t => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => selectTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      {/* Both tabs stay mounted (and laid out, just invisible) so switching keeps
          each one's state and the puzzle board can be measured from any tab.
          They're stacked at the same position, so boards don't move on switch. */}
      <div className="tabpanels">
        <div role="tabpanel" className={tabClass(tab === 'puzzles')} aria-hidden={tab !== 'puzzles'}>
          <PuzzlesTab
            active={tab === 'puzzles'}
            settings={settings}
            setSettings={setSettings}
            onPuzzleChange={onPuzzleChange}
            onBoardSize={onBoardSize}
            onPosition={onPuzzlePosition}
            onAnalyze={onAnalyze}
          />
        </div>
        <div role="tabpanel" className={tabClass(tab === 'board')} aria-hidden={tab !== 'board'}>
          <BoardTab
            active={tab === 'board'}
            settings={settings}
            setSettings={setSettings}
            puzzle={puzzle}
            onPosition={onBoardPosition}
            analysisRequest={analysisRequest}
          />
        </div>
      </div>

      <CoachChat context={coachContext} />
    </div>
  );
}
