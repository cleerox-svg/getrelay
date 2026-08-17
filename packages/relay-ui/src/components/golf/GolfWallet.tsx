import { useEffect } from 'react';
import { useEconomy } from '../../lib/golf/economy';
import { isFirstLoad } from '../../lib/golf/loadState';
import type { WalletLedgerEntry } from '../../lib/types';
import { CoinBalance } from './CoinBalance';
import { LoadFailure, LoadFailureLine } from './shared/LoadFailure';

// Compact relative time for a ledger row.
function relTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))}m ago`;
  if (diff < 86_400_000) return `${Math.max(1, Math.round(diff / 3_600_000))}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

// Turn a ledger `reason` code into a friendly label. Unknown codes fall back to
// a de-underscored title case so a new server reason still reads sensibly.
function reasonLabel(e: WalletLedgerEntry): string {
  switch (e.reason) {
    case 'purchase':
      return 'Cosmetic purchase';
    case 'season_claim':
      return 'Season reward';
    case 'round_reward':
      return 'Round payout';
    case 'daily_reward':
      return 'Daily reward';
    case 'tournament_reward':
      return 'Tournament payout';
    default:
      return e.reason.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  }
}

// The coin wallet: current balance + the newest ledger entries (earn / spend).
export function GolfWallet() {
  const balance = useEconomy((s) => s.balance);
  const ledger = useEconomy((s) => s.ledger);
  const walletState = useEconomy((s) => s.walletState);
  const ensureWallet = useEconomy((s) => s.ensureWallet);

  useEffect(() => {
    void ensureWallet();
  }, [ensureWallet]);

  return (
    <div className="golf-wallet">
      <div className="golf-wallet-head">
        <span>Balance</span>
        <CoinBalance balance={balance} />
      </div>

      {/* An unreachable wallet is its OWN state — never "no coin activity yet",
          which reads as "you have earned nothing". */}
      {walletState === 'error' && ledger.length > 0 ? (
        <LoadFailureLine text="Couldn’t refresh your wallet." onRetry={() => void ensureWallet(true)} />
      ) : null}

      {isFirstLoad(walletState) && ledger.length === 0 ? (
        <div className="golf-empty">Loading your wallet…</div>
      ) : walletState === 'error' && ledger.length === 0 ? (
        <LoadFailure
          title="Couldn’t reach your wallet."
          detail="Your coins are safe on the server — this is a connection problem."
          onRetry={() => void ensureWallet(true)}
        />
      ) : ledger.length === 0 ? (
        <div className="golf-empty">No coin activity yet — play rounds to earn.</div>
      ) : (
        <div className="golf-ledger">
          {ledger.map((e, i) => {
            const credit = e.delta >= 0;
            return (
              <div key={`${e.createdAt}-${i}`} className="golf-ledger-row">
                <div className="golf-ledger-what">
                  <b>{reasonLabel(e)}</b>
                  <span>{relTime(e.createdAt)}</span>
                </div>
                <span className={`golf-ledger-delta${credit ? ' credit' : ' debit'}`}>
                  {credit ? '+' : '−'}
                  {Math.abs(e.delta).toLocaleString()}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
