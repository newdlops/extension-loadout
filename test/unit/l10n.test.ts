import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

// out/test/unit에서 실행되므로 저장소 루트는 세 단계 위다.
const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')) as Record<string, string>;
const placeholders = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort().join(',');

test('every vscode.l10n.t string has a Korean translation with the same placeholders, and nothing extra', async () => {
  // Windows에서는 절대 경로가 아니라 file:// URL로 불러와야 한다.
  const { allStrings } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'l10n-strings.mjs')).href);
  const strings: string[] = allStrings();
  const ko = read('l10n/bundle.l10n.ko.json');
  assert.deepEqual(strings.filter((s) => !(s in ko)), [], 'missing translations');
  assert.deepEqual(Object.keys(ko).filter((k) => !strings.includes(k)), [], 'unused translations');
  for (const [en, kr] of Object.entries(ko)) assert.equal(placeholders(kr), placeholders(en), `placeholders differ: ${en}`);
});

test('package.json %keys% exist in both package.nls.json and package.nls.ko.json', () => {
  const pkg = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  const used = [...pkg.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]);
  const en = read('package.nls.json');
  const ko = read('package.nls.ko.json');
  assert.deepEqual(used.filter((k) => !(k in en)), []);
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ko).sort());
});
