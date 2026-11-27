import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { spawnLoadedSourceWorker, SOURCE_WORKER_LOAD_TIMEOUT_MS } from './helpers/source-worker-boot.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { killWorkerTmuxSession } from './helpers/worker-tmux-session.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import { readJsonLines } from './helpers/read-json-lines.js';
import type { WorkerToDaemon } from '../src/types.js';

const tmuxAvailable = probeTmuxFunctional().ok;
// Module loading and CLI/tmux initialization have separate startup budgets.
// Neither consumes the native-wake follow-up's six-second delivery bound.
const CLI_BOOTSTRAP_TIMEOUT_MS = SOURCE_WORKER_LOAD_TIMEOUT_MS;

for (const backendType of ['pty', 'tmux'] as const) {
  it.skipIf(backendType === 'tmux' && !tmuxAvailable)(
    `TraeX ${backendType}: a native child-agent wake admits ordinary type-ahead and attributes its reply`,
    async () => {
      const root = mkdtempSync('/tmp/bmx-traex-native-wake-');
      const sessionId = randomUUID();
      const nativeId = randomUUID();
      const dataDir = join(root, 'data');
      const traeHome = join(root, '.trae');
      const rolloutDir = join(traeHome, 'cli', 'sessions', '2026', '11', '28');
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(rolloutDir, { recursive: true });
      const rollout = join(rolloutDir, `rollout-2026-11-28T00-00-00-${nativeId}.jsonl`);
      const history = join(traeHome, 'cli', 'history.jsonl');
      const submissions = join(root, 'submissions.jsonl');
      const wake = join(root, 'wake');
      const started = join(root, 'native-started');
      const release = join(root, 'release');
      const nativeDone = join(root, 'native-done');
      const pidFile = join(root, 'cli-pid');
      const fakeCli = join(root, 'fake-traex');
      writeFileSync(history, '');
      writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'app-server') {
  let pending = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\\n')) >= 0) {
      const req = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
      if (req.id !== undefined) process.stdout.write(JSON.stringify({ id: req.id, result:
        req.method === 'model/list' ? { data: [{ id: 'core' }, { id: 'backup' }], nextCursor: null } : {}
      }) + '\\n');
    }
  });
} else if (process.argv[2] === 'debug') {
  process.stdout.write(JSON.stringify({ models: [] }));
} else {
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  const fd = fs.openSync(${JSON.stringify(rollout)}, 'a');
  const event = payload => fs.writeSync(fd, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload }) + '\\n');
  const report = state => '\\x1b]7501;state=' + state + ':app=traecli\\x1b\\\\';
  const composer = () => process.stdout.write('\\x1b[2J\\x1b[H│ model: core /model to change │\\n❯ Use /skills to list available skills\\n  core · Context 99% left\\n');
  const working = () => process.stdout.write(report('working') + '\\x1b[2J\\x1b[H◆ Working… (1s • esc to interrupt)\\n');
  const finish = (turn, text) => {
    fs.writeSync(fd, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] } }) + '\\n');
    event({ type: 'task_complete', turn_id: turn, last_agent_message: text });
    process.stdout.write(report('done')); composer();
  };
  fs.writeSync(fd, JSON.stringify({ type: 'session_meta', payload: { id: ${JSON.stringify(nativeId)}, cwd: process.cwd() } }) + '\\n');
  process.stdin.setRawMode?.(true); process.stdin.setEncoding('utf8');
  process.stdout.write('\\x1b[?2004h'); composer();
  for (const delay of [200, 500, 1000]) setTimeout(composer, delay);
  let input = '', count = 0, nativeStarted = false, complete = false;
  process.stdin.on('data', chunk => {
    input += chunk;
    let match;
    while ((match = /\\x1b\\[200~([\\s\\S]*?)\\x1b\\[201~[^\\x1b]*\\r/.exec(input))) {
      input = input.slice(match.index + match[0].length);
      const text = match[1]; count++;
      fs.appendFileSync(${JSON.stringify(submissions)}, JSON.stringify({ text, nativeStarted, complete }) + '\\n');
      fs.appendFileSync(${JSON.stringify(history)}, JSON.stringify({ session_id: ${JSON.stringify(nativeId)}, text, ts: Date.now()/1000 }) + '\\n');
      event({ type: 'user_message', message: text, images: [], local_images: [], turn_id: count === 1 ? 'native-first' : 'native-wake' });
      if (count === 1) {
        event({ type: 'task_started', turn_id: 'native-first' }); working();
        setTimeout(() => finish('native-first', 'first completed'), 500);
      }
    }
  });
  setInterval(() => {
    if (!nativeStarted && fs.existsSync(${JSON.stringify(wake)})) {
      nativeStarted = true;
      event({ type: 'task_started', turn_id: 'native-wake', root_turn_id: 'native-first' });
      event({ type: 'agent_message', message: 'child result' });
      working(); fs.writeFileSync(${JSON.stringify(started)}, '1');
    }
    if (nativeStarted && !complete && fs.existsSync(${JSON.stringify(release)})) {
      complete = true; finish('native-wake', 'native reply with follow-up');
      fs.writeFileSync(${JSON.stringify(nativeDone)}, '1');
    }
  }, 30);
}
`);
      chmodSync(fakeCli, 0o755);
      const messages: WorkerToDaemon[] = [];
      const logs: string[] = [];
      const env = privateTmuxEnv(root, {
        HOME: root, TRAE_HOME: traeHome, SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: sessionId, CLI_EXTRA_ARGS: '', LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test',
      });
      const source = spawnLoadedSourceWorker({ cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      const child = source.child;
      child.on('message', message => messages.push(message as WorkerToDaemon));
      child.stdout?.on('data', chunk => logs.push(chunk.toString()));
      child.stderr?.on('data', chunk => logs.push(chunk.toString()));
      const wait = async (predicate: () => boolean, label: string, ms = 15_000) => {
        const deadline = Date.now() + ms;
        while (!predicate()) {
          if (Date.now() >= deadline || child.exitCode !== null) throw new Error(`${label}\n${logs.join('')}`);
          await new Promise(r => setTimeout(r, 25));
        }
      };
      try {
        await source.loaded;
        child.send({ type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_first',
          workingDir: dataDir, cliId: 'traex', cliPathOverride: fakeCli, backendType,
          cliVersion: '0.217.0', model: 'core', prompt: 'first-input', turnId: 'om_first',
          larkAppId: 'app_test', larkAppSecret: 'test',
          traexAutoModel: { enabled: true, trigger: 'capacity', models: ['core', 'backup'],
            queueTimeoutMs: 5_000, reselectPerTurn: false, preflightLoadCheck: false },
        });
        await wait(() => {
          const terminal = messages.findIndex(m => m.type === 'turn_terminal' && m.turnId === 'om_first');
          return terminal >= 0 && messages.findLastIndex(m => m.type === 'prompt_ready') > terminal;
        }, 'bootstrap first terminal and composer ready', CLI_BOOTSTRAP_TIMEOUT_MS);
        const beforeWake = messages.length;
        writeFileSync(wake, '1');
        await wait(() => existsSync(started) && messages.slice(beforeWake).some(m => m.type === 'screen_update' && m.status === 'working'), 'native working observed');
        child.send({ type: 'message', content: 'ordinary-follow-up', turnId: 'om_followup' });
        await wait(() => readJsonLines<{ text: string }>(submissions).some(r => r.text.includes('ordinary-follow-up')), 'follow-up submitted before native completion', 6_000);
        expect(existsSync(nativeDone)).toBe(false);
        const received = readJsonLines<{ text: string; nativeStarted: boolean; complete: boolean }>(submissions).filter(r => r.text.includes('ordinary-follow-up'));
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({ nativeStarted: true, complete: false });
        writeFileSync(release, '1');
        await wait(() => messages.some(m => m.type === 'turn_terminal' && m.turnId === 'om_followup' && m.status === 'completed'), 'follow-up terminal attribution');
        expect(messages.filter(m => m.type === 'turn_input_rejected')).toEqual([]);
        expect(messages.filter(m => m.type === 'turn_terminal' && m.turnId === 'om_followup')).toHaveLength(1);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>(r => child.once('exit', () => r()));
          child.kill('SIGKILL');
          await Promise.race([exited, new Promise(r => setTimeout(r, 2000))]);
        }
        if (backendType === 'tmux') killWorkerTmuxSession(`=bmx-${sessionId.slice(0, 8)}`, env);
        if (existsSync(pidFile)) {
          try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* fixture already stopped */ }
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
    SOURCE_WORKER_LOAD_TIMEOUT_MS + CLI_BOOTSTRAP_TIMEOUT_MS + 50_000,
  );
}
