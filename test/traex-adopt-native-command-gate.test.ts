import * as terminalService from '../src/services/traex-terminal-session.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PtyHandle } from '../src/adapters/cli/types.js';
import { findTraexRolloutSetByPid } from '../src/services/traex-transcript.js';
import {
  refreshTraexTerminalSession,
  traexTerminalIdentityNeedsRefresh,
  traexTerminalInputBlocked,
} from '../src/services/traex-terminal-session.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';

vi.mock('../src/services/traex-transcript.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/traex-transcript.js')>(),
  findTraexRolloutSetByPid: vi.fn(),
}));

const idle = (input = 'Implement {feature}') => ({
  viewport: `latest answer\n❯ ${input}\n▀▀▀▀▀\n  GPT-6 · Context 79% left\n  ? for shortcuts`,
  cursor: { x: 2, y: 1 },
});

async function blockedCommandHarness() {
  vi.useFakeTimers();
  vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
  let state = idle();
  const terminal: PtyHandle = {
    cliPid: 43212,
    write: vi.fn(),
    sendText: vi.fn((text: string) => { state = { ...idle(text), cursor: { x: text.length + 2, y: 1 } }; }),
    sendSpecialKeys: vi.fn(() => false),
    captureInputState: () => state,
  };
  const query = refreshTraexTerminalSession(terminal);
  await vi.runAllTimersAsync();
  expect(await query).toEqual({ kind: 'unavailable' });
  expect(traexTerminalInputBlocked(terminal)).toBe(true);

  const h = workerSubmitHarness();
  const { scope } = h;
  scope.pendingMessages.splice(0);
  scope.pendingRawInputs.splice(0);
  scope.pendingAdoptMessages.splice(0);
  const sendRaw = vi.fn(async () => {});
  const writeAdoptMessage = vi.fn(async () => 'completed');
  const fence = { backend: terminal };
  Object.assign(scope, {
    backend: terminal,
    traexTerminalBootstrapFailed: (pty: PtyHandle) => (terminalService as any).traexTerminalBootstrapFailed?.(pty) ?? false,
    lastInitConfig: { cliId: 'traex', adoptMode: true },
    isPromptReady: true,
    captureAdoptWriteFence: () => fence,
    adoptWriteFenceIsCurrent: () => true,
    runAdoptRawInputSequence: async (options: any) => {
      const sent = await options.writeRawInput();
      if (sent && options.writeFollowUp) await options.writeFollowUp();
    },
    runAdoptSessionRenameSequence: async (options: any) => { await options.writeRename(); return true; },
    sendRawCommandLineWithRecoveryFence: sendRaw,
    writeAdoptMessage,
    finalizeRawCommandDelivery: () => true,
    armSessionRenameIdleTimeout: vi.fn(),
    hasPendingInputForFlush: () => scope.pendingMessages.length > 0 || scope.pendingRawInputs.length > 0
      || scope.pendingAdoptMessages.length > 0 || scope.pendingSessionRename !== null,
    flushPending: h.flush,
  });
  scope.idleDetector.reset = vi.fn();
  scope.freshnessInputQueue.takeRaw = () => scope.pendingRawInputs.shift();
  scope.deliverRawInput = loadWorkerFunction('deliverRawInput', scope);
  return {
    h, scope, terminal, sendRaw, writeAdoptMessage,
    release: () => { state = idle(); },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('TRAE adopt native-command status-query gate', () => {
  it('defers raw passthrough without writing and releases the same command on a clean composer', async () => {
    const h = await blockedCommandHarness();
    const msg = {
      type: 'raw_input', content: '/model', turnId: 'raw-turn',
      followUpContent: 'follow up', followUpTurnId: 'follow-turn',
    };
    await h.scope.deliverRawInput(msg);
    expect(h.sendRaw).not.toHaveBeenCalled();
    expect(h.writeAdoptMessage).not.toHaveBeenCalled();
    expect(h.scope.pendingRawInputs).toEqual([msg]);

    h.release();
    expect(traexTerminalInputBlocked(h.terminal)).toBe(false);
    await h.h.flush();
    expect(h.sendRaw).toHaveBeenCalledExactlyOnceWith(h.terminal, '/model', expect.any(Function), 'raw-turn');
    expect(h.writeAdoptMessage).toHaveBeenCalledOnce();
    expect(h.writeAdoptMessage.mock.calls[0][0]).toBe('follow up');
    expect(h.scope.pendingRawInputs).toEqual([]);
  });

  it('re-drives held raw/bundle after a clean composer without retrying a failed bootstrap', async () => {
    const h = await blockedCommandHarness();
    const msg = {
      type: 'raw_input', content: '/model', turnId: 'raw-turn',
      followUpContent: 'follow up', followUpTurnId: 'follow-turn',
    };
    await h.scope.deliverRawInput(msg);
    expect(h.scope.pendingRawInputs).toEqual([msg]);
    h.release();
    Object.assign(h.scope, {
      structuredBridgeIs: (id: string) => id === 'traex',
      TRAEX_BRIDGE_PID_PROBE_INTERVAL_MS: 1000,
      traexBridgePidProbeLastMs: 0,
      currentTraexObservedPid: () => 43212,
      findTraexRolloutByPid: () => undefined,
      noteTraexProcessFileSource: vi.fn(),
      codexBridgeRolloutPath: undefined,
      traexTerminalIdentityNeedsRefresh,
      traexTerminalInputBlocked,
      refreshTraexTerminalSession,
      adoptWriteQueue: { run: (write: () => Promise<void>) => write() },
      persistCliSessionId: vi.fn(),
      codexBridgeNotifyCliSessionId: vi.fn(),
      codexBridgeIngest: vi.fn(),
      emitReadyCodexTurns: vi.fn(),
    });
    const poll = loadWorkerFunction('maybeFollowTraexSessionRotationViaPid', h.scope);
    poll();
    await vi.runAllTimersAsync();
    expect(h.sendRaw.mock.calls.map(call => call[1])).toEqual(['/model']);
    expect(h.writeAdoptMessage).toHaveBeenCalledOnce();
    expect(h.scope.pendingRawInputs).toEqual([]);
    expect(h.scope.codexBridgeNotifyCliSessionId).not.toHaveBeenCalled();
    expect(h.terminal.sendText).toHaveBeenCalledTimes(1);

    const queryCount = vi.mocked(h.terminal.sendText!).mock.calls.length;
    poll();
    await vi.runAllTimersAsync();
    expect(h.terminal.sendText).toHaveBeenCalledTimes(queryCount);
  });

  it('re-drives a held rename after the human clears a failed bootstrap, without reopening status', async () => {
    const h = await blockedCommandHarness();
    h.scope.pendingSessionRename = 'new title';
    h.scope.cliAdapter.buildSessionRenameCommand = (title: string) => `/rename ${title}`;
    h.release();
    Object.assign(h.scope, {
      structuredBridgeIs: (id: string) => id === 'traex',
      TRAEX_BRIDGE_PID_PROBE_INTERVAL_MS: 1000,
      traexBridgePidProbeLastMs: 0,
      currentTraexObservedPid: () => 43212,
      findTraexRolloutByPid: () => undefined,
      noteTraexProcessFileSource: vi.fn(),
      codexBridgeRolloutPath: undefined,
      traexTerminalIdentityNeedsRefresh,
      traexTerminalInputBlocked,
      refreshTraexTerminalSession,
      adoptWriteQueue: { run: (write: () => Promise<void>) => write() },
      persistCliSessionId: vi.fn(),
      codexBridgeNotifyCliSessionId: vi.fn(),
      codexBridgeIngest: vi.fn(),
      emitReadyCodexTurns: vi.fn(),
    });
    const poll = loadWorkerFunction('maybeFollowTraexSessionRotationViaPid', h.scope);
    poll();
    await vi.runAllTimersAsync();
    expect(h.sendRaw).toHaveBeenCalledExactlyOnceWith(h.terminal, '/rename new title');
    expect(h.scope.pendingSessionRename).toBeNull();
    expect(h.scope.codexBridgeNotifyCliSessionId).not.toHaveBeenCalled();

    const queryCount = vi.mocked(h.terminal.sendText!).mock.calls.length;
    poll();
    await vi.runAllTimersAsync();
    expect(h.terminal.sendText).toHaveBeenCalledTimes(queryCount);
  });

  it('holds native rename before any bytes and sends it after the same clean-composer release', async () => {
    const h = await blockedCommandHarness();
    h.scope.pendingSessionRename = 'new title';
    h.scope.cliAdapter.buildSessionRenameCommand = (title: string) => `/rename ${title}`;
    await h.h.flush();
    expect(h.sendRaw).not.toHaveBeenCalled();
    expect(h.scope.pendingSessionRename).toBe('new title');

    h.release();
    await h.h.flush();
    expect(h.sendRaw).toHaveBeenCalledExactlyOnceWith(h.terminal, '/rename new title');
    expect(h.scope.pendingSessionRename).toBeNull();
  });
});


describe('TRAE adopted bootstrap failure notification', () => {
  function harness(needsRefresh = false, resolution: any = { kind: 'unavailable' }) {
    const terminal = { cliPid: 43212 };
    const fence = { backend: terminal };
    let current = true;
    const send = vi.fn();
    const scope: any = {
      backend: terminal, structuredBridgeIs: () => true, lastInitConfig: { adoptMode: true },
      TRAEX_BRIDGE_PID_PROBE_INTERVAL_MS: 1000, traexBridgePidProbeLastMs: 0,
      currentTraexObservedPid: () => terminal.cliPid, log: vi.fn(),
      findTraexRolloutByPid: () => undefined, noteTraexProcessFileSource: vi.fn(),
      captureAdoptWriteFence: () => fence, adoptWriteFenceIsCurrent: () => current,
      adapterInputHandle: (b: any) => b,
      traexTerminalIdentityNeedsRefresh: () => needsRefresh,
      traexTerminalBootstrapFailed: () => resolution.kind !== 'terminal',
      traexTerminalInputBlocked: () => true, hasPendingInputForFlush: () => false,
      refreshTraexTerminalSession: vi.fn(async () => { needsRefresh = false; return resolution; }),
      adoptWriteQueue: { run: (f: any) => f() },
      persistCliSessionId: vi.fn(), codexBridgeNotifyCliSessionId: vi.fn(),
      codexBridgeIngest: vi.fn(), emitReadyCodexTurns: vi.fn(), isPromptReady: true,
      send,
    };
    return { scope, terminal, send, poll: loadWorkerFunction<() => void>('maybeFollowTraexSessionRotationViaPid', scope), cancel: () => { current = false; } };
  }

  it.each([false, true])('notifies actual failure once across repeated ticks (initial-query=%s)', async initialQuery => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const h = harness(initialQuery);
    h.poll(); await vi.runAllTimersAsync();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0][0]).toMatchObject({ type: 'user_notify' });
    expect(h.send.mock.calls[0][0].message).toMatch(/会话/);
    expect(h.send.mock.calls[0][0].message).toMatch(/(?:结束|完成).*通知/);
    expect(h.send.mock.calls[0][0].message).toMatch(/重新.*adopt/);
    vi.setSystemTime(12000); h.poll(); await vi.runAllTimersAsync();
    expect(h.send).toHaveBeenCalledTimes(1);
    h.terminal.cliPid++; vi.setSystemTime(14000); h.poll(); await vi.runAllTimersAsync();
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it.each(['not-started', 'pending', 'success', 'cancelled'])('does not notify %s discovery', async situation => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const h = harness(situation === 'success' || situation === 'cancelled', situation === 'success' ? { kind: 'terminal', sessionId: '01a0ec3d-3751-7882-9b25-49bc90078561' } : { kind: 'unavailable' });
    if (situation === 'not-started' || situation === 'pending') h.scope.traexTerminalBootstrapFailed = () => false;
    if (situation === 'cancelled') {
      h.scope.refreshTraexTerminalSession = async () => { h.cancel(); return { kind: 'unavailable' }; };
    }
    h.poll(); await vi.runAllTimersAsync();
    expect(h.send).not.toHaveBeenCalled();
    if (situation === 'success') expect(h.scope.codexBridgeNotifyCliSessionId).toHaveBeenCalledTimes(1);
  });
});
