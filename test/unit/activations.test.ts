import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { ActivationLog, causesOf, chainKeyOf, parseActivations, startedBy } from '../../src/activations';

// 2026-10-19 이 Mac의 실제 로그(extension-loadout 창). Ruff가 README.md 때문에 켜져 Python·Pylance까지 켰다.
const LOG = [
  '2026-10-19 17:38:40.132 [info] Extension host with pid 56782 started',
  "2026-10-19 17:38:40.171 [info] ExtensionService#_doActivateExtension vscode.github-authentication, startup: false, activationEvent: 'onAuthenticationRequest:github'",
  "2026-10-19 17:38:41.002 [info] ExtensionService#_doActivateExtension charliermarsh.ruff, startup: true, activationEvent: 'workspaceContains:*.py,*.ipynb,*.md,**/pyproject.toml,**/ruff.toml,**/.ruff.toml'",
  "2026-10-19 17:38:41.310 [info] ExtensionService#_doActivateExtension ms-python.vscode-python-envs, startup: false, activationEvent: 'api', root cause: charliermarsh.ruff",
  "2026-10-19 17:38:41.402 [info] ExtensionService#_doActivateExtension ms-python.python, startup: false, activationEvent: 'api', root cause: ms-python.vscode-python-envs",
  "2026-10-19 17:38:42.118 [info] ExtensionService#_doActivateExtension ms-python.vscode-pylance, startup: false, activationEvent: 'api', root cause: ms-python.python",
  "2026-10-19 17:38:42.500 [info] ExtensionService#_doActivateExtension ms-python.python, startup: false, activationEvent: 'onLanguage:python'",
  '',
].join('\n');

test('parseActivations reads activation events and immediate causes from the extension host log', () => {
  const acts = parseActivations(LOG, 56782);
  assert.deepEqual(acts.get('charliermarsh.ruff'), { id: 'charliermarsh.ruff', startup: true, event: 'workspaceContains:*.py,*.ipynb,*.md,**/pyproject.toml,**/ruff.toml,**/.ruff.toml', cause: undefined });
  assert.deepEqual(acts.get('ms-python.vscode-pylance'), { id: 'ms-python.vscode-pylance', startup: false, event: 'api', cause: 'ms-python.python' });
  // 처음 켜진 이유만 남긴다(뒤의 onLanguage:python은 무시).
  assert.equal(acts.get('ms-python.python')?.cause, 'ms-python.vscode-python-envs');
  // 다른 확장 호스트(pid)의 기록은 읽지 않는다.
  assert.equal(parseActivations(LOG, 1234).size, 0);
});

test('a restarted extension host appends a new block to the same log; only that pid’s block counts', () => {
  const restarted = LOG + "2026-10-19 18:00:00.000 [info] Extension host with pid 56782 exiting with code 0\n2026-10-19 18:00:00.100 [info] Extension host with pid 61000 started\n2026-10-19 18:00:00.200 [info] ExtensionService#_doActivateExtension charliermarsh.ruff, startup: false, activationEvent: 'onLanguage:markdown'\n";
  const acts = parseActivations(restarted, 61000);
  assert.deepEqual([...acts.keys()], ['charliermarsh.ruff']);
  assert.equal(acts.get('charliermarsh.ruff')?.event, 'onLanguage:markdown');
});

test('causesOf follows the chain to the first cause; startedBy lists what each extension started', () => {
  const acts = parseActivations(LOG, 56782);
  assert.deepEqual(causesOf(acts, 'ms-python.vscode-pylance'), ['ms-python.python', 'ms-python.vscode-python-envs', 'charliermarsh.ruff']);
  assert.deepEqual(causesOf(acts, 'charliermarsh.ruff'), []);
  const chains = startedBy(acts);
  assert.deepEqual(chains.get('charliermarsh.ruff'), ['ms-python.vscode-python-envs', 'ms-python.python', 'ms-python.vscode-pylance']);
  assert.deepEqual(chains.get('ms-python.python'), ['ms-python.vscode-pylance']);
  assert.equal(chains.has('vscode.github-authentication'), false);
  // 고리가 있어도 멈춘다.
  const loop = parseActivations("Extension host with pid 1 started\n_doActivateExtension a.a, startup: false, activationEvent: 'api', root cause: b.b\n_doActivateExtension b.b, startup: false, activationEvent: 'api', root cause: a.a\n", 1);
  assert.deepEqual(causesOf(loop, 'a.a'), ['b.b']);
  assert.equal(chainKeyOf(chains), chainKeyOf(startedBy(parseActivations(LOG, 56782))));
});

test('ActivationLog reads only what was appended, keeps a partial last line and a split multi-byte character', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'el-act-'));
  const file = path.join(dir, 'exthost.log');
  const lines = LOG.split('\n');
  const korean = Buffer.from("2026-10-19 17:38:43.000 [info] ExtensionService#_doActivateExtension loadouttest.korean, startup: false, activationEvent: 'onCommand:확장.열기'\n");
  const cut = korean.indexOf(Buffer.from('확')) + 1; // '확'(3바이트)의 첫 바이트 뒤에서 자른다
  fs.writeFileSync(file, Buffer.concat([Buffer.from(lines.slice(0, 4).join('\n') + '\n'), korean.subarray(0, cut)]));
  const log = new ActivationLog(file, 56782);
  let acts = await log.read();
  assert.deepEqual([...acts.keys()], ['vscode.github-authentication', 'charliermarsh.ruff', 'ms-python.vscode-python-envs']);
  // 나머지가 붙는다. 동시에 읽어도 새로 붙은 부분을 한 번만 읽는다.
  fs.appendFileSync(file, Buffer.concat([korean.subarray(cut), Buffer.from(lines.slice(4).join('\n'))]));
  const [a, b] = await Promise.all([log.read(), log.read()]);
  acts = a;
  assert.equal(a, b);
  assert.equal(acts.get('loadouttest.korean')?.event, 'onCommand:확장.열기');
  assert.equal(acts.get('ms-python.python')?.cause, 'ms-python.vscode-python-envs');
  assert.equal(acts.get('ms-python.vscode-pylance')?.cause, 'ms-python.python');
  // 파일이 없으면 빈 기록.
  assert.equal((await new ActivationLog(path.join(dir, 'none.log'), 1).read()).size, 0);
  assert.equal((await new ActivationLog(undefined, 1).read()).size, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
