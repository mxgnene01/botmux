import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STRUCTURED_UNCONFIRMED_ATTRIBUTION_GRACE_MS } from '../src/services/codex-bridge-queue.js';
import { drainCodexRollout, type CodexDrainResult } from '../src/services/codex-transcript.js';
import { selectSubmitActivityEvidence } from '../src/services/submit-confirmation.js';
import { diagnoseBackendSubmitFailure, shouldWaitThroughBusyTurn } from '../src/services/submit-failure-diagnosis.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';

const nativeSessionId = '11111111-2222-4333-8444-555555555555';
// Same body without the routing envelope is not evidence for this IM input.
const body = '请检查这个会话的提交是否完成';
const input = `[botmux session: test-session]\n[botmux message: om_delivery]\n${body}`;
const dirs: string[] = [];
const chains: ReturnType<typeof workerSubmitHarness>['submitFailureChains'][] = [];

afterEach(() => {
  for (const chain of chains.splice(0)) chain.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Real rollout reader, queue, receipt observer, evidence selector and deferred
 * callback. Only history I/O, screen capture and quarantine exit are controlled. */
function attributionHarness(cliId: 'traex' | 'codex', backendType: 'pty' | 'tmux', attempt?: number) {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const h = workerSubmitHarness();
  chains.push(h.submitFailureChains);
  const quarantine = { turnId: 'delivery', draftContent: input, submitWarningSent: false };
  const identity = { turnId: 'delivery', dispatchAttempt: attempt };
  const key = { ...identity, cliGeneration: 7 };
  Object.assign(h.scope, {
    lastInitConfig: { cliId },
    effectiveBackendType: backendType,
    cliAdapter: { reliableTurnTerminal: true, quarantineUnconfirmedSubmits: true },
    currentInputDeliveryQuarantine: () => quarantine,
    inputDeliveryObservedCliSessionId: nativeSessionId,
    lastPtyActivityAtMs: 0,
    lastStructuredBridgeActivityAtMs: 0,
    inflightInputs: { ...h.scope.inflightInputs, onTurnStarted: vi.fn() },
    startupNativeInputSeen: false,
    selectSubmitActivityEvidence,
    captureBackendScreen: () => '',
    diagnoseBackendSubmitFailure,
    shouldWaitThroughBusyTurn,
    dropFailedBridgeMark: vi.fn(),
    submitUnconfirmedNotice: (notice: Record<string, unknown>) => ({ type: 'user_notify', ...notice }),
    SUBMIT_DIAG_ACTIVE_SILENCE_MAX_EXTRA: 3,
    SUBMIT_DIAG_BUSY_SILENCE_MAX_EXTRA: 12,
  });
  h.scope.submitActivityEvidenceSince = loadWorkerFunction('submitActivityEvidenceSince', h.scope);
  h.scope.observeAuthoritativeStructuredTurnStart = loadWorkerFunction('observeAuthoritativeStructuredTurnStart', h.scope);
  h.queue.setTurnStartObserver((turn, evidence) => h.scope.observeAuthoritativeStructuredTurnStart(turn, evidence));
  h.queue.mark(identity.turnId, input, 0, attempt);
  h.inputDeliveryEvidence.start(key, 0);
  const onConfirmed = vi.fn(() => h.scope.releaseInputDeliveryQuarantine(quarantine, 'confirmed'));
  const schedule = () => h.schedule(input, h.recheck, 'rollout', identity.turnId, undefined, 1,
    identity, 'failed', true, onConfirmed);
  const evidence = (target = identity) => h.scope.submitActivityEvidenceSince(0, target);
  const dir = mkdtempSync(join(tmpdir(), 'submit-attribution-'));
  dirs.push(dir);
  const path = join(dir, 'rollout.jsonl');
  let drain: CodexDrainResult | undefined;
  const append = (type: string, payload: Record<string, unknown>) => {
    appendFileSync(path, JSON.stringify({ timestamp: new Date(Date.now()).toISOString(), type, payload }) + '\n');
    drain = drainCodexRollout(path, drain?.newOffset ?? 0, drain?.state);
    h.queue.ingest(drain.events);
  };
  append('session_meta', { id: nativeSessionId });
  const start = (turnId = 'native-unverified') => append('event_msg', { type: 'task_started', turn_id: turnId });
  const user = (text: string) => append('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  const terminal = (text: string, turnId = 'native-unverified') => append('event_msg',
    { type: 'task_complete', turn_id: turnId, last_agent_message: text });
  return { ...h, identity, key, quarantine, onConfirmed, schedule, evidence, start, user, terminal };
}

describe('structured submit attribution across provisional native starts', () => {
  it.each(['traex', 'codex'] as const)('keeps %s quarantine after a same-session start without its envelope', async cliId => {
    const h = attributionHarness(cliId, 'tmux');
    h.schedule();
    vi.setSystemTime(57_000);
    h.start();
    h.user(body);
    h.scope.lastStructuredBridgeActivityAtMs = Date.now();
    expect(h.queue.peek()[0]).toMatchObject({ started: true, provisionalTaskStartedAtMs: 57_000 });
    expect(h.queue.peek()[0].transcriptStartTimeMs).toBeUndefined();
    expect(h.inputDeliveryEvidence.authoritativeReceipt(h.key)).toBeUndefined();
    await vi.advanceTimersToNextTimerAsync();
    expect(h.submitFailureChains.size()).toBe(1);
    expect(h.onConfirmed).not.toHaveBeenCalled();
    expect(h.scope.releaseInputDeliveryQuarantine).not.toHaveBeenCalled();
    expect(h.evidence()).toBe('pty-output');
    expect(h.settlements[0]).toMatchObject({ action: { kind: 'suppress-active', evidence: 'pty-output' } });
    await vi.advanceTimersToNextTimerAsync();
    expect(h.settlements[1]).toMatchObject({ action: { kind: 'suppress-active', evidence: 'pty-output' } });
    expect(h.quarantine.submitWarningSent).toBe(true);
    expect(h.scope.send.mock.calls.filter(([message]: [{ type: string }]) => message.type === 'user_notify')).toHaveLength(1);
    expect(h.scope.releaseInputDeliveryQuarantine).not.toHaveBeenCalled();

    vi.setSystemTime(238_000);
    h.terminal('这是没有被核实的其他输入回复');
    expect(h.queue.drainEmittable()).toEqual([]);
    expect(h.queue.peek()[0]).toMatchObject({ started: false, taskStartedRollbackAtMs: 238_000 });
    expect(h.inputDeliveryEvidence.authoritativeReceipt(h.key)).toBeUndefined();
    h.scope.lastStructuredBridgeActivityAtMs = 0;
    expect(h.evidence()).toBeUndefined();
    expect(h.queue.pruneExpiredPreStartHeads(238_000 + STRUCTURED_UNCONFIRMED_ATTRIBUTION_GRACE_MS + 1)
      .map(turn => turn.turnId)).toEqual(['delivery']);
  });

  it.each(['pty', 'tmux'] as const)('confirms only the corroborated input and drains its own reply on %s', async backendType => {
    const h = attributionHarness('traex', backendType);
    h.schedule();
    vi.setSystemTime(1_000);
    h.start();
    expect(h.evidence()).toBeUndefined();
    h.user(input);
    expect(h.inputDeliveryEvidence.authoritativeReceipt(h.key)).toMatchObject({ evidence: 'structured-transcript', cliSessionId: nativeSessionId });
    expect(h.evidence()).toBe('structured-transcript');
    await vi.advanceTimersToNextTimerAsync();
    expect(h.submitFailureChains.size()).toBe(0);
    expect(h.onConfirmed).toHaveBeenCalledOnce();
    expect(h.scope.releaseInputDeliveryQuarantine).toHaveBeenCalledOnce();
    expect(h.scope.send).not.toHaveBeenCalled();
    h.terminal('仅属于已核实输入的回复');
    expect(h.queue.drainEmittable()).toEqual([expect.objectContaining({ turnId: 'delivery', finalText: '仅属于已核实输入的回复', sourceSessionId: nativeSessionId })]);
    // Completion consumes the live mark, not the exact delivery receipt.
    expect(h.evidence()).toBe('structured-transcript');
  });

  it('does not promote another attempt or another native session to the target receipt', () => {
    const h = attributionHarness('codex', 'pty', 2);
    vi.setSystemTime(1_000);
    h.start();
    h.scope.inputDeliveryObservedCliSessionId = 'foreign-session';
    h.user(input);
    expect(h.inputDeliveryEvidence.authoritativeReceipt(h.key)).toBeUndefined();
    expect(h.evidence()).toBeUndefined();
    h.scope.inputDeliveryObservedCliSessionId = nativeSessionId;
    expect(h.evidence()).toBe('structured-transcript');
    expect(h.evidence({ turnId: 'delivery', dispatchAttempt: 1 })).toBeUndefined();
    expect(h.evidence({ turnId: 'another-delivery', dispatchAttempt: 2 })).toBeUndefined();
  });
});
