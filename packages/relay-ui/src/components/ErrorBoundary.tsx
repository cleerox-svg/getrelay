import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

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
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep it in the console too (for remote debugging / logs).
    // eslint-disable-next-line no-console
    console.error('[Relay] uncaught render error', error, info);
    this.setState({ info });
  }

  override render(): ReactNode {
    const { error, info } = this.state;
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
          onClick={() => window.location.reload()}
          style={{
            marginTop: 16,
            padding: '10px 18px',
            borderRadius: 10,
            border: '1px solid #2a3a55',
            background: '#2f7fd0',
            color: '#fff',
            fontSize: 14,
            fontWeight: 700,
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
