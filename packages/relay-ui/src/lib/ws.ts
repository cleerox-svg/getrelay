import { API_BASE } from './api';
import type { ClientMsg, ServerMsg } from './types';

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
const WS_URL =
  API_BASE.replace(/^http(s?):\/\//, (_m: string, s: string) => `ws${s}://`) + '/ws';

type Listener = (msg: ServerMsg) => void;
type StatusListener = (status: WsStatus) => void;
export type WsStatus = 'idle' | 'connecting' | 'open' | 'closed';

class WsClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private status: WsStatus = 'idle';
  private retry = 0;
  private outbox: ClientMsg[] = [];
  private shouldRun = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  start(): void {
    this.shouldRun = true;
    if (!this.ws) this.connect();
  }

  stop(): void {
    this.shouldRun = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.setStatus('idle');
  }

  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.outbox.push(msg);
      if (this.shouldRun && !this.ws) this.connect();
    }
  }

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  getStatus(): WsStatus {
    return this.status;
  }

  private connect(): void {
    if (!this.shouldRun) return;
    this.setStatus('connecting');
    try {
      this.ws = new WebSocket(WS_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.retry = 0;
      this.setStatus('open');
      const queued = this.outbox.splice(0);
      for (const m of queued) this.ws!.send(JSON.stringify(m));
    };
    this.ws.onmessage = (ev) => {
      let parsed: ServerMsg;
      try {
        parsed = JSON.parse(ev.data as string) as ServerMsg;
      } catch {
        return;
      }
      for (const l of this.listeners) l(parsed);
    };
    this.ws.onclose = () => {
      this.ws = null;
      this.setStatus('closed');
      this.scheduleReconnect();
    };
    this.ws.onerror = () => {
      // onclose will follow.
    };
  }

  private scheduleReconnect(): void {
    if (!this.shouldRun) return;
    const delay = RECONNECT_DELAYS[Math.min(this.retry, RECONNECT_DELAYS.length - 1)] ?? 30000;
    this.retry += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setStatus(s: WsStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }
}

export const ws = new WsClient();
