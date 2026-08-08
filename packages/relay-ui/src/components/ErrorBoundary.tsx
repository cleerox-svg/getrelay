import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { CHUNK_RECOVER_KEY, hardRecover, isChunkLoadError } from '../lib/recover';

// Top-level error boundary. Without one, a single throw during render in ANY
// screen unmounts the whole React tree and leaves a blank (black, in dark mode)
// page with no message — indistinguishable from a dead app. This catches such
// errors and shows the actual message + stack on a high-contrast panel (styled
// inline, no design-system deps so it can't itself fail), plus a Reload button.
// Errors in event handlers / async effects are NOT caught by React boundaries —
// only render/lifecycle errors — which is exactly the "screen goes black on
// mount" class we need to surface.
interface State {
  error: Error | null;
  info: ErrorInfo | null;
  recovering: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, info: null, recovering: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep it in the console too (for remote debugging / logs).
    // eslint-disable-next-line no-console
    console.error('[Relay] uncaught render error', error, info);
    this.setState({ info });

    // A dynamic-import / chunk-load failure (React.lazy's import() rejection
    // surfaces here, NOT via vite:preloadError) almost always means a poisoned
    // SW cache is serving a stale asset set whose chunk hash was pruned by a
    // newer deploy. Auto-run hardRecover() ONCE per session to wipe caches +
    // unregister the SW and reload onto the fresh asset set. The shared
    // sessionStorage one-shot guard (CHUNK_RECOVER_KEY, also set by main.tsx's
    // preloadError handler) survives the reload so we can't loop: if recovery
    // already ran this session — via either path — fall through to the error UI
    // (its Reload button still runs hardRecover, but that's now user-initiated).
    if (isChunkLoadError(error)) {
      let alreadyTried = false;
      try {
        alreadyTried = sessionStorage.getItem(CHUNK_RECOVER_KEY) === '1';
        sessionStorage.setItem(CHUNK_RECOVER_KEY, '1');
      } catch {
        // Storage blocked — don't risk a reload loop; show the error UI.
        return;
      }
      if (!alreadyTried) {
        this.setState({ recovering: true });
        void hardRecover();
      }
    }
  }

  private handleReload = (): void => {
    this.setState({ recovering: true });
    void hardRecover();
  };

  override render(): ReactNode {
    const { error, info, recovering } = this.state;
    if (!error) return this.props.children;

    const stack = (error.stack ?? String(error)).split('\n').slice(0, 12).join('\n');
    const componentStack = (info?.componentStack ?? '').split('\n').slice(0, 12).join('\n');

    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 99999,
          background: '#0b1220',
          color: '#e8eef7',
          font: '13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
          padding: 'max(env(safe-area-inset-top), 20px) 18px 20px',
          overflow: 'auto',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 8, color: '#ff6b6b' }}>
          Something went wrong
        </div>
        <div style={{ marginBottom: 12, color: '#aab6c8' }}>
          The app hit an error while rendering. Details below — please screenshot this.
        </div>
        <div style={{ fontWeight: 700, color: '#ffd166', wordBreak: 'break-word' }}>
          {error.name}: {error.message}
        </div>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 8, color: '#c7d2e0' }}>
          {stack}
        </pre>
        {componentStack ? (
          <>
            <div style={{ fontWeight: 700, marginTop: 10, color: '#9fb2c8' }}>Component stack</div>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#8ea3ba' }}>
              {componentStack}
            </pre>
          </>
        ) : null}
        <button
          type="button"
          onClick={this.handleReload}
          disabled={recovering}
          style={{
            marginTop: 16,
            padding: '10px 18px',
            borderRadius: 10,
            border: '1px solid #2a3a55',
            background: '#2f7fd0',
            color: '#fff',
            fontSize: 14,
            fontWeight: 700,
            opacity: recovering ? 0.7 : 1,
          }}
        >
          {recovering ? 'Clearing cache…' : 'Reload'}
        </button>
      </div>
    );
  }
}
