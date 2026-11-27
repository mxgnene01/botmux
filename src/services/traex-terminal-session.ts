import type { PtyHandle } from '../adapters/cli/types.js';
import { findTraexRolloutSetByPid } from './traex-transcript.js';
import { stripAnsiScreenText } from '../utils/idle-detector.js';
import { delay } from '../utils/timing.js';
import {
  TRAEX_EMPTY_COMPOSER_HINTS,
  TRAEX_PROGRESS_PATTERN,
  traexViewportFooterBusy,
} from '../adapters/cli/traex-footer.js';

type Snapshot = ReturnType<NonNullable<PtyHandle['captureInputState']>>;
type Diagnostic = (stage: string, reason: string) => void;
type Resolution = { kind: 'legacy' | 'unavailable'; inputReleased?: boolean }
  | { kind: 'terminal'; sessionId: string; liveSinceMs?: number; inputReleased?: boolean };
const bindings = new WeakMap<PtyHandle, { pid: number; sessionId: string }>();
const generations = new WeakMap<PtyHandle, { pid: number; value: number }>();
// One intrusive bootstrap per backend/PID lifecycle. A text write with unknown
// delivery consumes this budget too; viewport changes never replenish it.
const queried = new WeakMap<PtyHandle, number>();
// An old /status belongs to the human or a previous observer. Do not defer a
// new intrusive query until after they clear it and start their local work.
const abandoned = new WeakMap<PtyHandle, number>();
const pending = new WeakMap<PtyHandle, Promise<Resolution>>();
const incompleteQueries = new WeakMap<PtyHandle, number>();
const observedQueries = new WeakMap<PtyHandle, number>();

function snapshot(terminal: PtyHandle): Snapshot {
  try { return terminal.captureInputState?.() ?? null; } catch { return null; }
}

function lastMatchingRow(rows: string[], pattern: RegExp): number {
  for (let i = rows.length - 1; i >= 0; i--) if (pattern.test(rows[i]!)) return i;
  return -1;
}

// Match complete native footer rows, never keywords occurring in a draft.
const nativeStatusRow = /^[ \t]*\S[^│\r\n]* · (?:[^│\r\n]* · )?Context (?:\d+% (?:left|used)|[—–-])(?: · [^\r\n]*)?[ \t]*$/;
const nativeHintRow = /^[ \t]*(?:(?:[☢▧] )?(?:Full Access|Read Only|Auto Mode|Workspace Edit|Auto|Default)[ \t]+·[ \t]+)?(?:\? for shortcuts|← for agents)(?:[ \t]+·[ \t]+(?:\? for shortcuts|← for agents))*[ \t]*$/;
const clipboardRow = /^[ \t]*Clipboard contains an image — press ctrl\+v to attach it\.[ \t]*$/;
function nativeFooterReady(rows: string[]): boolean {
  const footer = rows.filter(row => row.trim());
  return footer.length >= 1 && footer.length <= 3 && nativeStatusRow.test(footer[0]!)
    && footer.slice(1).every(row => nativeHintRow.test(row));
}

/** Read the live composer, never a prompt-looking line in scrollback. */
export function traexEmptyComposer(state: Snapshot): boolean {
  if (!state || traexViewportFooterBusy(state.viewport)) return false;
  const rows = stripAnsiScreenText(state.viewport).split(/\r?\n/);
  const row = rows[state.cursor.y];
  const match = /^(\s*)[›❯] ([^\r\n]*?)\s*$/.exec(row ?? '');
  // Native TRAE puts its real composer at column 0; continuation rows are
  // indented. A literal prompt/placeholder inside a multiline draft is not
  // an empty composer and cannot release held input.
  if (!match || match[1]!.length !== 0 || state.cursor.x !== 2) return false;
  // The cursor remains immediately after the prompt for a native placeholder;
  // real typed text moves it. Keep that geometry check separate from the hint
  // vocabulary so a human draft cannot become write permission.
  if (!TRAEX_EMPTY_COMPOSER_HINTS.has(match[2]!.trim())) return false;
  const footerStart = lastMatchingRow(rows, /^[▀▄█─]+\s*$/);
  if (footerStart <= state.cursor.y || rows.slice(state.cursor.y + 1, footerStart).some(line => line.trim())) return false;
  return nativeFooterReady(rows.slice(footerStart + 1));
}

/** Recognise only the exact query we just inserted. TRAE's slash picker
 * replaces the normal footer, so absence of Context is not itself a draft.
 * Native picker rows are allowed only with /status selected and the cursor at
 * the end of that exact query; no other completion or human text may ride Enter. */
function traexStatusQueryReadyForEnter(state: Snapshot): boolean {
  if (!state || traexViewportFooterBusy(state.viewport)) return false;
  const rows = stripAnsiScreenText(state.viewport).split(/\r?\n/);
  const prompt = lastMatchingRow(rows, /^[›❯] \/status\s*$/);
  if (prompt < 0 || state.cursor.y < prompt || state.cursor.y > prompt + 2) return false;
  const query = /^(\s*)[›❯] \/status\s*$/.exec(rows[prompt]!);
  // Completion can restore the ordinary footer before a human moves the
  // caret. Check ownership before either surface's fast path, not just menus.
  if (state.cursor.y === prompt
    ? state.cursor.x !== query![1]!.length + 9
    : state.cursor.x > 2) return false;
  const footerStart = lastMatchingRow(rows, /^[▀▄█─]+\s*$/);
  const nativeFooter = footerStart > prompt
    && nativeFooterReady(rows.slice(footerStart + 1));
  if (nativeFooter && !rows.slice(prompt + 1, footerStart).some(line => line.trim())) return true;
  // A picker is not a soft-newline retry: its cursor must still be on the
  // composer, not on a multiline draft or a different menu selection.
  if (state.cursor.y !== prompt) return false;
  const menu = rows.slice(prompt + 1, nativeFooter ? footerStart : rows.length)
    .filter(line => line.trim());
  // Some frontends retain the composer's bottom rule before replacing the
  // footer with suggestions. Do not accept dividers elsewhere in the menu.
  if (/^[▀▄█─]+\s*$/.test(menu[0] ?? '')) menu.shift();
  // Native fuzzy suggestions may retain unselected Skill entries after
  // /statusline. They are not a changed selection: only the first row owns
  // Enter. Accept their complete native row shape, never arbitrary commands
  // or a second selection marker. The scroll marker is allowed only at end.
  if (/^\s*▼\s*$/.test(menu.at(-1) ?? '')) menu.pop();
  return menu.length >= 1 && menu.length <= 64
    && /^\s*[›❯>] \/status\s+show current session configuration and token usage\s*$/.test(menu[0]!)
    && menu.slice(1).every(line =>
      /^\s*\/statusline\s+configure which items appear in the status line\s*$/.test(line)
      || (!/[\x00-\x08\x0b-\x1f\x7f]/.test(line)
        && /^[ \t]{2,}\/[a-zA-Z0-9][a-zA-Z0-9:_-]*(?:[ \t]+\([^()\r\n]+\))?[ \t]+\[Skill\][ \t]+\S[^\r\n]*$/.test(line)));
}

/** Read-only paint tolerance is not permission to press Enter. Keep exact
 * composer/caret ownership while waiting for the original strict ready gate. */
function traexStatusQueryStillOwned(state: Snapshot): boolean {
  if (!state || traexViewportFooterBusy(state.viewport)) return false;
  if (traexStatusQueryReadyForEnter(state)) return true;
  const rows = stripAnsiScreenText(state.viewport).split(/\r?\n/);
  const prompt = lastMatchingRow(rows, /^[›❯] \/status\s*$/);
  const match = /^(\s*)[›❯] \/status\s*$/.exec(rows[prompt] ?? '');
  if (!match || state.cursor.y !== prompt || state.cursor.x !== match[1]!.length + 9) return false;
  const tail = rows.slice(prompt + 1).filter(row => row.trim());
  if (!tail.length) return true; // The query painted before its bottom rule.
  if (!/^[▀▄█─]+\s*$/.test(tail[0]!)) return false;
  tail.shift();
  // Known footer rows must be below the actual bottom rule. A draft carrying
  // the same words (or a Context-looking menu) can never be a pending footer.
  return tail.length <= 3 && tail.every((row, index) =>
    index === 0 ? nativeStatusRow.test(row) || clipboardRow.test(row) || nativeHintRow.test(row)
      : nativeHintRow.test(row));
}

/** A typed query may paint in several frames. This is read-only tolerance
 * before the first full query, never permission to submit a partial command. */
function traexStatusQueryPaintLength(state: Snapshot): number | undefined {
  if (!state || traexViewportFooterBusy(state.viewport)) return;
  const rows = stripAnsiScreenText(state.viewport).split(/\r?\n/);
  const row = /^(\s*)[›❯] (\/[a-z]*)\s*$/.exec(rows[state.cursor.y] ?? '');
  if (!row || row[1]!.length !== 0 || !'/status'.startsWith(row[2]!) || row[2]!.length >= 7
    || state.cursor.x !== row[1]!.length + 2 + row[2]!.length) return;
  // Reuse the strict surface validator with a projected full query, only to
  // classify the paint. Every actual Enter still rechecks the real full text.
  rows[state.cursor.y] = `${row[1]}❯ /status`;
  if (!traexStatusQueryStillOwned({ viewport: rows.join('\n'), cursor: { x: row[1]!.length + 9, y: state.cursor.y } })) return;
  return row[2]!.length;
}

/** Closing can repaint an empty composer gradually, but a person typing or
 * moving its caret ends this operation permanently, even if they undo it. */
function traexComposerIntervened(state: Snapshot): boolean {
  if (!state) return false;
  if (traexViewportFooterBusy(state.viewport)) return true;
  const rows = stripAnsiScreenText(state.viewport).split(/\r?\n/);
  const prompt = lastMatchingRow(rows, /^\s*[›❯](?:\s|$)/);
  if (prompt < 0) return false;
  const header = lastMatchingRow(rows, /^\s*>_ TRAE CLI \(v[^\r\n]+\)\s*$/);
  if (header > prompt) return false; // The old prompt is above the active panel.
  const row = /^(\s*)[›❯] ([^\r\n]*?)\s*$/.exec(rows[prompt]!);
  return !row || !TRAEX_EMPTY_COMPOSER_HINTS.has(row[2]!.trim())
    || state.cursor.y !== prompt || state.cursor.x !== row[1]!.length + 2;
}

type TraexStatusPanel = { sessionId?: string; retryable: boolean };

/** Recognise the native panel separately from whether it carries a bindable
 * shared-server identity. A recognised negative result must still be closed. */
function traexStatusPanel(state: Snapshot, settleIncomplete = false): TraexStatusPanel | undefined {
  if (!state) return;
  const rows = stripAnsiScreenText(state.viewport).split(/\r?\n/);
  const header = lastMatchingRow(rows, /^\s*>_ TRAE CLI \(v[^\r\n]+\)\s*$/);
  if (header < 0 || state.cursor.y <= header) return;
  const panel = rows.slice(header);
  if (panel.some(line => /^\s*[›❯](?:\s|$)/.test(line))) return;
  if (panel.some(line => TRAEX_PROGRESS_PATTERN.test(line)
    // Pre-ellipsis recordings used a shorter activity row. Keep that legacy
    // guard alongside the complete shared spinner vocabulary.
    || /^\s*(?:[⋄◇◆✦◈❖✧]\s+)?(?:Working|Thinking|Queued)[^\r\n]*\besc to interr?upt\b/.test(line))) return;
  // Require native panel structure, not just a header quoted in scrollback.
  // Identity extraction below deliberately remains stricter than recognition.
  const nativeFields = panel.filter(line => /^\s*(?:Execution host|Directory|Session|Limits):/.test(line));
  if (nativeFields.length < 2) {
    return settleIncomplete && nativeFields.length > 0 ? { retryable: true } : undefined;
  }
  const host = panel.find(line => /^\s*Execution host:/.test(line));
  if (host && !/^\s*Execution host:\s+Local background server\s*$/.test(host)) {
    return { retryable: false };
  }
  const ids = panel.flatMap(line => {
    const m = /^\s*Session:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/i.exec(line);
    return m ? [m[1]!.toLowerCase()] : [];
  });
  const limits = panel.some(line => /^\s*Limits:/.test(line));
  if (ids.length === 1 && limits && host) return { sessionId: ids[0], retryable: false };
  // Native panels are painted incrementally. Missing host/session/limits is a
  // pending frame, not proof of an unsupported frontend. Only the last poll
  // closes it as retryable; a complete ambiguous panel is a settled negative.
  if (!host || ids.length === 0 || !limits) return settleIncomplete ? { retryable: true } : undefined;
  return { retryable: false };
}

/** Only a freshly requested native status panel can supply this identity. */
export function traexStatusSessionId(state: Snapshot): string | undefined {
  return traexStatusPanel(state)?.sessionId;
}

export function traexTerminalSessionIsBound(terminal: PtyHandle, sessionId: string): boolean {
  const binding = bindings.get(terminal);
  return !!binding && binding.pid === terminal.cliPid && binding.sessionId === sessionId.toLowerCase();
}

function traexGeneration(terminal: PtyHandle): number {
  const current = generations.get(terminal);
  return current && current.pid === terminal.cliPid ? current.value : 0;
}

/** Public to the adapter so each write captures the identity epoch it belongs
 * to. A receipt from an older epoch may settle that write, never rotate the
 * terminal away from a newer native session. */
export function traexTerminalIdentityGeneration(terminal: PtyHandle): number {
  return traexGeneration(terminal);
}

function advanceTraexGeneration(terminal: PtyHandle, pid: number): void {
  generations.set(terminal, { pid, value: traexGeneration(terminal) + 1 });
}

/** Background polling may bootstrap once, but ordinary output is not evidence
 * of a new identity. Local /new or /resume requires a fresh adopt until TRAE
 * exposes a verified read-only frontend identity. Exact input receipts still
 * follow session changes without writing native commands. */
export function traexTerminalIdentityNeedsRefresh(terminal: PtyHandle): boolean {
  if (pending.has(terminal)) return false;
  const pid = terminal.cliPid;
  return bindings.get(terminal)?.pid !== pid && queried.get(terminal) !== pid && abandoned.get(terminal) !== pid;
}

/** A consumed bootstrap without a binding is a real failure only once its
 * pending operation has settled. Busy/draft deferrals have not queried yet. */
export function traexTerminalBootstrapFailed(terminal: PtyHandle): boolean {
  const pid = terminal.cliPid;
  return !!pid && (queried.get(terminal) === pid || abandoned.get(terminal) === pid) && bindings.get(terminal)?.pid !== pid
    && !pending.has(terminal);
}

/** An uncertain native command must never be concatenated with a later task.
 * Only a positively empty composer or a new frontend generation releases it. */
export function traexTerminalInputBlocked(terminal: PtyHandle): boolean {
  const pid = incompleteQueries.get(terminal);
  if (pid === undefined || pid !== terminal.cliPid) return false;
  // A pending text write can still be invisible in the native viewport. The
  // old empty frame is not evidence that its input debt was cleared.
  if (pending.has(terminal)) return true;
  const state = snapshot(terminal);
  if (traexStatusQueryStillOwned(state)) observedQueries.set(terminal, pid);
  // After timeout an unchanged old empty frame still cannot attest that the
  // query was cleared. Require having observed its delivery first.
  if (observedQueries.get(terminal) === pid && traexEmptyComposer(state)) {
    incompleteQueries.delete(terminal);
    return false;
  }
  return true;
}

export function bindTraexSessionFromCorrelatedInput(
  terminal: PtyHandle,
  pid: number,
  sessionId: string,
  expectedGeneration: number,
): boolean {
  if (terminal.cliPid !== pid || pending.has(terminal)
    || traexGeneration(terminal) !== expectedGeneration) return false;
  const normalized = sessionId.toLowerCase();
  const existing = bindings.get(terminal);
  if (existing?.pid !== pid || existing.sessionId !== normalized) {
    bindings.set(terminal, { pid, sessionId: normalized });
    // This receipt is newer than the captured epoch. Advancing after accepting
    // it prevents another delayed receipt from the same older write from
    // overwriting this identity later.
    advanceTraexGeneration(terminal, pid);
  }
  return true;
}

/** Call under the worker's adopted-terminal write queue. No model prompt,
 * config edit, Ctrl+C, or daemon-wide transcript scan is involved. */
export function refreshTraexTerminalSession(
  terminal: PtyHandle,
  isCurrent: () => boolean = () => true,
  diagnostic?: Diagnostic,
): Promise<Resolution> {
  const existing = pending.get(terminal);
  if (existing) return existing;
  const task = refresh(terminal, isCurrent, diagnostic).finally(() => pending.delete(terminal));
  pending.set(terminal, task);
  return task;
}

async function refresh(terminal: PtyHandle, isCurrent: () => boolean, diagnostic?: Diagnostic): Promise<Resolution> {
  const note = (stage: string, reason: string) => { try { diagnostic?.(stage, reason); } catch { /* Diagnostics cannot grant or revoke input. */ } };
  const pid = terminal.cliPid;
  if (!pid || !terminal.captureInputState) return { kind: 'legacy' };
  const owned = findTraexRolloutSetByPid(pid);
  if (owned === undefined || owned.size > 0) return { kind: 'legacy' };
  const binding = bindings.get(terminal);
  if (binding?.pid === pid) return { kind: 'terminal', sessionId: binding.sessionId };
  if (queried.get(terminal) === pid || abandoned.get(terminal) === pid) return { kind: 'unavailable' };
  const state = snapshot(terminal);
  if (!isCurrent()) return { kind: 'unavailable' };
  if (state && /^\s*[›❯] \/status\s*$/.test(stripAnsiScreenText(state.viewport).split(/\r?\n/)[state.cursor.y] ?? '')) {
    abandoned.set(terminal, pid);
    // No text was sent, but raw commands/tasks must still not concatenate
    // with this positively observed human draft. Only a real empty composer
    // (or a new PID) releases the input debt; it never re-arms the bootstrap.
    incompleteQueries.set(terminal, pid); observedQueries.set(terminal, pid);
    note('initial', 'preexisting-query'); return { kind: 'unavailable' };
  }
  if (!traexEmptyComposer(state)) return { kind: 'unavailable' };
  let generation: number | undefined;
  const current = () => terminal.cliPid === pid && isCurrent()
    && (generation === undefined || traexGeneration(terminal) === generation);
  const key = (name: 'Enter' | 'Escape') => terminal.sendSpecialKeys
    ? terminal.sendSpecialKeys(name) !== false
    : terminal.write(name === 'Enter' ? '\r' : '\x1b') !== false;
  try {
    // Recheck immediately before the first write. Never erase a person's draft.
    const latestInitial = snapshot(terminal);
    if (!current() || !latestInitial || latestInitial.viewport !== state?.viewport
      || !traexEmptyComposer(latestInitial)) return { kind: 'unavailable' };
    // Mark before attempting delivery: false/throw may still mean partial
    // delivery. Never replay the text after cancellation, timeout or repaint.
    queried.set(terminal, pid);
    advanceTraexGeneration(terminal, pid);
    generation = traexGeneration(terminal);
    incompleteQueries.set(terminal, pid);
    observedQueries.delete(terminal);
    bindings.delete(terminal);
    if ((terminal.sendText ? terminal.sendText('/status') : terminal.write('/status')) === false) { note('query-write', 'delivery-unconfirmed'); return { kind: 'unavailable' }; }
    let querySeen = false;
    let paintLength = 0;
    const stillOwned = (value: Snapshot, allowOldFrame: boolean): boolean => {
      if (traexStatusQueryStillOwned(value)) {
        querySeen = true; observedQueries.set(terminal, pid); return true;
      }
      if (allowOldFrame && !querySeen) {
        const length = traexStatusQueryPaintLength(value);
        if (length !== undefined) {
          if (length < paintLength) return false;
          paintLength = length; return true;
        }
      }
      if (!allowOldFrame || querySeen || paintLength !== 0 || !value || !state
        || !traexEmptyComposer(value) || value.cursor.x !== state.cursor.x || value.cursor.y !== state.cursor.y) return false;
      // Before delivery is visible, the same empty composer can redraw its
      // optional footer hint. That is not user input. Wait read-only; this
      // frame cannot release the input debt or authorize an Enter. A changed
      // placeholder/caret or any observed query permanently ends this path.
      return stripAnsiScreenText(value.viewport).split(/\r?\n/)[value.cursor.y]
        === stripAnsiScreenText(state.viewport).split(/\r?\n/)[state.cursor.y];
    };
    // Observe throughout the bounded window, not just its last frame: a draft
    // or caret change cannot regain write permission by later repainting.
    const waitForEnter = async (first: boolean): Promise<Snapshot> => {
      for (let poll = 0; poll <= 40; poll++) {
        if (!current()) { note('query-paint', 'generation-changed'); return null; }
        const value = snapshot(terminal);
        if (!stillOwned(value, first)) { note('query-paint', value ? 'ownership-lost' : 'snapshot-unavailable'); return null; }
        if ((!first || poll >= 5) && traexStatusQueryReadyForEnter(value)) return value;
        if (poll < 40) await delay(50);
      }
      note('query-paint', 'timeout');
      return null;
    };
    for (let attempt = 0; attempt < 3 && current(); attempt++) {
      const beforeEnter = await waitForEnter(attempt === 0);
      if (!beforeEnter) return { kind: 'unavailable' };
      // TRAE can first accept slash completion (or a soft newline) rather
      // than execute it. Only our unchanged command surface permits a retry.
      const latest = snapshot(terminal);
      if (!current() || !latest || latest.viewport !== beforeEnter.viewport
        || latest.cursor.x !== beforeEnter.cursor.x || latest.cursor.y !== beforeEnter.cursor.y
        || !traexStatusQueryReadyForEnter(latest)) { note('before-enter', 'surface-changed'); return { kind: 'unavailable' }; }
      if (!key('Enter')) { note('before-enter', 'delivery-unconfirmed'); return { kind: 'unavailable' }; }
      for (let poll = 0; poll < 20 && current(); poll++) {
        await delay(50);
        const panel = snapshot(terminal);
        const parsed = traexStatusPanel(panel, poll === 19);
        if (!parsed) {
          if (!traexStatusPanel(panel, true) && !stillOwned(panel, false)) { note('status-panel', 'surface-unrecognized'); return { kind: 'unavailable' }; }
          continue;
        }
        // Escape only the status panel we just read, never a changed screen.
        if (!current() || snapshot(terminal)?.viewport !== panel?.viewport || !key('Escape')) { note('status-panel', 'close-unconfirmed'); return { kind: 'unavailable' }; }
        for (let closePoll = 0; closePoll < 20 && current(); closePoll++) {
          await delay(50);
          if (!current()) return { kind: 'unavailable' };
          const restored = snapshot(terminal);
          if (traexComposerIntervened(restored)) { note('close-panel', 'ownership-lost'); return { kind: 'unavailable' }; }
          if (!traexEmptyComposer(restored)) continue;
          if (!current()) return { kind: 'unavailable' };
          incompleteQueries.delete(terminal);
          if (!parsed.sessionId) { note('status-panel', 'not-bindable'); return { kind: 'unavailable', inputReleased: true }; }
          bindings.set(terminal, { pid, sessionId: parsed.sessionId });
          return { kind: 'terminal', sessionId: parsed.sessionId, inputReleased: true };
        }
        note('close-panel', 'timeout'); return { kind: 'unavailable' };
      }
    }
  } catch { note('query', 'operation-failed'); /* Unknown delivery is never replayed into a new backend. */ }
  return { kind: 'unavailable' };
}
