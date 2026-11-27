import './helpers/require-fenced-data-dir.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execSync, execFileSync } from 'node:child_process';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
vi.mock('node:child_process', () => ({ ...require('node:child_process'), execSync: vi.fn(), execFileSync: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe('TmuxPipeBackend live input snapshot', () => {
  const screen = 'last reply\n❯ /status\n▀▀▀▀▀\n  GPT-6 · Context 79% left\n';
  it.each([undefined, '/private/tmp/private-socket'])('keeps caret and viewport in the same server command queue (%s)', socketName => {
    // Two separate clients straddle a repaint. A single command queue sees
    // one server grid and therefore pairs its new caret with its new text.
    vi.mocked(execSync).mockReturnValue('2 1\n');
    vi.mocked(execFileSync).mockImplementation((_cmd, args) => (args as string[]).includes(';') ? `9 1\n${screen}` : screen);
    const backend = new TmuxPipeBackend('private:0.0', { socketName });
    expect(backend.captureInputState()).toEqual({ cursor: { x: 9, y: 1 }, viewport: screen });
    expect(execSync).not.toHaveBeenCalled();
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });
  it.each(['\n', '-1 1\ntext', 'x y\ntext', '2 1junk\ntext', '99999999999999999999 1\ntext'])('does not turn unreadable cursor data into a usable snapshot (%j)', response => {
    vi.mocked(execSync).mockReturnValue('not a cursor');
    vi.mocked(execFileSync).mockReturnValue(response);
    expect(new TmuxPipeBackend('private:0.0').captureInputState()).toBeNull();
  });
  it('returns unavailable on a failed snapshot read without writing', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('snapshot failed'); });
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('snapshot failed'); });
    expect(new TmuxPipeBackend('private:0.0').captureInputState()).toBeNull();
  });
});
