import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { TraexAutoModelController, traexAutoModelPreflightEnabled } from '../src/services/traex-auto-model.js';
import { traexCapacityQueueVisible, traexModelProgressVisible, traexQueuedTypeAheadVisible } from '../src/adapters/cli/traex.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { beginRuntimeWriteCycle } from '../src/utils/runtime-screen-status.js';
import { finalizeRawCommandDelivery } from '../src/core/raw-command-writer.js';
import { programStatusBlockHoldsTypeAhead } from '../src/core/program-status-gate.js';
import { pendingInputAllowsTypeAhead } from '../src/utils/pending-input-queue.js';
import { sendTuiKeySequence, submitTuiTextInput } from '../src/utils/tui-input-delivery.js';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { traeHistoryPath } from '../src/services/traex-paths.js';
import { traexQuestionFlowVisible } from '../src/utils/traex-question-page.js';
import { ProgramStatusFramingStream } from '../src/utils/program-status-parser.js';
import { setImmediate } from 'node:timers';

// Capture the real turn boundary BEFORE fake timers are installed. Advancing
// fake time by zero only drains one microtask in Bun's Vitest compatibility
// layer; it does not prove a later async viewport/adapter stage was reached.
const yieldAsyncTurn = setImmediate;
async function waitForAsyncBoundary(reached: () => boolean, label: string): Promise<void> {
  for (let turn = 0; turn < 64; turn++) {
    if (reached()) return;
    // Do not advance the fake 200ms paste → Enter timer to wait for paste.
    await new Promise<void>(resolve => yieldAsyncTurn(resolve));
  }
  throw new Error(`Async boundary not reached: ${label}`);
}

async function settleTriggeredFlushes(scope: Record<string, any>): Promise<void> {
  // onPtyData fires and forgets the real flush. Await its actual returned
  // promises, not an assumed number of microtasks or extra fake milliseconds.
  await Promise.all(scope.flushPending.mock.results.map((result: { value: unknown }) => result.value));
}

afterEach(() => { vi.useRealTimers(); });

function idleAdmissionHarness() {
  const h = workerSubmitHarness();
  const { scope } = h;
  const controller = new TraexAutoModelController({
    enabled: true, trigger: 'capacity', models: ['core', 'backup'],
    reselectPerTurn: false, preflightLoadCheck: false, queueTimeoutMs: 5_000,
  });
  controller.beginTurn('previous');
  scope.pendingMessages.splice(0, scope.pendingMessages.length, { content: 'follow-up', turnId: 'next' });
  Object.assign(scope, {
    backend: { captureViewportAsync: vi.fn(async () => '❯ Use /skills to list available skills') },
    traexAutoModelRuntimeEligible: () => true,
    traexAutoModelController: controller, traexAutoModelSwitching: false,
    traexAutoModelTurnReplayForbidden: false, traexAutoModelPreflightPending: false,
    traexAutoModelPreflightEnabled, activeTurnAuthority: new ActiveTurnAuthority(),
    currentBotmuxTurnId: 'previous', backendScreenRevision: 0, observedPaneGridRevision: 0,
    renderer: null, backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    commandLineWritesPending: 0, injectionFlushing: false,
    currentPostTerminalInputFence: () => null, retryTraexAutoModelAdmission: vi.fn(),
    traexCapacityQueueVisible, traexModelProgressVisible, traexQueuedTypeAheadVisible,
    traexAutoModelInputHold: () => false,
    promptReadinessRevision: 0, webTerminalInputGeneration: 0,
    beginRuntimeWriteCycle, backgroundTaskTracker: { noteMainTurn: vi.fn() },
    publishActiveRuntime: vi.fn(), markTurnRetired: vi.fn(),
    acknowledgeTurnInputCommitted: vi.fn(),
    maybeQueuePostSubmitNativeSessionTitle: vi.fn(),
  });
  scope.resetTraexAutoModelBeforePendingTurn = loadWorkerFunction('resetTraexAutoModelBeforePendingTurn', scope);
  scope.admitTraexAutoModelPendingInput = loadWorkerFunction('admitTraexAutoModelPendingInput', scope);
  scope.deferNativeCodexInputCommit = loadWorkerFunction('deferNativeCodexInputCommit', scope);
  scope.deferTurnInputCommitUntilSubmission = loadWorkerFunction('deferTurnInputCommitUntilSubmission', scope);
  scope.idleDetector.reset = vi.fn();
  scope.revokePromptReadiness = loadWorkerFunction('revokePromptReadiness', scope);
  scope.beginCliWriteCycle = loadWorkerFunction('beginCliWriteCycle', scope);
  scope.cliAdapter.writeInput = vi.fn(async () => ({ submitted: true }));
  return h;
}

function nativeResumeAdmissionHarness() {
  const h = idleAdmissionHarness();
  const { scope } = h;
  const detector = new IdleDetector(createCliAdapterSync('traex'));
  scope.idleDetector = detector;
  scope.pendingInputAllowsTypeAhead = pendingInputAllowsTypeAhead;
  scope.programStatusBlockHoldsTypeAhead = programStatusBlockHoldsTypeAhead;
  scope.programStatusBlockedHoldsTypeAhead = loadWorkerFunction('programStatusBlockedHoldsTypeAhead', scope);
  scope.cliAdapter.programStatusBlockedHoldsInput = true;
  // A native wake starts after a Botmux-owned input cycle has ended. Use the
  // real detector to retire the predecessor, including its stale root report.
  detector.reset({ inputCycle: true });
  detector.observeProgramStatus({ state: 'working' });
  detector.fireIdle();
  scope.isPromptReady = false;
  detector.onBusy(() => scope.revokePromptReadiness());
  scope.backend.captureViewportAsync.mockResolvedValue('◆ Working… (1s • esc to interrupt)');
  return { ...h, detector };
}

describe('auto-model admission while a native TraeX turn resumes', () => {
  it.each([
    { name: 'rejected working id', payload: 'state=working:app=traecli:id=bad//id', live: true, accepted: false },
    { name: 'rejected clear id', payload: 'state=clear:app=traecli:id=bad//id', live: true, accepted: false },
    { name: 'working replay', payload: 'state=working:app=traecli', live: false, accepted: false },
    { name: 'clear replay', payload: 'state=clear:app=traecli:id=child', live: false, accepted: false },
    { name: 'invalid state', payload: 'state=bogus:app=traecli', live: true, accepted: false },
    { name: 'live working', payload: 'state=working:app=traecli', live: true, accepted: true },
    { name: 'live clear', payload: 'state=clear:app=traecli:id=child', live: true, accepted: true },
  ])('redrives only an accepted live status ($name), not cached working alone', async ({ payload, live, accepted }) => {
    vi.useFakeTimers();
    const h = nativeResumeAdmissionHarness();
    const { scope, detector } = h;
    detector.observeProgramStatus({ state: 'working' });
    Object.assign(scope, {
      programStatusStream: new ProgramStatusFramingStream(), spawnArgvNeedsWorkingSeed: false,
      traexQuestionBlockReported: () => false, traexQuestionBridgeActive: () => false,
      handlePtyDataChunk: vi.fn(), flushPending: vi.fn(h.flush),
    });
    expect(detector.programStatusHeldWorking()).toBe(true);
    loadWorkerFunction('onPtyData', scope)(`\x1b]7501;${payload}\x1b\\`, live);
    await settleTriggeredFlushes(scope);
    expect(scope.flushPending).toHaveBeenCalledTimes(accepted ? 1 : 0);
    expect(scope.cliAdapter.writeInput).toHaveBeenCalledTimes(accepted ? 1 : 0);
    expect(scope.pendingMessages).toHaveLength(accepted ? 0 : 1);
  });

  it('does not redrive a native report ignored before the first input cycle', async () => {
    vi.useFakeTimers();
    const h = nativeResumeAdmissionHarness();
    const detector = h.scope.idleDetector = new IdleDetector(createCliAdapterSync('traex'));
    Object.assign(h.scope, {
      programStatusStream: new ProgramStatusFramingStream(), spawnArgvNeedsWorkingSeed: false,
      traexQuestionBlockReported: () => false, traexQuestionBridgeActive: () => false,
      flushPending: vi.fn(h.flush),
    });
    loadWorkerFunction('onPtyData', h.scope)('\x1b]7501;state=working:app=traecli\x1b\\');
    await settleTriggeredFlushes(h.scope);
    expect(detector.lastProgramStatusReport()).toBe('working');
    expect(detector.programStatusHeldWorking()).toBe(false);
    expect(h.scope.flushPending).not.toHaveBeenCalled();
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    detector.dispose();
  });

  it.each(['permission', 'auth', undefined])('refuses the admission snapshot itself when blocked (%s) arrives during capture', async kind => {
    const h = nativeResumeAdmissionHarness();
    h.detector.observeProgramStatus({ state: 'working' });
    const head = h.scope.pendingMessages[0];
    let release!: (screen: string) => void;
    h.scope.backend.captureViewportAsync.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const admission = h.scope.admitTraexAutoModelPendingInput(head);
    h.detector.observeProgramStatus({ state: 'blocked', ...(kind !== undefined ? { kind } : {}) });
    release('◆ Working… (1s • esc to interrupt)');
    expect(await admission).toBe(false);
    expect(h.scope.pendingMessages).toEqual([head]);
  });

  it.each(['root', 'child'] as const)('redrives a retained input from native %s release after its earlier retry has elapsed', async owner => {
    vi.useFakeTimers();
    const h = nativeResumeAdmissionHarness();
    const { scope, detector } = h;
    detector.observeProgramStatus({ state: 'working' });
    scope.flushPending = vi.fn(h.flush);
    scope.retryTraexAutoModelAdmission = loadWorkerFunction('retryTraexAutoModelAdmission', scope);
    scope.programStatusStream = new ProgramStatusFramingStream();
    scope.spawnArgvNeedsWorkingSeed = false;
    scope.traexQuestionBlockReported = () => false;
    scope.traexQuestionBridgeActive = () => false;
    const onData = loadWorkerFunction('onPtyData', scope);
    const report = (state: string, kind?: string) => onData(`\x1b]7501;state=${state}:app=traecli${kind ? `:kind=${kind}` : ''}${owner === 'child' ? ':id=approval-child' : ''}\x1b\\`);
    let release!: (screen: string) => void;
    scope.backend.captureViewportAsync.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const pending = h.flush();
    await waitForAsyncBoundary(() => scope.backend.captureViewportAsync.mock.calls.length > 0, 'native viewport capture');
    report('blocked', 'permission');
    release('◆ Working… (1s • esc to interrupt)');
    await pending;
    await vi.advanceTimersByTimeAsync(1000);
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(scope.pendingMessages).toHaveLength(1);
    report('clear');
    if (owner === 'root') report('working');
    await settleTriggeredFlushes(scope);
    expect(scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    expect(scope.pendingMessages).toEqual([]);
    expect(scope.isPromptReady).toBe(false);
  });

  it.each(['permission', 'auth', 'approval', undefined].flatMap(kind =>
    (['root', 'child'] as const).map(owner => ({ owner, kind })),
  ))('retains input when $owner blocked ($kind) arrives during capture and retries only after native release', async ({ owner, kind }) => {
    vi.useFakeTimers();
    const h = nativeResumeAdmissionHarness();
    const { scope, detector } = h;
    detector.observeProgramStatus({ state: 'working' });
    scope.flushPending = vi.fn(h.flush);
    scope.retryTraexAutoModelAdmission = loadWorkerFunction('retryTraexAutoModelAdmission', scope);
    const head = scope.pendingMessages[0];
    let release!: (screen: string) => void;
    scope.backend.captureViewportAsync.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const pending = h.flush();
    await waitForAsyncBoundary(() => scope.backend.captureViewportAsync.mock.calls.length > 0, 'native viewport capture');
    expect(scope.backend.captureViewportAsync).toHaveBeenCalledOnce();
    const readinessRevision = scope.promptReadinessRevision;
    detector.observeProgramStatus({ state: 'blocked', ...(kind !== undefined ? { kind } : {}), ...(owner === 'child' ? { id: 'approval-child' } : {}) });
    // Already busy → blocked does not fire onBusy. Do NOT fake a readiness
    // revoke: the write-edge itself must reject the old working snapshot.
    expect(scope.promptReadinessRevision).toBe(readinessRevision);
    release('◆ Working… (1s • esc to interrupt)');
    await pending;
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(scope.pendingMessages).toEqual([head]);
    await h.flush();
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    if (owner === 'child') detector.observeProgramStatus({ state: 'clear', id: 'approval-child' });
    else {
      detector.observeProgramStatus({ state: 'clear' });
      detector.observeProgramStatus({ state: 'working' });
    }
    await vi.advanceTimersByTimeAsync(201);
    await settleTriggeredFlushes(scope);
    expect(scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    expect(scope.pendingMessages).toEqual([]);
    expect(scope.isPromptReady).toBe(false);
  });

  it.each(['opening composer', 'question capture'].flatMap(phase =>
    ['permission', 'auth', undefined].map(kind => ({ phase, kind })),
  ))('rechecks blocked ($kind) before dequeue after awaiting $phase', async ({ phase, kind }) => {
    vi.useFakeTimers();
    const h = nativeResumeAdmissionHarness();
    const { scope, detector } = h;
    detector.observeProgramStatus({ state: 'working' });
    scope.flushPending = vi.fn(h.flush);
    scope.retryTraexAutoModelAdmission = loadWorkerFunction('retryTraexAutoModelAdmission', scope);
    const head = scope.pendingMessages[0];
    let release!: (result: any) => void;
    let awaited;
    if (phase === 'opening composer') {
      scope.openingInputBoxSettled = false;
      scope.inputBoxJudgeable = () => true;
      awaited = scope.cliAdapter.settleInputBox = vi.fn(async () => undefined)
        .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    } else {
      scope.traexQuestionBridgeActive = () => true;
      awaited = scope.traexQuestionHoldsQueuedWrite = vi.fn(async () => false)
        .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    }
    const pending = h.flush();
    await waitForAsyncBoundary(() => awaited.mock.calls.length > 0, phase);
    expect(awaited).toHaveBeenCalledOnce();
    const readinessRevision = scope.promptReadinessRevision;
    detector.observeProgramStatus({ state: 'blocked', ...(kind !== undefined ? { kind } : {}) });
    expect(scope.promptReadinessRevision).toBe(readinessRevision);
    release(phase === 'opening composer' ? undefined : false);
    await pending;
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(scope.pendingMessages).toEqual([head]);
    detector.observeProgramStatus({ state: 'clear' });
    detector.observeProgramStatus({ state: 'working' });
    await vi.advanceTimersByTimeAsync(201);
    await settleTriggeredFlushes(scope);
    expect(scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    expect(scope.pendingMessages).toEqual([]);
    expect(scope.isPromptReady).toBe(false);
  });

  it('does not paste or press Enter through the actual TraeX adapter after approval races the capture', async () => {
    vi.useFakeTimers();
    const h = nativeResumeAdmissionHarness();
    const home = mkdtempSync(join(tmpdir(), 'traex-approval-capture-'));
    const { scope, detector } = h;
    const previousHome = process.env.TRAE_HOME;
    process.env.TRAE_HOME = home;
    try {
      mkdirSync(join(home, 'cli'), { recursive: true });
      const input = 'approval-race-follow-up';
      scope.pendingMessages[0].content = input;
      detector.observeProgramStatus({ state: 'working' });
      const writes: Array<{ text: string; block: unknown }> = [];
      const nativeWorking = '◆ Working… (1s • esc to interrupt)';
      scope.cliAdapter.writeInput = createCliAdapterSync('traex').writeInput;
      scope.backend.captureInputState = () => ({ viewport: nativeWorking, cursor: { x: 0, y: 0 } });
      scope.backend.write = (text: string) => { writes.push({ text, block: detector.programStatusBlock() }); return true; };
      scope.backend.sendSpecialKeys = (key: string) => {
        writes.push({ text: key, block: detector.programStatusBlock() });
        if (key === 'Enter') appendFileSync(traeHistoryPath(), JSON.stringify({ session_id: '11111111-2222-4333-8444-555555555555', text: input, ts: Date.now() / 1000 }) + '\n');
        return true;
      };
      let release!: (screen: string) => void;
      scope.backend.captureViewportAsync.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
      const pending = h.flush();
      await waitForAsyncBoundary(() => scope.backend.captureViewportAsync.mock.calls.length > 0, 'native viewport capture');
      const readinessRevision = scope.promptReadinessRevision;
      detector.observeProgramStatus({ state: 'blocked', kind: 'permission' });
      expect(detector.programStatusBlock()).toMatchObject({ kind: 'permission' });
      expect(scope.promptReadinessRevision).toBe(readinessRevision);
      release(nativeWorking);
      await vi.advanceTimersByTimeAsync(1000);
      await pending;
      expect(writes).toEqual([]);
      expect(scope.pendingMessages).toHaveLength(1);
    } finally {
      if (previousHome === undefined) delete process.env.TRAE_HOME;
      else process.env.TRAE_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('retains the question-answer exception when question status arrives during capture', async () => {
    const h = nativeResumeAdmissionHarness();
    h.detector.observeProgramStatus({ state: 'working' });
    let release!: (screen: string) => void;
    h.scope.backend.captureViewportAsync.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const pending = h.flush();
    h.detector.observeProgramStatus({ state: 'blocked', kind: 'question' });
    release('◆ Working… (1s • esc to interrupt)');
    await pending;
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
  });

  it.each([
    ...[true, false].flatMap(bridge => ['permission', 'auth', undefined].map(kind => ({ bridge, kind, duringCapture: false }))),
    ...['permission', 'auth', undefined].map(kind => ({ bridge: true, kind, duringCapture: true })),
  ])(
    'keeps the actual adapter draft without Enter until blocked ($kind) clears (question bridge=$bridge, capture race=$duringCapture)',
    async ({ bridge, kind, duringCapture }) => {
      vi.useFakeTimers();
      const h = nativeResumeAdmissionHarness();
      const { scope, detector } = h;
      const home = mkdtempSync(join(tmpdir(), 'traex-late-block-'));
      const previousHome = process.env.TRAE_HOME;
      process.env.TRAE_HOME = home;
      try {
        mkdirSync(join(home, 'cli'), { recursive: true });
        detector.observeProgramStatus({ state: 'working' });
        const input = 'late-block-follow-up';
        const nativeWorking = '◆ Working… (1s • esc to interrupt)';
        const writes: Array<{ text: string; block: unknown }> = [];
        scope.backend.captureInputState = () => ({ viewport: nativeWorking, cursor: { x: 0, y: 0 } });
        scope.backend.write = (text: string) => { writes.push({ text, block: detector.programStatusBlock() }); return true; };
        scope.backend.sendSpecialKeys = (key: string) => {
          writes.push({ text: key, block: detector.programStatusBlock() });
          if (key === 'Enter') appendFileSync(traeHistoryPath(), JSON.stringify({ session_id: '11111111-2222-4333-8444-555555555555', text: input, ts: Date.now() / 1000 }) + '\n');
          return true;
        };
        const capture = vi.fn(async () => nativeWorking);
        let releaseCapture!: (screen: string) => void;
        if (duringCapture) capture.mockImplementationOnce(() => new Promise(resolve => { releaseCapture = resolve; }));
        Object.assign(scope, {
          cliLifetimeNonce: 1, TRAEX_QUESTION_DRAFT_WAIT_MS: 5000, TRAEX_QUESTION_DRAFT_POLL_MS: 50,
          traexQuestionBridgeActive: () => bridge,
          traexQuestionBlockReported: () => detector.programStatusBlock()?.kind === 'question',
          traexQuestionCapture: capture, traexQuestionFlowVisible,
        });
        const guard = loadWorkerFunction('traexQuestionSubmitGuard', scope)({ turnId: 'next' });
        let settled = false;
        const pending = createCliAdapterSync('traex').writeInput(scope.backend, input, { submitGuard: guard })
          .then(result => { settled = true; return result; });
        await waitForAsyncBoundary(() => writes.length > 0 || settled, 'actual native paste');
        expect(writes).toHaveLength(1);
        expect(writes[0].text).toContain('[200~');
        expect(writes[0].block).toBeNull();
        expect(settled).toBe(false);
        if (duringCapture) {
          await vi.advanceTimersByTimeAsync(200);
          await waitForAsyncBoundary(() => capture.mock.calls.length > 0 || settled, 'pre-Enter viewport capture');
          expect(capture).toHaveBeenCalledOnce();
        }
        detector.observeProgramStatus({ state: 'blocked', ...(kind !== undefined ? { kind } : {}) });
        if (duringCapture) releaseCapture(nativeWorking);
        await vi.advanceTimersByTimeAsync(duringCapture ? 50 : 250);
        await waitForAsyncBoundary(() => scope.traexQuestionDraftWaiting === true
          || writes.some(write => write.text === 'Enter') || settled, 'draft hold or native submission');
        expect(writes.filter(write => write.text === 'Enter')).toEqual([]);
        expect(writes.filter(write => write.text.includes('[200~'))).toHaveLength(1);
        expect(settled).toBe(false);
        expect(scope.traexQuestionDraftWaiting).toBe(true);
        detector.observeProgramStatus({ state: 'clear' });
        await vi.advanceTimersByTimeAsync(500);
        expect(await pending).toMatchObject({ submitted: true });
        expect(writes.filter(write => write.text.includes('[200~'))).toHaveLength(1);
        expect(writes.filter(write => write.text === 'Enter')).toEqual([{ text: 'Enter', block: null }]);
        expect(scope.traexQuestionDraftWaiting).toBe(false);
      } finally {
        if (previousHome === undefined) delete process.env.TRAE_HOME;
        else process.env.TRAE_HOME = previousHome;
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it('submits an ordinary follow-up during native working without inventing prompt readiness', async () => {
    vi.useFakeTimers();
    const h = nativeResumeAdmissionHarness();
    expect(h.detector.lastProgramStatusReport()).toBe('working');
    expect(h.detector.programStatusHeldWorking()).toBe(false);
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    // This new accepted native report, not the old lastRootReport, admits it.
    h.detector.observeProgramStatus({ state: 'working' });
    await vi.advanceTimersByTimeAsync(25);
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    expect(h.scope.pendingMessages).toEqual([]);
    expect(h.scope.isPromptReady).toBe(false);
    expect(h.scope.traexAutoModelController.currentTurnId()).toBe('previous');
  });

  it.each(['done', 'idle', 'clear'] as const)('holds the composer gap after native %s', async state => {
    const h = nativeResumeAdmissionHarness();
    h.detector.observeProgramStatus({ state: 'working' });
    h.detector.observeProgramStatus({ state });
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages).toHaveLength(1);
  });

  it.each(['approval', 'capacity', 'serial', 'durable', 'unknown viewport'] as const)('preserves the %s hold during native working', async gate => {
    const h = nativeResumeAdmissionHarness();
    h.detector.observeProgramStatus({ state: 'working' });
    if (gate === 'approval') h.detector.observeProgramStatus({ state: 'blocked', kind: 'approval' });
    if (gate === 'capacity') h.scope.backend.captureViewportAsync.mockResolvedValue('◆ Queued for capacity (2s • esc to interrupt)');
    if (gate === 'unknown viewport') h.scope.backend.captureViewportAsync.mockResolvedValue('loading');
    if (gate === 'serial') h.scope.pendingMessages[0].queueAfterActiveTurn = true;
    if (gate === 'durable') h.scope.pendingMessages[0].dispatchAttempt = 1;
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages).toHaveLength(1);
    expect(h.scope.isPromptReady).toBe(false);
  });
});

describe('idle auto-model input after a transient admission refusal', () => {
  it('uses the real timeout and retry timer to recover without another idle event', async () => {
    vi.useFakeTimers();
    const h = idleAdmissionHarness();
    h.scope.flushPending = vi.fn(h.flush);
    h.scope.retryTraexAutoModelAdmission = loadWorkerFunction('retryTraexAutoModelAdmission', h.scope);
    h.scope.backend.captureViewportAsync.mockImplementationOnce(() => new Promise(() => {}));
    const first = h.flush();
    await vi.advanceTimersByTimeAsync(1_200);
    await first;
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await settleTriggeredFlushes(h.scope);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    expect(h.scope.pendingMessages).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
  });

  it.each(['viewport race', 'empty capture'] as const)('retries %s on a static composer and submits exactly once', async refusal => {
    const h = idleAdmissionHarness();
    const { scope } = h;
    const item = scope.pendingMessages[0];
    scope.backend.captureViewportAsync.mockImplementationOnce(async () => {
      if (refusal === 'viewport race') scope.backendScreenRevision++;
      return refusal === 'empty capture' ? '' : '❯ Use /skills to list available skills';
    });
    await h.flush();
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(scope.pendingMessages).toEqual([item]);
    expect(scope.retryTraexAutoModelAdmission).toHaveBeenCalledOnce();
    // No new CLI idle event or manual readiness assignment between attempts.
    await h.flush();
    expect(scope.backend.captureViewportAsync).toHaveBeenCalledTimes(2);
    expect(scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    expect(scope.pendingMessages).toEqual([]);
    await h.flush();
    expect(scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    expect(scope.emitTurnTerminal).not.toHaveBeenCalled();
  });

  it.each(['backend replacement', 'generation change', 'restart'] as const)('does not restore stale readiness across %s', async change => {
    const h = idleAdmissionHarness();
    const { scope } = h;
    scope.backend.captureViewportAsync.mockImplementationOnce(async () => {
      if (change === 'backend replacement') scope.backend = {};
      else if (change === 'generation change') scope.cliSpawnGeneration++;
      else scope.cliRestartInProgress = true;
      return '❯ Use /skills to list available skills';
    });
    await h.flush();
    expect(scope.isPromptReady).toBe(false);
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(scope.pendingMessages).toHaveLength(1);
  });

  it('keeps capacity-queued input outside the CLI until a later capture proves the composer', async () => {
    const h = idleAdmissionHarness();
    const { scope } = h;
    scope.backend.captureViewportAsync.mockResolvedValue('◆ Queued for capacity (2s • esc to interrupt)');
    await h.flush();
    await h.flush();
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(scope.pendingMessages).toHaveLength(1);
    scope.backend.captureViewportAsync.mockResolvedValue('❯ Use /skills to list available skills');
    await h.flush();
    expect(scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    expect(scope.pendingMessages).toEqual([]);
  });

  it('does not invent prompt readiness for a busy type-ahead input', async () => {
    const h = idleAdmissionHarness();
    const { scope } = h;
    scope.isPromptReady = false;
    scope.activeTurnAuthority.reserve({ turnId: 'previous' });
    scope.activeTurnAuthority.markStarted({ turnId: 'previous' });
    scope.backend.captureViewportAsync.mockResolvedValue('');
    await h.flush();
    expect(scope.isPromptReady).toBe(false);
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(scope.pendingMessages).toHaveLength(1);
  });

  it.each(['manual', 'previous'])('does not send a queued rename after a real raw command for %s supersedes capture', async rawTurnId => {
    vi.useFakeTimers();
    const h = idleAdmissionHarness();
    const { scope } = h;
    scope.flushPending = h.flush;
    scope.retryTraexAutoModelAdmission = loadWorkerFunction('retryTraexAutoModelAdmission', scope);
    let release!: (screen: string) => void;
    scope.backend.captureViewportAsync.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    Object.assign(scope, {
      openingInputBoxSettled: true, finalizeRawCommandDelivery,
      sendRawCommandLineWithRecoveryFence: vi.fn(async (_backend, _text, beforeWrite) => { beforeWrite?.(); }),
      setCaptureIdentity: (turnId: string) => { scope.currentBotmuxTurnId = turnId; },
      stampMojoTurnMark: vi.fn(), claudeSwitchKindForCommand: () => null,
      claudeBtwQuestion: () => null, traexQuestionBridgeActive: () => false,
      armSessionRenameIdleTimeout: vi.fn(),
    });
    const first = h.flush();
    expect(scope.backend.captureViewportAsync).toHaveBeenCalledOnce();
    await loadWorkerFunction('deliverRawInput', scope)({ type: 'raw_input', content: '/btw question', turnId: rawTurnId });
    expect(scope.isPromptReady).toBe(false);
    scope.pendingSessionRename = 'later-title';
    scope.cliAdapter.buildSessionRenameCommand = (title: string) => `/rename ${title}`;
    release('❯ Use /skills to list available skills');
    await first;
    expect(scope.isPromptReady).toBe(false);
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(scope.sendRawCommandLineWithRecoveryFence).toHaveBeenCalledOnce();
    expect(scope.sendRawCommandLineWithRecoveryFence.mock.calls[0][1]).toBe('/btw question');
    expect(scope.traexAutoModelController.currentTurnId()).toBe('previous');
    expect(scope.currentBotmuxTurnId).toBe(rawTurnId);
    expect(scope.pendingSessionRename).toBe('later-title');
  });

  it('preserves a new approval block after the old capture is refused', async () => {
    const h = idleAdmissionHarness();
    const { scope } = h;
    let release!: (screen: string) => void;
    scope.backend.captureViewportAsync.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const first = h.flush();
    scope.activeTurnAuthority.reserve({ turnId: 'manual' });
    scope.activeTurnAuthority.markStarted({ turnId: 'manual' });
    scope.currentBotmuxTurnId = 'manual';
    scope.cliAdapter.programStatusBlockedHoldsInput = true;
    scope.idleDetector.programStatusBlock = () => ({ kind: 'approval' });
    scope.programStatusBlockHoldsTypeAhead = programStatusBlockHoldsTypeAhead;
    scope.programStatusBlockedHoldsTypeAhead = loadWorkerFunction('programStatusBlockedHoldsTypeAhead', scope);
    scope.pendingInputAllowsTypeAhead = pendingInputAllowsTypeAhead;
    scope.revokePromptReadiness();
    release('❯ Use /skills to list available skills');
    await first;
    await h.flush();
    expect(scope.isPromptReady).toBe(false);
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(scope.pendingMessages).toHaveLength(1);
  });

  it('does not restore readiness after direct Web terminal input during capture', async () => {
    const h = idleAdmissionHarness();
    const { scope } = h;
    scope.terminalInputSubmits = () => false;
    scope.backend.captureViewportAsync.mockImplementationOnce(async () => {
      loadWorkerFunction('noteWebTerminalInput', scope)('x');
      return '❯ Use /skills to list available skills';
    });
    await h.flush();
    expect(scope.isPromptReady).toBe(false);
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(scope.pendingMessages).toHaveLength(1);
  });

  it('invalidates capture when a later key in a paused control sequence is written', async () => {
    vi.useFakeTimers();
    const h = idleAdmissionHarness();
    const { scope } = h;
    Object.assign(scope, {
      cliLifetimeNonce: 1, logError: vi.fn(), KEY_TO_ANSI: {}, sendTuiKeySequence,
    });
    scope.backend.sendSpecialKeys = vi.fn(() => true);
    scope.runAfterAmbiguousSubmissionWrites = loadWorkerFunction('runAfterAmbiguousSubmissionWrites', scope);
    scope.handleTuiKeysDirect = loadWorkerFunction('handleTuiKeysDirect', scope);
    const keys = loadWorkerFunction('handleTuiKeys', scope)(['Down', 'Enter'], true);
    await vi.advanceTimersByTimeAsync(0);
    expect(scope.backend.sendSpecialKeys).toHaveBeenCalledWith('Down');
    let release!: (screen: string) => void;
    scope.backend.captureViewportAsync.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const first = h.flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(scope.backend.sendSpecialKeys).toHaveBeenCalledWith('Enter');
    scope.backendScreenRevision++;
    release('❯ Use /skills to list available skills');
    await first;
    expect(scope.isPromptReady).toBe(false);
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(await keys).toBe(true);
  });

  it('keeps queued input out of a TUI text answer whose text is pasted after a pause', async () => {
    const h = idleAdmissionHarness();
    const { scope } = h;
    let reachedPause!: () => void;
    const paused = new Promise<void>(resolve => { reachedPause = resolve; });
    let resume!: () => void;
    const resumed = new Promise<void>(resolve => { resume = resolve; });
    Object.assign(scope, {
      cliLifetimeNonce: 1, logError: vi.fn(), KEY_TO_ANSI: { Down: '\x1b[B' },
      sendTuiKeySequence, strictInputHandle: (backend: unknown) => backend,
      // 导航键之后、正文之前的停顿由测试放行：取屏在这段停顿里开始。
      submitTuiTextInput: (options: Parameters<typeof submitTuiTextInput>[0]) =>
        submitTuiTextInput({ ...options, pause: () => { reachedPause(); return resumed; } }),
    });
    scope.backend.write = vi.fn(() => true);
    let release!: (screen: string) => void;
    let flushed!: Promise<void>;
    const typed: string[] = [];
    scope.cliAdapter.writeInput = vi.fn(async (target: { write: (data: string) => unknown }, content: string) => {
      target.write(content);
      typed.push(content);
      if (content === 'answer') {
        // 正文已写进终端、文本事务还没收尾：在途的旧截图此刻才返回。
        release('❯ Use /skills to list available skills');
        await flushed;
      }
      return { submitted: true };
    });
    const answer = loadWorkerFunction('handleTuiTextInput', scope)(['Down'], 'answer');
    await paused;
    expect(scope.backend.write).toHaveBeenCalledWith('\x1b[B');
    let captureStarted!: () => void;
    const capturing = new Promise<void>(resolve => { captureStarted = resolve; });
    scope.backend.captureViewportAsync.mockImplementationOnce(() => {
      captureStarted();
      return new Promise<string>(resolve => { release = resolve; });
    });
    flushed = h.flush();
    await capturing;
    resume();
    expect(await answer).toBe(true);
    expect(typed).toEqual(['answer']);
    expect(scope.pendingMessages).toHaveLength(1);
  });

  it.each(['final keys', 'quick Enter', 'native question', 'text answer', 'prompt submitted', 'busy event'] as const)(
    'does not send rename after %s invalidates an in-flight capture', async control => {
      vi.useFakeTimers();
      const h = idleAdmissionHarness();
      const { scope } = h;
      scope.flushPending = h.flush;
      scope.retryTraexAutoModelAdmission = loadWorkerFunction('retryTraexAutoModelAdmission', scope);
      Object.assign(scope, {
        cliLifetimeNonce: 1, logError: vi.fn(), KEY_TO_ANSI: { Enter: '\r' },
        sendTuiKeySequence, strictInputHandle: (backend: unknown) => backend,
        // bun:test 的 advanceTimersByTimeAsync 先推进时钟、之后才让出微任务；
        // defaultPause 要经过几次 await 才注册 setTimeout，推进时它还不存在，
        // 假时钟下又不会按墙钟触发，用例挂到超时（同文件内同样写法也挂，与是否
        // 跨模块无关）。注入无定时器的 pause，与 tui-input-delivery.test.ts 的
        // 做法一致；真实写入、追踪代理与失效计数路径全部保留。
        submitTuiTextInput: (options: Parameters<typeof submitTuiTextInput>[0]) =>
          submitTuiTextInput({ ...options, pause: async () => {} }),
        bindSessionObservation: (callback: unknown) => callback,
        noteClaudeBridgeTurnStarted: vi.fn(), publishScreenStatus: vi.fn(),
        writtenInputs: { takeSubmitted: () => undefined }, armSessionRenameIdleTimeout: vi.fn(),
        sendRawCommandLineWithRecoveryFence: vi.fn(async () => {}),
        isCriticalInterruptKey: () => false, PTY_SEQ_MAP: { enter: '\r' },
        TMUX_KEY_MAP: { enter: 'Enter' }, scheduleOneShotAfterAction: vi.fn(),
      });
      scope.runAfterAmbiguousSubmissionWrites = loadWorkerFunction('runAfterAmbiguousSubmissionWrites', scope);
      scope.handleTuiKeysDirect = loadWorkerFunction('handleTuiKeysDirect', scope);
      scope.sendTermActionOnce = loadWorkerFunction('sendTermActionOnce', scope);
      scope.backend.write = vi.fn(() => true);
      let release!: (screen: string) => void;
      scope.backend.captureViewportAsync.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
      const first = h.flush();
      if (control === 'final keys') {
        const keys = loadWorkerFunction('handleTuiKeys', scope)(['Enter'], true);
        await vi.advanceTimersByTimeAsync(100);
        expect(await keys).toBe(true);
        expect(scope.backend.write).toHaveBeenCalledWith('\r');
      } else if (control === 'quick Enter') {
        await loadWorkerFunction('handleTermAction', scope)('enter');
        expect(scope.backend.write).toHaveBeenCalledWith('\r');
      } else if (control === 'native question') {
        expect(await loadWorkerFunction('traexQuestionWrite', scope)(
          (input: { write: (data: string) => boolean }) => input.write('\r'),
        )).toBe(true);
        expect(scope.backend.write).toHaveBeenCalledWith('\r');
      } else if (control === 'text answer') {
        const text = loadWorkerFunction('handleTuiTextInput', scope)([], 'answer');
        await vi.advanceTimersByTimeAsync(200);
        expect(await text).toBe(true);
        expect(scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
      } else if (control === 'prompt submitted') {
        await loadWorkerMessageHandler('prompt_submitted', scope)({ type: 'prompt_submitted' });
      } else {
        let busy!: () => void;
        loadWorkerFunction('wireIdleDetectorBusyTransition', scope)(
          { onBusy: (callback: () => void) => { busy = callback; } }, 'test',
        );
        busy();
      }
      const writesAfterControl = scope.cliAdapter.writeInput.mock.calls.length;
      scope.pendingSessionRename = 'after-answer';
      scope.cliAdapter.buildSessionRenameCommand = (title: string) => `/rename ${title}`;
      scope.backendScreenRevision++;
      release('❯ Use /skills to list available skills');
      await first;
      expect(scope.isPromptReady).toBe(false);
      expect(scope.cliAdapter.writeInput).toHaveBeenCalledTimes(writesAfterControl);
      await vi.advanceTimersByTimeAsync(200);
      expect(scope.sendRawCommandLineWithRecoveryFence).not.toHaveBeenCalled();
      expect(scope.pendingSessionRename).toBe('after-answer');
    },
  );
});
