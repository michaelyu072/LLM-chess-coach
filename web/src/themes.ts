import lilaThemes from './themes.json';

// Descriptions lila's translation source doesn't provide.
const FALLBACK: Record<string, string> = {
  fork: 'A move where one piece attacks two or more opponent pieces at once.',
  promotion: 'Promote a pawn to a stronger piece.',
  enPassant: 'A pawn that has just advanced two squares can be captured as if it had moved only one.',
  cornerMate: 'Confine the king to the corner using a rook or queen and a knight to engage the checkmate.',
  hookMate: 'Checkmate with a rook, knight, and pawn along with one enemy pawn to limit the enemy king\'s escape.',
  morphysMate: 'Use the bishop to check the king, while your rook helps to confine it.',
  pillsburysMate: 'The rook delivers checkmate, while the bishop helps to confine it.',
};

const themes = lilaThemes as Record<string, { name: string; description: string }>;

export function themeName(key: string): string {
  return themes[key]?.name ?? key;
}

export function themeDescription(key: string): string {
  return themes[key]?.description || FALLBACK[key] || '';
}

// Tags that describe length/phase/outcome rather than a motif.
export const META_THEMES = new Set([
  'short', 'long', 'veryLong', 'opening', 'middlegame', 'endgame', 'crushing',
  'advantage', 'equality', 'mate', 'master', 'masterVsMaster', 'superGM', 'oneMove',
]);
