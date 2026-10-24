'use client';

/* eslint-disable react-hooks/set-state-in-effect -- This hook synchronizes an external WebSocket/session lifecycle, including reconnect loading state. */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DemoAction, DemoIdentity, DemoState, DemoWorld } from './demo-types';

const STORAGE_KEY = 'furward-demo-session-v1';
class DemoError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}

async function api<T>(path: string, identity?: DemoIdentity, body?: unknown, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, 15000);
  try {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(identity ? { Authorization: `Bearer ${identity.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, cache: 'no-store',
    });
    const json = await response.json().catch(() => ({})) as { ok?: boolean; message?: string; error?: string; data?: T };
    if (!response.ok || !json.ok) throw new DemoError(json.message || '服务暂时无法连接，请重试。', json.error || 'NETWORK');
    return json.data as T;
  } catch (reason) {
    if (reason instanceof DemoError) throw reason;
    throw new DemoError('连接暂时中断，请稍后重试。', 'NETWORK');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export function useDemoSession() {
  const [world, setWorld] = useState<DemoWorld | null>(null);
  const [state, setState] = useState<DemoState | null>(null);
  const [connection, setConnection] = useState<'loading' | 'online' | 'reconnecting' | 'error'>('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const identityRef = useRef<DemoIdentity | null>(null);
  const stateRef = useRef<DemoState | null>(null);
  const busyRef = useRef(false);
  const receivedAt = useRef(0);
  const epochRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const onlineRef = useRef(false);

  const isCurrent = useCallback((identity: DemoIdentity, epoch: number) => (
    epoch === epochRef.current && identity === identityRef.current
  ), []);

  const accept = useCallback((next: DemoState, identity: DemoIdentity, epoch: number) => {
    if (!isCurrent(identity, epoch) || next.session_id !== identity.session_id) return false;
    const current = stateRef.current;
    if (current && current.session_id === next.session_id && next.revision <= current.revision) return true;
    stateRef.current = next;
    receivedAt.current = performance.now();
    setState(next);
    return true;
  }, [isCurrent]);

  useEffect(() => {
    const epoch = ++epochRef.current;
    let cancelled = false;
    let socket: WebSocket | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    const controller = new AbortController();
    controllerRef.current = controller;
    const active = () => !cancelled && epochRef.current === epoch;
    identityRef.current = null;
    onlineRef.current = false;
    busyRef.current = false;
    setBusy(false);
    setConnection('loading');
    setError('');

    const replaceExpired = (message: string) => {
      if (!active()) return;
      try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* optional storage */ }
      identityRef.current = null;
      onlineRef.current = false;
      setConnection('loading');
      setNotice(message);
      setAttempt(value => value + 1);
    };

    const connect = () => {
      const identity = identityRef.current;
      if (!active() || !identity) return;
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/demo`);
      socket = ws;
      const currentSocket = () => active() && isCurrent(identity, epoch) && socket === ws;
      const disconnected = (code: number) => {
        if (!currentSocket()) return;
        socket = undefined; // Fence queued callbacks from this socket immediately.
        if (heartbeat) clearInterval(heartbeat);
        if (watchdog) clearTimeout(watchdog);
        onlineRef.current = false;
        if ([4001, 4004, 4401, 4404, 1008].includes(code)) {
          replaceExpired('上次体验已过期，已为你准备新的路线。');
          return;
        }
        setConnection('reconnecting');
        reconnect = setTimeout(async () => {
          if (!active() || !isCurrent(identity, epoch)) return;
          try {
            const saved = await api<DemoState>(`/api/demo/sessions/${identity.session_id}`, identity, undefined, controller.signal);
            if (!active() || !isCurrent(identity, epoch)) return;
            accept(saved, identity, epoch);
            connect();
          } catch (reason) {
            if (!active() || !isCurrent(identity, epoch)) return;
            if (reason instanceof DemoError && ['AUTH', 'NOT_FOUND'].includes(reason.code)) {
              replaceExpired('上次体验已过期，已为你准备新的路线。');
            } else connect();
          }
        }, Math.min(8000, 800 * 2 ** Math.min(retries++, 4)));
      };
      const renewWatchdog = () => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          if (!currentSocket()) return;
          // Do not wait for the browser's TCP close event on a half-open link.
          disconnected(4000);
          ws.close(4000, 'Heartbeat timeout');
        }, 15000);
      };
      ws.onopen = () => {
        if (!currentSocket()) { ws.close(); return; }
        ws.send(JSON.stringify(identity));
        renewWatchdog();
        heartbeat = setInterval(() => {
          if (!currentSocket()) return;
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 5000);
      };
      ws.onmessage = (event) => {
        if (!currentSocket()) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'pong') renewWatchdog();
          if (message.type === 'demo.state' && accept(message.data, identity, epoch)) {
            retries = 0;
            onlineRef.current = true;
            setConnection('online');
            setError('');
          }
        } catch { /* A malformed transport message cannot change navigation state. */ }
      };
      ws.onclose = (event) => disconnected(event.code);
    };

    const initialize = async () => {
      try {
        const loadedWorld = await api<DemoWorld>('/api/demo/world', undefined, undefined, controller.signal);
        if (!active()) return;
        setWorld(loadedWorld);
        let identity: DemoIdentity | null = null;
        try { identity = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null'); } catch { /* optional storage */ }
        if (identity && typeof identity.session_id === 'string' && typeof identity.token === 'string') {
          try {
            const saved = await api<DemoState>(`/api/demo/sessions/${identity.session_id}`, identity, undefined, controller.signal);
            if (!active()) return;
            identityRef.current = identity;
            accept(saved, identity, epoch);
          } catch (reason) {
            if (!active()) return;
            if (!(reason instanceof DemoError) || !['AUTH', 'NOT_FOUND'].includes(reason.code)) throw reason;
            identity = null;
            setNotice('上次体验已过期，已为你准备新的路线。');
          }
        } else identity = null;
        if (!identity) {
          const created = await api<DemoIdentity & { state: DemoState }>('/api/demo/sessions', undefined, {}, controller.signal);
          if (!active()) return;
          identity = { session_id: created.session_id, token: created.token };
          identityRef.current = identity;
          try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(identity)); } catch { /* Session still works without persistence. */ }
          accept(created.state, identity, epoch);
        }
        connect();
      } catch (reason) {
        if (!active()) return;
        setConnection('error');
        setError(reason instanceof Error ? reason.message : '无法载入体验，请重试。');
      }
    };
    void initialize();
    return () => {
      cancelled = true;
      epochRef.current = epoch + 1;
      identityRef.current = null;
      onlineRef.current = false;
      controllerRef.current = null;
      controller.abort();
      if (reconnect) clearTimeout(reconnect);
      if (heartbeat) clearInterval(heartbeat);
      if (watchdog) clearTimeout(watchdog);
      socket?.close();
    };
  }, [accept, attempt, isCurrent]);

  const request = useCallback(async (kind: 'actions' | 'text', body: unknown) => {
    const identity = identityRef.current;
    const epoch = epochRef.current;
    if (!identity || !onlineRef.current || busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      if (kind === 'text') {
        const result = await api<{ reply: string; state: DemoState }>(`/api/demo/sessions/${identity.session_id}/text`, identity, body, controllerRef.current?.signal);
        return accept(result.state, identity, epoch) ? result.reply : null;
      }
      const result = await api<DemoState>(`/api/demo/sessions/${identity.session_id}/actions`, identity, body, controllerRef.current?.signal);
      return accept(result, identity, epoch) ? result.message : null;
    } catch (reason) {
      if (!isCurrent(identity, epoch)) return null;
      setError(reason instanceof Error ? reason.message : '操作未完成，请重试。');
      if (reason instanceof DemoError && ['AUTH', 'NOT_FOUND'].includes(reason.code)) {
        try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* optional storage */ }
        identityRef.current = null;
        onlineRef.current = false;
        setConnection('loading');
        setNotice('会话已过期，这次操作未执行，请在新路线中重新操作。');
        setAttempt(value => value + 1);
      }
      return null;
    } finally {
      // An older request must not unlock a newer session's pending operation.
      if (epoch === epochRef.current) { busyRef.current = false; setBusy(false); }
    }
  }, [accept, isCurrent]);

  return {
    world, state, stateRef, receivedAt, connection, error, notice, busy,
    action: (action: DemoAction) => request('actions', { action }),
    sendText: (text: string) => request('text', { text }),
    retry: () => setAttempt(value => value + 1),
  };
}
