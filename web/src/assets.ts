import manifest from './assets.json';

export interface BoardTheme {
  id: string;
  file: string;
  thumb: string;
  coordWhite?: string;
  coordBlack?: string;
}
export interface PieceSet {
  id: string;
  ext: string;
}

export const BOARDS: BoardTheme[] = manifest.boards;
export const PIECE_SETS: PieceSet[] = manifest.pieces;

export const DEFAULT_BOARD = 'brown';
export const DEFAULT_PIECES = 'cburnett';

export const boardTheme = (id: string) => BOARDS.find(b => b.id === id) ?? BOARDS.find(b => b.id === DEFAULT_BOARD)!;
export const pieceSet = (id: string) => PIECE_SETS.find(p => p.id === id) ?? PIECE_SETS.find(p => p.id === DEFAULT_PIECES)!;

export function pieceUrl(set: string, color: 'w' | 'b', role: 'P' | 'N' | 'B' | 'R' | 'Q' | 'K'): string {
  const s = pieceSet(set);
  return `/lila/piece/${s.id}/${color}${role}.${s.ext}`;
}

export const boardUrl = (b: BoardTheme, thumb = false) => `/lila/board/${thumb ? b.thumb : b.file}`;

/** "blue-marble" -> "Blue marble", "wood4" -> "Wood 4" */
export function prettyName(id: string): string {
  const s = id.replace(/-/g, ' ').replace(/(\D)(\d+)$/, '$1 $2');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
