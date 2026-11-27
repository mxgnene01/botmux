import * as terminalService from '../src/services/traex-terminal-session.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PtyHandle } from '../src/adapters/cli/types.js';
import { TRAEX_EMPTY_COMPOSER_HINTS, TRAEX_SPINNER_LABELS } from '../src/adapters/cli/traex-footer.js';
import { findTraexRolloutSetByPid } from '../src/services/traex-transcript.js';
import {
  refreshTraexTerminalSession, traexTerminalSessionIsBound, traexTerminalIdentityNeedsRefresh,
  traexEmptyComposer, traexStatusSessionId, bindTraexSessionFromCorrelatedInput,
  traexTerminalInputBlocked, traexTerminalIdentityGeneration,
} from '../src/services/traex-terminal-session.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { extractLastCodexTurn } from '../src/services/codex-transcript.js';

vi.mock('../src/services/traex-transcript.js', () => ({ findTraexRolloutSetByPid: vi.fn() }));
const sid = '01a0ec3d-3751-7882-9b25-49bc90078561';
const other = '01a0ec3d-3751-7882-9b25-49bc90078562';
const idle = (body = 'latest answer', input = 'Implement {feature}') => ({
  viewport: `${body}\n❯ ${input}\n▀▀▀▀▀\n  GPT-6 · ~/work · Context 79% left\n  ? for shortcuts`,
  cursor: { x: 2, y: 1 },
});
const panel = (id = sid) => ({
  viewport: `────────────────\n >_ TRAE CLI (v0.216.0)\n\n Execution host: Local background server\n Directory: ~/work\n Session: ${id}\n Limits: data not available yet`,
  cursor: { x: 45, y: 6 },
});

function terminal() {
  let state = idle();
  let currentSid = sid;
  const sendText = vi.fn((text: string) => { state = { ...idle('latest answer', text), cursor: { x: text.length + 2, y: 1 } }; });
  const sendSpecialKeys = vi.fn((key: string) => {
    state = key === 'Enter' ? panel(currentSid) : idle();
  });
  const pty: PtyHandle = { cliPid: 43212, write: vi.fn(), sendText, sendSpecialKeys, captureInputState: () => state };
  return { pty, sendText, sendSpecialKeys,
    changeState: (value: typeof state) => { state = value; },
    changeSession: (value: string) => { currentSid = value; },
  };
}

afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

async function resolve<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

describe('TRAE shared-daemon terminal identity', () => {
  it('waits read-only when its unpainted query leaves the same empty composer with a repainted footer', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendText.mockImplementation(() => {
      t.changeState({ ...idle(), viewport: idle().viewport.replace('\n  ? for shortcuts', '') });
      setTimeout(() => t.changeState({ ...idle('latest answer', '/status'), cursor: { x: 9, y: 1 } }), 100);
    });
    const p = refreshTraexTerminalSession(t.pty);
    expect(traexTerminalInputBlocked(t.pty)).toBe(true);
    expect(await resolve(p)).toMatchObject({ kind: 'terminal', sessionId: sid });
    expect(t.sendText).toHaveBeenCalledExactlyOnceWith('/status');
    expect(t.sendSpecialKeys.mock.calls).toEqual([['Enter'], ['Escape']]);
  });

  it.each(['draft', 'caret', 'hint'])('stops permanently on changed empty-composer ownership before its text paints (%s)', async change => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendText.mockImplementation(() => {
      t.changeState({ ...idle(), viewport: idle().viewport.replace('\n  ? for shortcuts', '') });
      setTimeout(() => t.changeState(change === 'draft'
        ? { ...idle('latest answer', 'human input'), cursor: { x: 13, y: 1 } }
        : change === 'caret' ? { ...idle(), cursor: { x: 0, y: 1 } }
        : idle('latest answer', 'Explain this codebase')), 50);
      setTimeout(() => t.changeState({ ...idle('latest answer', '/status'), cursor: { x: 9, y: 1 } }), 100);
    });
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable' });
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
    expect(await refreshTraexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
  });

  it.each(['/','/s','/st','/sta','/stat','/statu'])('waits for its first monotonic native text paint (%s)', async prefix => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendText.mockImplementation(() => {
      t.changeState({ ...idle('latest answer', prefix), cursor: { x: prefix.length + 2, y: 1 } });
      setTimeout(() => t.changeState({ ...idle('latest answer', '/status'), cursor: { x: 9, y: 1 } }), 100);
    });
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toMatchObject({ kind: 'terminal', sessionId: sid });
    expect(t.sendText).toHaveBeenCalledExactlyOnceWith('/status');
    expect(t.sendSpecialKeys.mock.calls).toEqual([['Enter'], ['Escape']]);
  });

  it.each(['shortened-prefix', 'moved-prefix-cursor', 'changed-prefix', 'extra-line', 'busy'])('ends first paint permanently after intervening input (%s)', async change => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendText.mockImplementation(() => {
      t.changeState({ ...idle('latest answer', '/sta'), cursor: { x: 6, y: 1 } });
      setTimeout(() => {
        if (change === 'shortened-prefix') t.changeState({ ...idle('latest answer', '/st'), cursor: { x: 5, y: 1 } });
        if (change === 'moved-prefix-cursor') t.changeState({ ...idle('latest answer', '/sta'), cursor: { x: 2, y: 1 } });
        if (change === 'changed-prefix') t.changeState({ ...idle('latest answer', '/start'), cursor: { x: 8, y: 1 } });
        if (change === 'extra-line') t.changeState({ viewport: 'latest answer\n❯ /sta\n  human draft\n▀▀▀▀▀\n  GPT-6 · Context 79% left', cursor: { x: 6, y: 1 } });
        if (change === 'busy') t.changeState({ ...idle('❖ Working… (1s • esc to interrupt)\n▀▀▀▀▀', '/sta'), cursor: { x: 6, y: 2 } });
      }, 50);
      setTimeout(() => t.changeState({ ...idle('latest answer', '/status'), cursor: { x: 9, y: 1 } }), 100);
    });
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable' });
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
    expect(t.sendText).toHaveBeenCalledTimes(1);
    expect(await refreshTraexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
  });

  it('does not resume partial paint after the full query was already observed', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendText.mockImplementation(() => {
      t.changeState({ ...idle('latest answer', '/status'), cursor: { x: 9, y: 1 } });
      setTimeout(() => t.changeState({ ...idle('latest answer', '/sta'), cursor: { x: 6, y: 1 } }), 50);
      setTimeout(() => t.changeState({ ...idle('latest answer', '/status'), cursor: { x: 9, y: 1 } }), 100);
    });
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable' });
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('does not take a prompt-looking continuation as the first query paint', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendText.mockImplementation(() => {
      t.changeState({ ...idle('latest answer', '/sta'), cursor: { x: 6, y: 1 } });
      setTimeout(() => t.changeState({ viewport: 'latest answer\n❯ /sta\n  ❯ /sta\n▀▀▀▀▀\n  GPT-6 · Context 79% left', cursor: { x: 8, y: 2 } }), 50);
      setTimeout(() => t.changeState({ viewport: 'latest answer\n❯ /status\n  ❯ /status\n▀▀▀▀▀\n  GPT-6 · Context 79% left', cursor: { x: 11, y: 2 } }), 100);
    });
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable' });
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('bounds an incomplete first text paint without replaying the text', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendText.mockImplementation(() => t.changeState({ ...idle('latest answer', '/sta'), cursor: { x: 6, y: 1 } }));
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable' });
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
    expect(await refreshTraexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
    expect(t.sendText).toHaveBeenCalledTimes(1);
  });

  it.each([2, 9])('refuses an existing status draft without a delayed write (caret %s)', async x => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.changeState({ ...idle('old answer', '/status'), cursor: { x, y: 1 } });
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable' });
    expect(terminalService.traexTerminalBootstrapFailed(t.pty)).toBe(true);
    expect(traexTerminalIdentityNeedsRefresh(t.pty)).toBe(false);
    expect(traexTerminalInputBlocked(t.pty)).toBe(true);
    t.changeState(idle());
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable' });
    expect(t.sendText).not.toHaveBeenCalled();
    expect(traexTerminalInputBlocked(t.pty)).toBe(false);
    t.pty.cliPid!++;
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toMatchObject({ kind: 'terminal', sessionId: sid });
    expect(t.sendText).toHaveBeenCalledTimes(1);
  });

  it('does not release an abandoned query on a placeholder-looking draft continuation', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.changeState({ ...idle('old answer', '/status'), cursor: { x: 9, y: 1 } });
    await resolve(refreshTraexTerminalSession(t.pty));
    t.changeState({ viewport: 'old answer\n❯ /status\n  ❯ Implement {feature}\n▀▀▀▀▀\n  GPT-6 · Context 79% left', cursor: { x: 4, y: 2 } });
    expect(traexEmptyComposer(t.pty.captureInputState!())).toBe(false);
    expect(traexTerminalInputBlocked(t.pty)).toBe(true);
    expect(t.sendText).not.toHaveBeenCalled();
  });

  it('queries native status and binds only this frontend/backend generation', async () => {
    vi.useFakeTimers();
    vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    const request = refreshTraexTerminalSession(t.pty);
    expect(refreshTraexTerminalSession(t.pty)).toBe(request);
    expect(await resolve(request)).toEqual({ kind: 'terminal', sessionId: sid, inputReleased: true });
    expect(t.sendText).toHaveBeenCalledExactlyOnceWith('/status');
    expect(t.sendSpecialKeys.mock.calls).toEqual([['Enter'], ['Escape']]);
    expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(true);
    expect(traexTerminalSessionIsBound(t.pty, other)).toBe(false);
    expect(traexTerminalIdentityNeedsRefresh(t.pty)).toBe(false);
    expect(traexTerminalSessionIsBound({ ...t.pty }, sid)).toBe(false);
    t.pty.cliPid!++;
    expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(false);
  });

  // Fixture shape from the reported TRAE 0.216 command-picker screenshot.
  // The menu hides/replaces the normal footer; it is not a human draft.
  it.each([{ footer: false, divider: false, padding: 0 }, { footer: true, divider: false, padding: 0 }, { footer: false, divider: true, padding: 0 }, { footer: false, divider: true, padding: 146 }])('submits its own native picker command ($footer/$divider/$padding)', async ({ footer, divider, padding }) => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendText.mockImplementation(() => t.changeState({
      viewport: '\n'.repeat(padding) + 'latest answer\n❯ /status\n' + (divider ? '▀▀▀▀▀\n' : '\n') + '❯ /status        show current session configuration and token usage\n  /statusline    configure which items appear in the status line'
        + (footer ? '\n▀▀▀▀▀\n  GPT-6.1-Sol high · Context 52% left\n  ? for shortcuts' : ''),
      cursor: { x: 9, y: padding + 1 },
    }));
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'terminal', sessionId: sid, inputReleased: true });
    expect(t.sendText).toHaveBeenCalledExactlyOnceWith('/status');
    expect(t.sendSpecialKeys.mock.calls).toEqual([['Enter'], ['Escape']]);
    expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(true);
    expect(traexTerminalInputBlocked(t.pty)).toBe(false);
    expect(traexTerminalIdentityNeedsRefresh(t.pty)).toBe(false);
  });

  it('keeps one logical query when the picker accepts completion before executing it', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal(); let accepted = false;
    t.sendText.mockImplementation(() => t.changeState({
      viewport: 'latest answer\n❯ /status\n\n❯ /status        show current session configuration and token usage\n  /statusline    configure which items appear in the status line',
      cursor: { x: 9, y: 1 },
    }));
    t.sendSpecialKeys.mockImplementation(key => {
      if (key === 'Escape') t.changeState(idle());
      else if (!accepted) { accepted = true; t.changeState({ ...idle('latest answer', '/status'), cursor: { x: 9, y: 1 } }); }
      else t.changeState(panel());
    });
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toMatchObject({ kind: 'terminal', sessionId: sid });
    expect(t.sendText).toHaveBeenCalledTimes(1);
    expect(t.sendSpecialKeys.mock.calls).toEqual([['Enter'], ['Enter'], ['Escape']]);
  });

  it('permits a bounded Enter retry only while its soft-newline composer is unchanged', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal(); let entered = false;
    t.sendSpecialKeys.mockImplementation(key => {
      if (key === 'Escape') t.changeState(idle());
      else if (!entered) {
        entered = true;
        t.changeState({ viewport: 'latest answer\n❯ /status\n\n▀▀▀▀▀\n  GPT-6.1-Sol high · Context 52% left\n  ? for shortcuts', cursor: { x: 2, y: 2 } });
      } else t.changeState(panel());
    });
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toMatchObject({ kind: 'terminal', sessionId: sid });
    expect(t.sendText).toHaveBeenCalledTimes(1);
    expect(t.sendSpecialKeys.mock.calls).toEqual([['Enter'], ['Enter'], ['Escape']]);
  });

  it('does not submit again after completion closes and the human moves the query cursor', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendText.mockImplementation(() => t.changeState({
      viewport: 'latest answer\n❯ /status\n\n❯ /status        show current session configuration and token usage\n  /statusline    configure which items appear in the status line',
      cursor: { x: 9, y: 1 },
    }));
    let accepted = false;
    t.sendSpecialKeys.mockImplementation(key => {
      if (key === 'Enter' && !accepted) { accepted = true; t.changeState({ ...idle('latest answer', '/status'), cursor: { x: 2, y: 1 } }); }
      else if (key === 'Enter') t.changeState(panel());
      else t.changeState(idle());
    });
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable' });
    expect(t.sendSpecialKeys.mock.calls).toEqual([['Enter']]);
    expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(false);
    expect(t.sendText).toHaveBeenCalledTimes(1);
  });

  it.each(['different-selection', 'draft', 'multiline-draft', 'moved-cursor', 'unknown-option', 'historical-menu'])(
    'does not submit after the picker surface loses exact query ownership (%s)', async change => {
      vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
      const t = terminal();
      t.sendText.mockImplementation(() => {
        const lines = ['latest answer', '❯ /status', '', '❯ /status        show current session configuration and token usage', '  /statusline    configure which items appear in the status line'];
        const cursor = { x: 9, y: 1 };
        if (change === 'different-selection') { lines[3] = '  /status        show current session configuration and token usage'; lines[4] = '❯ /statusline    configure which items appear in the status line'; }
        if (change === 'draft') { lines[1] += ' and my task'; cursor.x = lines[1]!.length; }
        if (change === 'multiline-draft') lines.splice(2, 0, '  my task');
        if (change === 'moved-cursor') cursor.x = 2;
        if (change === 'unknown-option') lines.push('  /model    choose a model');
        if (change === 'historical-menu') { lines.splice(0, lines.length, ...lines.slice(3), '❯ /status'); cursor.y = 2; }
        t.changeState({ viewport: lines.join('\n'), cursor });
      });
      expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable' });
      expect(t.sendSpecialKeys).not.toHaveBeenCalled();
      expect(t.sendText).toHaveBeenCalledTimes(1);
      expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(false);
    },
  );

  it('emits only the last completed pre-adopt pair once after a picker-based identity bootstrap', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendText.mockImplementation(() => t.changeState({
      viewport: 'latest answer\n❯ /status\n\n❯ /status        show current session configuration and token usage\n  /statusline    configure which items appear in the status line',
      cursor: { x: 9, y: 1 },
    }));
    const result = await resolve(refreshTraexTerminalSession(t.pty));
    expect(result).toMatchObject({ kind: 'terminal', sessionId: sid });
    const send = vi.fn();
    const scope = { lastInitConfig: { cliId: 'traex', adoptMode: true }, codexBridgePreambleSent: false,
      extractLastCodexTurn, currentBotmuxTurnId: 'adopt-turn',
      truncatePreambleText: (text: string, max: number) => text.slice(0, max), PREAMBLE_USER_MAX: 1000, PREAMBLE_ASSISTANT_MAX: 6000,
      send, log: vi.fn(),
    };
    const preamble = loadWorkerFunction('maybeEmitCodexAdoptPreamble', scope);
    const history = [
      { kind: 'user', text: 'old input', uuid: 'u1', timestampMs: 1 },
      { kind: 'assistant_final', text: 'old answer', uuid: 'a1', timestampMs: 2 },
      { kind: 'user', text: 'last input', uuid: 'u2', timestampMs: 3 },
      { kind: 'assistant_final', text: 'last answer', uuid: 'a2', timestampMs: 4 },
    ];
    preamble(history); preamble(history);
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'adopt_preamble', turnId: 'adopt-turn', userText: 'last input', assistantText: 'last answer' });
    expect(t.sendSpecialKeys.mock.calls).toEqual([['Enter'], ['Escape']]);
    expect(traexTerminalInputBlocked(t.pty)).toBe(false);
  });

  it('retains the embedded-process ownership path without querying or editing the terminal', async () => {
    vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set([sid]));
    const t = terminal();
    expect(await refreshTraexTerminalSession(t.pty)).toEqual({ kind: 'legacy' });
    expect(t.sendText).not.toHaveBeenCalled();
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it.each([undefined, null])('does not probe when ownership/snapshot enumeration is unavailable (%s)', async value => {
    vi.mocked(findTraexRolloutSetByPid).mockReturnValue(value === null ? new Set() : undefined);
    const t = terminal();
    if (value === null) t.pty.captureInputState = undefined;
    expect(await refreshTraexTerminalSession(t.pty)).toEqual({ kind: 'legacy' });
    expect(t.sendText).not.toHaveBeenCalled();
  });

  it.each(['my unsent draft', 'Implement {feature} extra', 'Ask TraeCode CLI my unsent draft'])('preserves a human draft: %s', async draft => {
    vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal(); t.changeState(idle('latest answer', draft));
    expect(await refreshTraexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
    expect(t.sendText).not.toHaveBeenCalled();
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('keeps an active task untouched until its empty composer returns', async () => {
    vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal(); t.changeState({ viewport: 'Working (2s · esc to interrupt)', cursor: { x: 0, y: 0 } });
    expect(await refreshTraexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
    expect(t.sendText).not.toHaveBeenCalled();
    expect(traexTerminalIdentityNeedsRefresh(t.pty)).toBe(true);
  });

  it('keeps the bound identity across local redraws and bootstraps again only on re-adopt', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    await resolve(refreshTraexTerminalSession(t.pty));
    for (let tick = 0; tick < 24; tick++) {
      t.changeState(idle(`ordinary output ${tick}`));
      await vi.advanceTimersByTimeAsync(5000);
      expect(traexTerminalIdentityNeedsRefresh(t.pty)).toBe(false);
      expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'terminal', sessionId: sid });
    }
    expect(t.sendText).toHaveBeenCalledTimes(1);
    // Local /new or /resume is deliberately outside this trial's automatic
    // follow contract. A fresh adopted backend resolves the new identity.
    const readopted = terminal(); readopted.changeSession(other);
    expect(await resolve(refreshTraexTerminalSession(readopted.pty))).toMatchObject({ kind: 'terminal', sessionId: other });
    expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(true);
    expect(traexTerminalSessionIsBound(readopted.pty, other)).toBe(true);
  });

  it('uses an exact input receipt without an intrusive status bootstrap', async () => {
    vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    expect(bindTraexSessionFromCorrelatedInput(t.pty, 43212, sid, traexTerminalIdentityGeneration(t.pty))).toBe(true);
    expect(traexTerminalIdentityNeedsRefresh(t.pty)).toBe(false);
    expect(await refreshTraexTerminalSession(t.pty)).toEqual({ kind: 'terminal', sessionId: sid });
    const epoch = traexTerminalIdentityGeneration(t.pty);
    expect(bindTraexSessionFromCorrelatedInput(t.pty, 43212, other, epoch)).toBe(true);
    expect(bindTraexSessionFromCorrelatedInput(t.pty, 43212, sid, epoch)).toBe(false);
    expect(await refreshTraexTerminalSession(t.pty)).toEqual({ kind: 'terminal', sessionId: other });
    expect(t.sendText).not.toHaveBeenCalled();
  });

  it('preserves the bootstrap opportunity while busy or holding an unsent draft', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    for (const state of [{ viewport: 'Working (2s · esc to interrupt)', cursor: { x: 0, y: 0 } }, idle('answer', 'human draft')]) {
      t.changeState(state);
      expect(await refreshTraexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
      expect(traexTerminalIdentityNeedsRefresh(t.pty)).toBe(true);
      expect(t.sendText).not.toHaveBeenCalled();
    }
    t.changeState(idle());
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toMatchObject({ kind: 'terminal', sessionId: sid });
    expect(t.sendText).toHaveBeenCalledTimes(1);
  });

  it.each(['false', 'throw'])('never retries an uncertain initial text delivery (%s)', async outcome => {
    vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendText.mockImplementation(() => { if (outcome === 'throw') throw new Error('unknown write delivery'); return false as never; });
    expect(await refreshTraexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
    for (let tick = 0; tick < 3; tick++) {
      t.changeState(idle(`redraw ${tick}`));
      expect(traexTerminalIdentityNeedsRefresh(t.pty)).toBe(false);
      expect(await refreshTraexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
    }
    expect(t.sendText).toHaveBeenCalledTimes(1);
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('does not reinject a cancelled query after the human clears its composer', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendSpecialKeys.mockImplementation(() => false as never);
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable' });
    expect(traexTerminalInputBlocked(t.pty)).toBe(true);
    t.changeState(idle('human cleared query'));
    expect(traexTerminalInputBlocked(t.pty)).toBe(false);
    expect(traexTerminalIdentityNeedsRefresh(t.pty)).toBe(false);
    expect(await refreshTraexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
    expect(t.sendText).toHaveBeenCalledTimes(1);
  });

  it('allows one new bootstrap when the frontend PID changes on the same backend', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    await resolve(refreshTraexTerminalSession(t.pty));
    t.pty.cliPid = 43213; t.changeState(idle('new frontend')); t.changeSession(other);
    expect(traexTerminalIdentityNeedsRefresh(t.pty)).toBe(true);
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toMatchObject({ kind: 'terminal', sessionId: other });
    expect(t.sendText).toHaveBeenCalledTimes(2);
  });

  it('does not enqueue more native queries while a slow bootstrap overlaps polling', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    const request = refreshTraexTerminalSession(t.pty);
    const run = vi.fn(async () => {});
    const scope = {
      structuredBridgeIs: (id: string) => id === 'traex', backend: t.pty,
      traexBridgePidProbeLastMs: 0, TRAEX_BRIDGE_PID_PROBE_INTERVAL_MS: 5000,
      currentTraexObservedPid: () => 43212, log: vi.fn(), codexBridgeRolloutPath: undefined,
      lastSpawnEffectiveResume: false, findTraexRolloutByPid: () => undefined,
      noteTraexProcessFileSource: vi.fn(), lastInitConfig: { adoptMode: true },
      captureAdoptWriteFence: () => ({ backend: t.pty }), adapterInputHandle: (value: PtyHandle) => value,
      traexTerminalIdentityNeedsRefresh, traexTerminalInputBlocked,
      hasPendingInputForFlush: () => false, adoptWriteQueue: { run },
    };
    const poll = loadWorkerFunction('maybeFollowTraexSessionRotationViaPid', scope);
    for (let tick = 0; tick < 4; tick++) { scope.traexBridgePidProbeLastMs = 0; poll(); }
    expect(run).not.toHaveBeenCalled();
    expect(await resolve(request)).toMatchObject({ kind: 'terminal', sessionId: sid });
    for (let tick = 0; tick < 24; tick++) {
      t.changeState(idle(`ordinary output ${tick}`));
      await vi.advanceTimersByTimeAsync(5000); poll();
    }
    expect(run).not.toHaveBeenCalled();
    expect(t.sendText).toHaveBeenCalledTimes(1);
  });

  it('never submits a draft added while the read-only query is waiting to send Enter', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal(); const request = refreshTraexTerminalSession(t.pty);
    t.changeState(idle('latest answer', '/status and a human draft'));
    expect(await resolve(request)).toEqual({ kind: 'unavailable' });
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('does not send Escape or bind after the worker generation is replaced', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal(); let current = true;
    const request = refreshTraexTerminalSession(t.pty, () => current);
    current = false;
    expect(await resolve(request)).toEqual({ kind: 'unavailable' });
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
    expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(false);
  });

  it('never binds after cancellation during the status-page close wait', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal(); let current = true;
    const original = t.sendSpecialKeys.getMockImplementation()!;
    t.sendSpecialKeys.mockImplementation(key => {
      original(key);
      if (key === 'Escape') setTimeout(() => { current = false; }, 10);
    });
    expect(await resolve(refreshTraexTerminalSession(t.pty, () => current))).toEqual({ kind: 'unavailable' });
    expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(false);
  });

  it('refuses a multiline draft even when its cursor has moved back to the query row', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal(); const request = refreshTraexTerminalSession(t.pty);
    t.changeState({ viewport: 'latest answer\n❯ /status\n  my human draft\n▀▀▀▀▀\n  GPT-6 · Context 79% left\n  ? for shortcuts', cursor: { x: 9, y: 1 } });
    expect(await resolve(request)).toEqual({ kind: 'unavailable' });
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('does not mistake a divider or Context-like draft line for the native footer', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.changeState({ viewport: 'latest answer\n❯ Implement {feature}\n  Context 42% left\n▀▀▀▀▀\n  GPT-6 · Context 79% left\n  ? for shortcuts', cursor: { x: 2, y: 1 } });
    expect(await refreshTraexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
    t.changeState(idle());
    const request = refreshTraexTerminalSession(t.pty);
    t.changeState({ viewport: 'latest answer\n❯ /status\n─────\n  human draft\n▀▀▀▀▀\n  GPT-6 · Context 79% left\n  ? for shortcuts', cursor: { x: 9, y: 1 } });
    expect(await resolve(request)).toEqual({ kind: 'unavailable' });
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('blocks concatenating a later task after an unconfirmed native query and releases only on a clean composer', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendSpecialKeys.mockImplementation(() => false as never);
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable' });
    expect(traexTerminalInputBlocked(t.pty)).toBe(true);
    t.changeState(idle());
    expect(traexTerminalInputBlocked(t.pty)).toBe(false);
    expect(traexTerminalInputBlocked({ write: vi.fn() })).toBe(false);
  });

  it('cannot mistake a historical status card or two identities for the active status panel', () => {
    const stale = { viewport: `${panel().viewport}\n❯ Implement {feature}`, cursor: { x: 2, y: 7 } };
    expect(traexStatusSessionId(stale)).toBeUndefined();
    const ambiguous = panel(); ambiguous.viewport += `\n Session: ${other}`;
    expect(traexStatusSessionId(ambiguous)).toBeUndefined();
    const busy = panel(); busy.viewport += '\n Working (1s · esc to interrupt)'; busy.cursor = { x: 0, y: 7 };
    expect(traexStatusSessionId(busy)).toBeUndefined();
    expect(traexStatusSessionId(panel())).toBe(sid);
    expect(traexEmptyComposer(idle())).toBe(true);
    expect(traexEmptyComposer({ ...idle(), cursor: { x: 4, y: 1 } })).toBe(false);
  });

  it('does not dismiss a new active task when historical status text remains during a redraw', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendSpecialKeys.mockImplementation(key => {
      const current = panel(other);
      if (key === 'Enter') {
        current.viewport += '\n Working (1s · esc to interrupt)'; current.cursor = { x: 0, y: 7 };
        t.changeState(current);
      }
    });
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable' });
    expect(t.sendSpecialKeys.mock.calls).toEqual([['Enter']]);
    expect(traexTerminalSessionIsBound(t.pty, other)).toBe(false);
  });

  it('pins an exact input receipt to its submitting backend, never a same-PID peer or successor', () => {
    const t = terminal();
    expect(bindTraexSessionFromCorrelatedInput(t.pty, 43212, sid, traexTerminalIdentityGeneration(t.pty))).toBe(true);
    expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(true);
    expect(traexTerminalSessionIsBound({ ...t.pty }, sid)).toBe(false);
    t.pty.cliPid = 43213;
    expect(bindTraexSessionFromCorrelatedInput(t.pty, 43212, other, traexTerminalIdentityGeneration(t.pty))).toBe(false);
    expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(false);
  });

  it('accepts every native empty-composer hint while preserving cursor geometry', () => {
    for (const hint of TRAEX_EMPTY_COMPOSER_HINTS) {
      expect(traexEmptyComposer(idle('latest answer', hint)), hint).toBe(true);
    }
    expect(traexEmptyComposer({ ...idle('latest answer', 'Summarize recent commits'), cursor: { x: 26, y: 1 } })).toBe(false);
  });

  it('never dismisses a status panel that overlaps any native active-turn label', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    for (const label of TRAEX_SPINNER_LABELS) {
      const t = terminal();
      t.sendSpecialKeys.mockImplementation(key => {
        if (key !== 'Enter') return;
        const current = panel(other);
        const activeLabel = label.endsWith('…') ? label : `${label}…`;
        current.viewport += `\n❖ ${activeLabel} (12s • esc to interrupt)`;
        current.cursor = { x: 0, y: 7 };
        t.changeState(current);
      });
      expect(await resolve(refreshTraexTerminalSession(t.pty)), label).toEqual({ kind: 'unavailable' });
      expect(t.sendSpecialKeys.mock.calls, label).toEqual([['Enter']]);
      expect(traexTerminalSessionIsBound(t.pty, other)).toBe(false);
    }
  });

  it('closes a recognised negative status result, releases commands, and does not reopen it on an unchanged idle screen', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendSpecialKeys.mockImplementation(key => {
      if (key === 'Enter') t.changeState({
        ...panel(sid),
        viewport: panel(sid).viewport.replace('Local background server', 'Embedded process'),
      });
      if (key === 'Escape') t.changeState(idle());
    });
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable', inputReleased: true });
    expect(t.sendSpecialKeys.mock.calls).toEqual([['Enter'], ['Escape']]);
    expect(traexTerminalInputBlocked(t.pty)).toBe(false);
    expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(false);
    expect(traexTerminalIdentityNeedsRefresh(t.pty)).toBe(false);
    expect(await refreshTraexTerminalSession(t.pty)).toEqual({ kind: 'unavailable' });
    expect(t.sendText).toHaveBeenCalledTimes(1);
  });

  it('waits for a shared-server panel painted across multiple frames before binding', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendSpecialKeys.mockImplementation(key => {
      if (key === 'Enter') {
        const complete = panel(sid);
        const partial = {
          ...complete,
          viewport: complete.viewport.replace(` Session: ${sid}\n Limits: data not available yet`, ''),
          cursor: { x: 45, y: 4 },
        };
        t.changeState(partial);
        setTimeout(() => t.changeState(complete), 100);
      }
      if (key === 'Escape') t.changeState(idle());
    });
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'terminal', sessionId: sid, inputReleased: true });
    expect(t.sendSpecialKeys.mock.calls).toEqual([['Enter'], ['Escape']]);
    expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(true);
  });

  it('closes a persistently incomplete panel without retrying its text on later redraws', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendSpecialKeys.mockImplementation(key => {
      if (key === 'Enter') {
        const complete = panel(sid);
        t.changeState({
          ...complete,
          viewport: complete.viewport.replace(` Session: ${sid}\n Limits: data not available yet`, ''),
          cursor: { x: 45, y: 4 },
        });
      }
      if (key === 'Escape') t.changeState(idle());
    });
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable', inputReleased: true });
    expect(t.sendSpecialKeys.mock.calls).toEqual([['Enter'], ['Escape']]);
    expect(traexTerminalInputBlocked(t.pty)).toBe(false);
    t.changeState(idle('partial panel later redraw'));
    expect(traexTerminalIdentityNeedsRefresh(t.pty)).toBe(false);
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable' });
    expect(t.sendText).toHaveBeenCalledTimes(1);
  });

  it('rejects a delayed receipt captured before a newer same-PID status identity', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    const staleGeneration = traexTerminalIdentityGeneration(t.pty);
    t.sendSpecialKeys.mockImplementation(key => {
      if (key === 'Enter') t.changeState(panel(other));
      if (key === 'Escape') t.changeState(idle());
    });
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toMatchObject({ kind: 'terminal', sessionId: other });
    expect(bindTraexSessionFromCorrelatedInput(t.pty, 43212, sid, staleGeneration)).toBe(false);
    expect(traexTerminalSessionIsBound(t.pty, other)).toBe(true);
    expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(false);
  });
});


describe('TRAE bounded bootstrap paint window', () => {
  const query = () => ({ ...idle('latest answer', '/status'), cursor: { x: 9, y: 1 } });
  const incomplete = () => ({ viewport: 'latest answer\n❯ /status\n▀▀▀▀▀', cursor: { x: 9, y: 1 } });
  const failed = (pty: PtyHandle) => (terminalService as any).traexTerminalBootstrapFailed?.(pty) ?? false;

  it.each(['footer', 'clipboard', 'old-frame'])('waits read-only for delayed %s paint and submits exactly once', async surface => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendText.mockImplementation(() => {
      t.changeState(surface === 'old-frame' ? idle() : surface === 'clipboard'
        ? { ...incomplete(), viewport: incomplete().viewport + '\n  Clipboard contains an image — press ctrl+v to attach it.' } : incomplete());
      setTimeout(() => t.changeState(query()), 700);
    });
    const request = refreshTraexTerminalSession(t.pty);
    expect(refreshTraexTerminalSession(t.pty)).toBe(request);
    await vi.advanceTimersByTimeAsync(600);
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
    expect(failed(t.pty)).toBe(false);
    expect(await resolve(request)).toMatchObject({ kind: 'terminal', sessionId: sid });
    expect(t.sendText).toHaveBeenCalledExactlyOnceWith('/status');
    expect(t.sendSpecialKeys.mock.calls).toEqual([['Enter'], ['Escape']]);
    expect(failed(t.pty)).toBe(false);
  });

  it.each(['draft', 'cursor', 'selection', 'busy', 'pid', 'cancel', 'unknown'])('stops after observed %s intervention even if the original query returns', async change => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal(); let current = true;
    t.sendText.mockImplementation(() => {
      t.changeState(incomplete());
      setTimeout(() => {
        if (change === 'pid') t.pty.cliPid!++;
        else if (change === 'cancel') current = false;
        else if (change === 'draft') t.changeState({ ...query(), viewport: query().viewport.replace('/status', '/status my task'), cursor: { x: 17, y: 1 } });
        else if (change === 'cursor') t.changeState({ ...incomplete(), cursor: { x: 2, y: 1 } });
        else if (change === 'selection') t.changeState({ ...incomplete(), viewport: 'latest answer\n❯ /status\n  /status show current session configuration and token usage\n❯ /statusline configure which items appear in the status line' });
        else if (change === 'busy') t.changeState({ ...incomplete(), viewport: incomplete().viewport + '\nThinking… (esc to interrupt)' });
        else t.changeState({ viewport: 'unknown screen', cursor: { x: 9, y: 1 } });
      }, 350);
      setTimeout(() => { current = true; t.pty.cliPid = 43212; t.changeState(query()); }, 650);
    });
    expect(await resolve(refreshTraexTerminalSession(t.pty, () => current))).toEqual({ kind: 'unavailable' });
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
    expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(false);
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable' });
    expect(t.sendText).toHaveBeenCalledTimes(1);
  });

  it('times out once without allowing a later repaint to replenish the query budget', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal(); t.sendText.mockImplementation(() => t.changeState(incomplete()));
    const request = refreshTraexTerminalSession(t.pty);
    await vi.advanceTimersByTimeAsync(1800);
    expect(failed(t.pty)).toBe(false);
    expect(traexTerminalIdentityNeedsRefresh(t.pty)).toBe(false);
    expect(await resolve(request)).toEqual({ kind: 'unavailable' });
    expect(failed(t.pty)).toBe(true);
    t.changeState(query());
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable' });
    expect(t.sendText).toHaveBeenCalledTimes(1);
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
    t.changeState(idle()); expect(traexTerminalInputBlocked(t.pty)).toBe(false);
    expect(failed(t.pty)).toBe(true);
    expect(bindTraexSessionFromCorrelatedInput(t.pty, 43212, sid, traexTerminalIdentityGeneration(t.pty))).toBe(true);
    expect(failed(t.pty)).toBe(false);
  });

  it('does not call an unqueried human draft a failed bootstrap', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal(); t.changeState({ ...idle('answer', 'my draft'), cursor: { x: 10, y: 1 } });
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable' });
    expect(failed(t.pty)).toBe(false);
    expect(traexTerminalIdentityNeedsRefresh(t.pty)).toBe(true);
    expect(t.sendText).not.toHaveBeenCalled();
  });
});


describe('TRAE bootstrap human intervention across all wait stages', () => {
  it.each(['  my Context draft', '  /model choose a Context window', '  my task ? for shortcuts'])('never treats footer-like human text as paint tolerance: %s', async row => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendText.mockImplementation(() => {
      t.changeState({ viewport: 'answer\n❯ /status\n▀▀▀▀▀', cursor: { x: 9, y: 1 } });
      setTimeout(() => t.changeState({ viewport: `answer\n❯ /status\n${row}`, cursor: { x: 9, y: 1 } }), 350);
      setTimeout(() => t.changeState({ ...idle('answer', '/status'), cursor: { x: 9, y: 1 } }), 800);
    });
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable' });
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
    expect(t.sendText).toHaveBeenCalledTimes(1);
  });
  it('never binds after a human draft is observed during the close wait and then cleared', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendSpecialKeys.mockImplementation(key => {
      if(key === 'Enter') t.changeState(panel());
      else t.changeState({ ...idle('answer', 'my unsent draft'), cursor: { x: 17, y: 1 } });
    });
    const request = refreshTraexTerminalSession(t.pty);
    await vi.advanceTimersByTimeAsync(400); t.changeState(idle());
    expect(await resolve(request)).toEqual({ kind: 'unavailable' });
    expect(traexTerminalSessionIsBound(t.pty, sid)).toBe(false);
    expect(t.sendSpecialKeys.mock.calls).toEqual([['Enter'], ['Escape']]);
  });
});


describe('TRAE native footer and close-paint compatibility', () => {
  it.each(['Workspace Edit · ? for shortcuts', 'Full Access · ? for shortcuts', '? for shortcuts · ← for agents'])('keeps the exact native hint row compatible: %s', async hint => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    const surface = { ...idle(), viewport: idle().viewport.replace('? for shortcuts', hint) };
    t.changeState(surface);
    expect(traexEmptyComposer(surface)).toBe(true);
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toMatchObject({ kind: 'terminal', sessionId: sid });
    expect(t.sendText).toHaveBeenCalledTimes(1);
  });
  it('does not treat an old prompt above the closing native panel as a new human draft', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendSpecialKeys.mockImplementation(key => {
      if(key === 'Enter') t.changeState(panel());
      else {
        t.changeState({ viewport: '❯ old quoted draft\n' + panel().viewport, cursor: { x: 45, y: 7 } });
        setTimeout(() => t.changeState(idle()), 150);
      }
    });
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toMatchObject({ kind: 'terminal', sessionId: sid });
    expect(t.sendSpecialKeys.mock.calls).toEqual([['Enter'], ['Escape']]);
  });
});

describe('TRAE input debt during a delayed native text paint', () => {
  it('keeps input blocked while the pending bootstrap still shows the old empty composer', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendText.mockImplementation(() => {
      setTimeout(() => t.changeState({ viewport: 'answer\n❯ /status\n▀▀▀▀▀', cursor: { x: 9, y: 1 } }), 1500);
    });
    const request = refreshTraexTerminalSession(t.pty);
    await vi.advanceTimersByTimeAsync(1000);
    expect(traexTerminalInputBlocked(t.pty)).toBe(true);
    expect(await resolve(request)).toEqual({ kind: 'unavailable' });
    expect(traexTerminalInputBlocked(t.pty)).toBe(true);
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
    t.changeState(idle());
    expect(traexTerminalInputBlocked(t.pty)).toBe(false);
    expect(t.sendText).toHaveBeenCalledTimes(1);
  });
});

describe('TRAE input debt after an unpainted query timeout', () => {
  it('does not release an unseen query on the stale empty frame after timeout', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendText.mockImplementation(() => {
      setTimeout(() => t.changeState({ viewport: 'answer\n❯ /status\n▀▀▀▀▀', cursor: { x: 9, y: 1 } }), 3000);
    });
    const request = refreshTraexTerminalSession(t.pty);
    await vi.advanceTimersByTimeAsync(2100);
    expect(await request).toEqual({ kind: 'unavailable' });
    expect(traexTerminalInputBlocked(t.pty)).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(traexTerminalInputBlocked(t.pty)).toBe(true);
    t.changeState(idle());
    expect(traexTerminalInputBlocked(t.pty)).toBe(false);
    expect(t.sendText).toHaveBeenCalledTimes(1);
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
  });
});

describe('TRAE native status picker with unselected Skill suggestions', () => {
  // Native rows from the 0.216 live picker, excluding private transcript/title.
  const menu = () => ({
    viewport: 'latest answer\n❯ /status\n▀▀▀▀▀\n\n❯ /status                                      show current session configuration and token usage\n  /statusline                                  configure which items appear in the status line\n  /understand-chat (understand-anything)       [Skill] Use when you need to ask questions about a codebase or understand code using a knowledge graph\n  /understand (understand-anything)            [Skill] Analyze a codebase to produce an interactive knowledge graph for understanding architecture, components, and relationships\n  /understand-dashboard (understand-anything)  [Skill] Launch the interactive web dashboard to visualize a codebase\'s knowledge graph\n  /understand-diff (understand-anything)       [Skill] Use when you need to analyze git diffs or pull requests to understand what changed, affected components, and risks\n▼',
    cursor: { x: 9, y: 1 },
  });
  it('submits the selected exact status command despite additional unselected native skills', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal(); t.sendText.mockImplementation(() => t.changeState(menu()));
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toMatchObject({ kind: 'terminal', sessionId: sid });
    expect(t.sendText).toHaveBeenCalledExactlyOnceWith('/status');
    expect(t.sendSpecialKeys.mock.calls).toEqual([['Enter'], ['Escape']]);
  });
  it.each(['selected-skill', 'builtin', 'draft', 'unknown-row', 'arrow-middle', 'duplicate-status', 'cursor'])('rejects %s among additional picker suggestions', async change => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendText.mockImplementation(() => {
      const value = menu();
      if(change === 'selected-skill') value.viewport = value.viewport.replace('❯ /status                                      ', '  /status                                      ').replace('  /understand-chat', '❯ /understand-chat');
      if(change === 'builtin') value.viewport += '\n  /model choose a model';
      if(change === 'draft') value.viewport = value.viewport.replace('❯ /status\n', '❯ /status\n  my task\n');
      if(change === 'unknown-row') value.viewport += '\nmy task ? for shortcuts';
      if(change === 'arrow-middle') value.viewport = value.viewport.replace('  /understand-chat', '▼\n  /understand-chat');
      if(change === 'duplicate-status') value.viewport += '\n❯ /status show current session configuration and token usage';
      if(change === 'cursor') value.cursor.x = 2;
      t.changeState(value);
    });
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable' });
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
    expect(t.sendText).toHaveBeenCalledTimes(1);
  });
});

describe('TRAE native Skill suggestion display characters', () => {
  it.each(['\x00', '\x07', '\x08', '\x0b', '\x0c', '\x1b', '\x7f', 'group-bell'])('rejects residual nonprinting characters in metadata (%j)', async control => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    const group = control === 'group-bell' ? 'team\x07skills' : 'team-skills';
    const description = control === 'group-bell' ? 'Review a codebase'
      : control === '\x1b' ? `Review a codebase${control}` : `Review${control} a codebase`;
    t.sendText.mockImplementation(() => t.changeState({
      viewport: `answer\n❯ /status\n▀▀▀▀▀\n❯ /status show current session configuration and token usage\n  /review (${group}) [Skill] ${description}\n▼`, cursor: { x: 9, y: 1 },
    }));
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toEqual({ kind: 'unavailable' });
    expect(t.sendSpecialKeys).not.toHaveBeenCalled();
  });
  it('accepts ordinary ANSI colour styling after normalization', async () => {
    vi.useFakeTimers(); vi.mocked(findTraexRolloutSetByPid).mockReturnValue(new Set());
    const t = terminal();
    t.sendText.mockImplementation(() => t.changeState({
      viewport: 'answer\n❯ /status\n▀▀▀▀▀\n❯ /status show current session configuration and token usage\n  /review (team-skills) [Skill] \x1b[32mReview a codebase\x1b[0m\n▼', cursor: { x: 9, y: 1 },
    }));
    expect(await resolve(refreshTraexTerminalSession(t.pty))).toMatchObject({ kind: 'terminal', sessionId: sid });
    expect(t.sendText).toHaveBeenCalledTimes(1);
    expect(t.sendSpecialKeys.mock.calls).toEqual([['Enter'], ['Escape']]);
  });
});
