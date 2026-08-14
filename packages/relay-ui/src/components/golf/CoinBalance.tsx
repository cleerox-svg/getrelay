// A compact coin-balance pill used across the golf economy UI (shop bar, hub
// header chip, profile). Renders a gold coin glyph + the number; a null balance
// (unloaded / unauthed) shows a dash so the layout never jumps.
export function CoinBalance({
  balance,
  size = 'md',
}: {
  balance: number | null;
  size?: 'sm' | 'md';
}) {
  return (
    <span className={`golf-coins golf-coins-${size}`} aria-label="Coin balance">
      <span className="golf-coin" aria-hidden="true">
        ◉
      </span>
      <b className="tabular-nums">{balance != null ? balance.toLocaleString() : '—'}</b>
    </span>
  );
}
