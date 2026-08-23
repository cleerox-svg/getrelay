import { useEffect, useState } from 'react';
import { useGameFlow } from '../../lib/games/useGameFlow';
import { unlockAudio } from '../../lib/audio';
import { useStore } from '../../lib/store';
import { PARKS } from '../../lib/baseball/parks';
import { DERBY_ROUNDS, PITCHES_PER_ROUND } from '../../lib/baseball/derbyRules';
import { REGULATION_INNINGS } from '../../lib/baseball/duelRules';
import { DerbyGame } from './DerbyGame';
import type { DerbyGameResult } from './DerbyGame';
import { DuelGame } from './DuelGame';
import type { DuelGameResult } from './DuelGame';

// Baseball's standalone screen: menu → derby → results, mounted by the Games
// hub as component state. It is the same shape every other game on the tab uses,
// and it deliberately reuses `useGameFlow` rather than re-deriving the
// back-gesture choreography: back while playing pauses, back while paused leaves
// to the menu with the partial run banked, and a menu-level back leaves the tab.
// That machine is subtle (its own file documents the history depth across five
// presses) and a second copy of it is a second set of ways to trap the user in
// a tab.
//
// ⚠ THE HUD DOES NOT NEED THIS FILE. `DerbyGame` takes plain props — a seed, a
// park, `paused`, two callbacks — and mounts standalone against a `<div>`. That
// is what lets the screenshot harness photograph it without the app shell, and
// it is why nothing about the flow machine leaked down into it.

const RANKED_PARK = PARKS[0]!;

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="bb-stat">
      <span>{k}</span>
      <b>{v}</b>
    </div>
  );
}

/**
 * Which game the one play screen is running.
 *
 * ⚠ A MODE, NOT A SECOND FLOW. `useGameFlow`'s back-gesture machine is subtle
 * enough that its own file documents the history depth across five presses, and
 * a second copy of it is a second set of ways to trap the user in a tab. Both
 * games take the same props — a seed, a park, `paused`, two callbacks — so the
 * only thing that varies is which component is mounted and which result card is
 * shown afterwards.
 */
type Mode = 'derby' | 'duel';

export function BaseballScreen({ onExitToHub }: { onExitToHub: () => void }) {
  const { screen, setScreen, paused, setPaused, startGame, consumeHistoryEntry, markAbandoned } =
    useGameFlow();
  const [mode, setMode] = useState<Mode>('derby');
  const [result, setResult] = useState<DerbyGameResult | null>(null);
  const [duelResult, setDuelResult] = useState<DuelGameResult | null>(null);

  // Full-bleed 3D runs IMMERSIVE, the same as golf's putting round and range
  // challenge. The `zIndex: 60` wrapper below already covers the z-20 tab bar
  // and the navbar, so nothing was visibly broken without this — but both stayed
  // MOUNTED and painting underneath a full-screen WebGL canvas, which is a
  // second layout and a second set of blur/backdrop surfaces composited every
  // frame for nobody. Cleared on unmount so leaving by any path restores them.
  const setImmersive = useStore((s) => s.setImmersive);
  const immersive = screen === 'guess';
  useEffect(() => {
    setImmersive(immersive);
    return () => setImmersive(false);
  }, [immersive, setImmersive]);

  if (screen === 'guess') {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 60 }}>
        {mode === 'derby' ? (
          <DerbyGame
            park={RANKED_PARK}
            paused={paused}
            onFinish={(r) => {
              setResult(r);
              setScreen('results');
              consumeHistoryEntry('guess');
            }}
            onExit={() => {
              markAbandoned();
              setScreen('menu');
              consumeHistoryEntry('guess');
            }}
          />
        ) : (
          <DuelGame
            park={RANKED_PARK}
            paused={paused}
            onFinish={(r) => {
              setDuelResult(r);
              setScreen('results');
              consumeHistoryEntry('guess');
            }}
            onExit={() => {
              markAbandoned();
              setScreen('menu');
              consumeHistoryEntry('guess');
            }}
          />
        )}
        {paused && (
          <div className="bb-pause">
            <div className="bb-pause-card">
              <b>Paused</b>
              <button type="button" className="bb-btn bb-btn--go" onClick={() => setPaused(false)}>
                Resume
              </button>
              <button
                type="button"
                className="bb-btn"
                onClick={() => {
                  markAbandoned();
                  setPaused(false);
                  setScreen('menu');
                  consumeHistoryEntry('guess');
                }}
              >
                Quit to menu
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (screen === 'results' && duelResult) {
    return (
      <div className="bb-menu">
        <h2 className="bb-title">
          {duelResult.outcome === 'win'
            ? 'You win'
            : duelResult.outcome === 'tie'
              ? 'Tie game'
              : 'You lose'}
        </h2>
        <div className="bb-score">
          {duelResult.runsFor} – {duelResult.runsAgainst}
        </div>
        <div className="bb-stats">
          <Stat k="Innings" v={String(duelResult.inningsPlayed)} />
          <Stat k="Pitches" v={String(duelResult.pitchCount)} />
        </div>
        <button
          type="button"
          className="bb-btn bb-btn--go"
          onClick={() => {
            setDuelResult(null);
            startGame();
          }}
        >
          Play again
        </button>
        <button type="button" className="bb-btn" onClick={() => setScreen('menu')}>
          Menu
        </button>
      </div>
    );
  }

  if (screen === 'results' && result) {
    return (
      <div className="bb-menu">
        <h2 className="bb-title">Derby complete</h2>
        <div className="bb-score">{result.score.toLocaleString()}</div>
        <div className="bb-stats">
          <Stat k="Home runs" v={String(result.homeRuns)} />
          <Stat k="Barrels" v={String(result.barrels)} />
          <Stat k="Longest" v={`${result.bestFt.toFixed(0)} ft`} />
          <Stat k="Best streak" v={String(result.bestStreak)} />
        </div>
        <button
          type="button"
          className="bb-btn bb-btn--go"
          onClick={() => {
            setResult(null);
            startGame();
          }}
        >
          Play again
        </button>
        <button type="button" className="bb-btn" onClick={() => setScreen('menu')}>
          Menu
        </button>
      </div>
    );
  }

  return (
    <div className="bb-menu">
      <button type="button" className="bb-back" onClick={onExitToHub}>
        ‹ Games
      </button>
      <h2 className="bb-title">Home Run Derby</h2>
      <p className="bb-sub">
        {DERBY_ROUNDS} rounds × {PITCHES_PER_ROUND} pitches at {RANKED_PARK.name}. Aim the reticle
        between pitches — where you place it across the plate is your pull / oppo intent — then one
        tap to swing. Clear the wall; three outs a round is nothing, distance is everything.
      </p>
      <button
        type="button"
        className="bb-btn bb-btn--go"
        onClick={() => {
          // First user gesture — the WebAudio context can only be unlocked here.
          unlockAudio();
          setResult(null);
          setDuelResult(null);
          setMode('derby');
          startGame();
        }}
      >
        Play Derby
      </button>
      <p className="bb-sub">
        Or take both sides of it: {REGULATION_INNINGS} innings, three outs. You pitch the top —
        pick a pitch, drag back from the mound to aim, then tap to release — and bat the bottom.
      </p>
      <button
        type="button"
        className="bb-btn bb-btn--go"
        onClick={() => {
          unlockAudio();
          setResult(null);
          setDuelResult(null);
          setMode('duel');
          startGame();
        }}
      >
        Play Duel
      </button>
    </div>
  );
}
