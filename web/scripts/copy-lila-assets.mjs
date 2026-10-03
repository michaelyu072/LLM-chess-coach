// Copies board, piece, and sound assets from the local lila clone into
// public/lila/, and writes two generated modules into src/:
//   assets.json  - every 2D board (with lila's coordinate colors) and piece set
//   themes.json  - puzzle theme names/descriptions from lila's translations
// Skips gracefully if lila is absent but assets were already copied.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const lila = process.env.LILA_DIR ?? join(webRoot, '..', 'lila');
const out = join(webRoot, 'public', 'lila');
const SOUNDS = ['Move', 'Capture', 'Check', 'Error', 'Confirmation', 'Victory'];
const PIECE_FILES = ['wP', 'wN', 'wB', 'wR', 'wQ', 'wK', 'bP', 'bN', 'bB', 'bR', 'bQ', 'bK'];

if (!existsSync(join(lila, 'public'))) {
  if (existsSync(out) && existsSync(join(webRoot, 'src', 'assets.json'))) {
    console.log(`lila not found at ${lila}; using previously copied assets.`);
    process.exit(0);
  }
  console.error(`lila clone not found at ${lila}. Set LILA_DIR to its path.`);
  process.exit(1);
}

const copy = (from, to) => {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
};

// --- Boards: parse lila's $board-themes-2d map for names, files and coord colors.
const scss = readFileSync(join(lila, 'ui/lib/css/theme/board/_boards.scss'), 'utf8');
const block2d = scss.slice(scss.indexOf('$board-themes-2d'), scss.indexOf('$board-themes-3d'));
const boards = [];
const skipped = [];
for (const [, id, body] of block2d.matchAll(/'([\w-]+)':\s*\(([^)]*)\)/g)) {
  const get = key => body.match(new RegExp(`${key}:\\s*'?([^',\\n]+)'?`))?.[1].trim();
  const fileName = get('name-override') ?? id;
  const ext = get('file-ext');
  const srcDir = join(lila, 'public/images/board', ext === 'svg' ? 'svg' : '');
  const src = join(srcDir, `${fileName}.${ext}`);
  if (!existsSync(src)) {
    skipped.push(id);
    continue;
  }
  const file = `${fileName}.${ext}`;
  copy(src, join(out, 'board', file));
  const thumbName = `${fileName}.thumbnail.${ext}`;
  let thumb = file;
  if (existsSync(join(srcDir, thumbName))) {
    copy(join(srcDir, thumbName), join(out, 'board', thumbName));
    thumb = thumbName;
  }
  boards.push({ id, file, thumb, coordWhite: get('coord-color-white'), coordBlack: get('coord-color-black') });
}

// --- Piece sets: every set with a full w/b file for each role (svg or webp).
const pieces = [];
for (const id of readdirSync(join(lila, 'public/piece')).sort()) {
  const dir = join(lila, 'public/piece', id);
  const ext = ['svg', 'webp'].find(e => PIECE_FILES.every(f => existsSync(join(dir, `${f}.${e}`))));
  if (!ext) {
    skipped.push(`piece:${id}`);
    continue;
  }
  for (const f of PIECE_FILES) copy(join(dir, `${f}.${ext}`), join(out, 'piece', id, `${f}.${ext}`));
  pieces.push({ id, ext });
}

for (const s of SOUNDS) copy(join(lila, 'public/sound/standard', `${s}.mp3`), join(out, 'sound', `${s}.mp3`));

writeFileSync(join(webRoot, 'src', 'assets.json'), JSON.stringify({ boards, pieces }, null, 2) + '\n');

// --- Theme names + descriptions from lila's translation source.
const xml = readFileSync(join(lila, 'translation/source/puzzleTheme.xml'), 'utf8');
const strings = {};
for (const [, name, value] of xml.matchAll(/<string name="([^"]+)">([\s\S]*?)<\/string>/g))
  strings[name] = value
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
const themes = {};
for (const [key, value] of Object.entries(strings)) {
  if (key.endsWith('Description')) continue;
  themes[key] = { name: value, description: strings[`${key}Description`] ?? '' };
}
writeFileSync(join(webRoot, 'src', 'themes.json'), JSON.stringify(themes, null, 2) + '\n');

console.log(
  `Copied ${boards.length} boards, ${pieces.length} piece sets, ${SOUNDS.length} sounds; ` +
    `${Object.keys(themes).length} theme descriptions.` +
    (skipped.length ? ` Skipped (missing/unsupported files): ${skipped.join(', ')}` : ''),
);
