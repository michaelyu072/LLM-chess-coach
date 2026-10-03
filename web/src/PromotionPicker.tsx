import { pieceUrl } from './assets';

export type PromotionRole = 'q' | 'n' | 'r' | 'b';

const ROLES = [
  ['q', 'Q'],
  ['n', 'N'],
  ['r', 'R'],
  ['b', 'B'],
] as const;

/** Overlay over the board; clicking the backdrop cancels (onPick(null)). */
export function PromotionPicker(props: {
  color: 'white' | 'black';
  pieces: string;
  onPick: (role: PromotionRole | null) => void;
}) {
  return (
    <div className="promotion" onClick={() => props.onPick(null)}>
      <div className="promotion-choices" onClick={e => e.stopPropagation()}>
        {ROLES.map(([role, letter]) => (
          <button key={role} onClick={() => props.onPick(role)} title={letter}>
            <img src={pieceUrl(props.pieces, props.color === 'white' ? 'w' : 'b', letter)} alt={letter} />
          </button>
        ))}
      </div>
    </div>
  );
}
