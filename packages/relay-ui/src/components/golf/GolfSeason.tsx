import { useEffect, useState } from 'react';
import { useEconomy, economyErrorCode } from '../../lib/golf/economy';
import { isFirstLoad } from '../../lib/golf/loadState';
import type { Cosmetic, SeasonReward, SeasonTier } from '../../lib/types';
import { CoinBalance } from './CoinBalance';
import { LoadFailure } from './shared/LoadFailure';

// Live "ends in …" label from an absolute ms timestamp. Coarse (d/h/m) — a
// season runs for days, so no seconds churn.
function fmtCountdown(endsAt: number, now: number): string {
  const ms = endsAt - now;
  if (ms <= 0) return 'Season ended';
  const mins = Math.floor(ms / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `Ends in ${d}d ${h}h`;
  if (h > 0) return `Ends in ${h}h ${m}m`;
  return `Ends in ${m}m`;
}

// A reward chip — coins or a cosmetic (looked up in the catalog for its name +
// colour). Rendered generically off the reward shape; unknown cosmetic ids fall
// back to a neutral "Cosmetic" pill.
function RewardChip({ reward, catalog }: { reward: SeasonReward; catalog: Cosmetic[] }) {
  if ('coins' in reward) {
    return (
      <span className="golf-reward">
        <span className="golf-coin" aria-hidden="true">
          ◉
        </span>
        {reward.coins.toLocaleString()}
      </span>
    );
  }
  const item = catalog.find((c) => c.id === reward.cosmetic);
  const color = item?.visual.color ?? '#8e8e93';
  return (
    <span className="golf-reward">
      <span
        aria-hidden="true"
        style={{
          width: 14,
          height: 14,
          borderRadius: 999,
          background: color,
          boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.15)',
          display: 'inline-block',
        }}
      />
      {item?.name ?? 'Cosmetic'}
    </span>
  );
}

// The Season track: an XP progress bar, the reward-tier ladder (locked /
// claimable / claimed) and a live end-of-season countdown. Claiming a tier
// credits coins or unlocks a cosmetic through the store, so the wallet + shop
// stay in sync.
export function GolfSeason() {
  const season = useEconomy((s) => s.season);
  const seasonState = useEconomy((s) => s.seasonState);
  const catalog = useEconomy((s) => s.catalog);
  const balance = useEconomy((s) => s.balance);
  const ensureSeason = useEconomy((s) => s.ensureSeason);
  const ensureCosmetics = useEconomy((s) => s.ensureCosmetics);
  const ensureWallet = useEconomy((s) => s.ensureWallet);
  const claim = useEconomy((s) => s.claim);

  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void ensureSeason();
    void ensureCosmetics();
    void ensureWallet();
  }, [ensureSeason, ensureCosmetics, ensureWallet]);

  // Tick the countdown every 30s (coarse label → no faster needed).
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  async function onClaim(tier: number) {
    setBusy(tier);
    setMsg(null);
    try {
      await claim(tier);
      setMsg(`Tier ${tier} claimed!`);
    } catch (e) {
      const code = economyErrorCode(e);
      setMsg(
        code === 'tier_locked'
          ? 'Reach that tier first.'
          : code === 'already_claimed'
            ? 'Already claimed.'
            : 'Could not claim — try again.',
      );
    } finally {
      setBusy(null);
    }
  }

  if (!season) {
    if (isFirstLoad(seasonState)) {
      return <div className="golf-empty">Loading the season…</div>;
    }
    // A failed fetch is not "no season" — it hid a live track the player has
    // claimable tiers on, with no way to try again.
    if (seasonState === 'error') {
      return (
        <LoadFailure
          title="The season track needs a connection."
          detail="Couldn’t load your progress."
          onRetry={() => void ensureSeason(true)}
        />
      );
    }
    return <div className="golf-empty">No active season — reconnect to see the track.</div>;
  }

  const tiers = [...season.tiers].sort((a, b) => a.tier - b.tier);
  const maxXp = tiers.length ? tiers[tiers.length - 1]!.xpRequired : 0;
  const pct = maxXp > 0 ? Math.min(100, Math.round((season.xp / maxXp) * 100)) : 0;

  const stateOf = (t: SeasonTier): 'claimed' | 'claimable' | 'locked' => {
    if (season.claimed.includes(t.tier)) return 'claimed';
    if (season.claimable.includes(t.tier)) return 'claimable';
    return 'locked';
  };

  return (
    <div className="golf-season">
      <div className="golf-season-head">
        <div>
          <b>Season pass</b>
          <div className="golf-season-sub">{fmtCountdown(season.endsAt, now)}</div>
        </div>
        <CoinBalance balance={balance} />
      </div>

      {/* XP progress toward the final tier. */}
      <div className="golf-xp">
        <div className="golf-xp-row">
          <span>
            Tier {season.currentTier} · {season.xp.toLocaleString()} XP
          </span>
          <span>{maxXp.toLocaleString()} XP</span>
        </div>
        <div className="golf-xpbar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="golf-xpbar-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {msg ? <div className="golf-season-msg">{msg}</div> : null}

      {/* Tier ladder. */}
      <div className="golf-tiers">
        {tiers.map((t) => {
          const state = stateOf(t);
          return (
            <div key={t.tier} className={`golf-tier is-${state}`}>
              <div className="golf-tier-badge" aria-hidden="true">
                {state === 'claimed' ? '✓' : t.tier}
              </div>
              <div className="golf-tier-body">
                <b>Tier {t.tier}</b>
                <span>{t.xpRequired.toLocaleString()} XP</span>
              </div>
              <RewardChip reward={t.reward} catalog={catalog} />
              {state === 'claimable' ? (
                <button
                  type="button"
                  className="golf-tier-claim"
                  disabled={busy === t.tier}
                  onClick={() => onClaim(t.tier)}
                >
                  Claim
                </button>
              ) : (
                <span className={`golf-tier-state ${state}`}>
                  {state === 'claimed' ? 'Claimed' : 'Locked'}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
