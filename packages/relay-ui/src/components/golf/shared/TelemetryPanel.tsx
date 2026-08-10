import { useState } from 'react';

// A completed shot's full record — captured for the in-app telemetry panel and
// the "Copy telemetry" export, so real device numbers can be compared against the
// headless harness. One per shot that comes to rest. `result` is left as a string
// so both the Range (ShotResult) and Course (CourseResult) can feed it without
// coupling the shared panel to either sim's result union.
export interface ShotTelemetry {
  club: string;
  powerPct: number;
  aimDeg: number;
  spinBack: number;
  spinSide: number;
  accuracy: number;
  carry: number;
  total: number;
  apex: number;
  ballSpeed: number;
  lateral: number;
  result: string;
  ts: number;
}

// A tiny debug toggle + collapsible last-shot panel with a Copy-to-clipboard
// export of the rolling shot log. Unobtrusive, pinned to the left edge, clear of
// the central drag channel. Owns its open/copy UI state; the parent just supplies
// the last shot and the rolling `log`. Shared by the Range and the Course. Pure
// DOM / theme CSS-vars — no `three`.
export function TelemetryPanel({
  lastShot,
  log,
}: {
  lastShot: ShotTelemetry | null;
  log: ShotTelemetry[];
}) {
  const [debugOpen, setDebugOpen] = useState(false);
  const [copyMsg, setCopyMsg] = useState('');

  // Copy the rolling telemetry log as JSON to the clipboard, guarded for
  // environments (older WebViews) without the async clipboard API.
  const copyTelemetry = async () => {
    const json = JSON.stringify(log, null, 2);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(json);
        setCopyMsg(`Copied ${log.length}`);
      } else {
        setCopyMsg('No clipboard');
      }
    } catch {
      setCopyMsg('Copy failed');
    }
    window.setTimeout(() => setCopyMsg(''), 1500);
  };

  return (
    <div
      style={{
        position: 'absolute',
        left: 'calc(env(safe-area-inset-left, 0px) + 10px)',
        top: '50%',
        transform: 'translateY(-50%)',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        pointerEvents: 'none',
        zIndex: 40,
      }}
    >
      <button
        type="button"
        onClick={() => setDebugOpen((o) => !o)}
        aria-label="Toggle shot telemetry"
        style={{
          pointerEvents: 'auto',
          width: 26,
          height: 26,
          borderRadius: 8,
          border: '1px solid var(--separator)',
          background: 'var(--card-bg)',
          color: debugOpen ? 'var(--accent)' : 'var(--text-dim)',
          fontSize: 15,
          fontWeight: 800,
          lineHeight: 1,
          boxShadow: '0 2px 8px rgba(0,0,0,0.16)',
        }}
      >
        ﹒
      </button>
      {debugOpen ? (
        <div
          style={{
            pointerEvents: 'auto',
            width: 188,
            background: 'var(--card-bg)',
            border: '1px solid var(--separator)',
            borderRadius: 12,
            padding: 10,
            boxShadow: '0 4px 14px rgba(0,0,0,0.28)',
            fontSize: 11,
            color: 'var(--text)',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 6,
            }}
          >
            <span style={{ fontWeight: 800, letterSpacing: 0.5 }}>DEBUG</span>
            <span style={{ color: 'var(--text-dim)' }}>{log.length} logged</span>
          </div>
          {lastShot ? (
            <div className="tabular-nums" style={{ lineHeight: 1.5 }}>
              <div>
                {lastShot.club} · {lastShot.powerPct}% · aim {lastShot.aimDeg}°
              </div>
              <div>
                carry {lastShot.carry} · total {lastShot.total} · {lastShot.result}
              </div>
              <div>
                apex {lastShot.apex} · ball {lastShot.ballSpeed} · lat {lastShot.lateral}
              </div>
              <div>
                spin b{lastShot.spinBack}/s{lastShot.spinSide} · acc {lastShot.accuracy}
              </div>
            </div>
          ) : (
            <div style={{ color: 'var(--text-dim)' }}>No shots yet</div>
          )}
          <button
            type="button"
            onClick={copyTelemetry}
            disabled={log.length === 0}
            style={{
              pointerEvents: 'auto',
              width: '100%',
              marginTop: 8,
              borderRadius: 8,
              border: '1px solid var(--separator)',
              background: 'var(--accent)',
              color: '#fff',
              fontSize: 12,
              fontWeight: 700,
              padding: '6px 0',
              opacity: log.length === 0 ? 0.5 : 1,
            }}
          >
            {copyMsg || 'Copy telemetry'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
