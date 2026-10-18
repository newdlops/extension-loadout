// 소스의 vscode.l10n.t(…) 문장(t('…'))을 모두 뽑는다. 번역 파일과 맞는지 확인할 때 쓴다.
//   node scripts/l10n-strings.mjs          → 문장 목록(JSON)
//   node scripts/l10n-strings.mjs --check  → l10n/bundle.l10n.*.json과 비교, 빠지거나 남는 문장이 있으면 실패
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function extract(source) {
  const out = new Set();
  // t('…') 또는 t("…") — 이스케이프된 따옴표를 처리한다. 앞 글자가 식별자면(예: set(…)) 건너뛴다.
  const re = /(?<![\w$.])t\(\s*(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g;
  for (const m of source.matchAll(re)) out.add(JSON.parse(m[1] === '"' ? `"${m[2]}"` : `"${m[2].replace(/\\'/g, "'").replace(/"/g, '\\"')}"`));
  return out;
}

export function allStrings() {
  const out = new Set();
  const dir = path.join(ROOT, 'src');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    // t가 vscode.l10n.t인 파일만 본다.
    if (!/const t = vscode\.l10n\.t;/.test(text)) continue;
    for (const s of extract(text)) out.add(s);
  }
  return [...out].sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const strings = allStrings();
  if (!process.argv.includes('--check')) {
    console.log(JSON.stringify(strings, null, 2));
  } else {
    let bad = false;
    for (const f of fs.readdirSync(path.join(ROOT, 'l10n')).filter((x) => /^bundle\.l10n\..+\.json$/.test(x))) {
      const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', f), 'utf8')));
      const missing = strings.filter((s) => !keys.includes(s));
      const extra = keys.filter((k) => !strings.includes(k));
      if (missing.length || extra.length) {
        bad = true;
        console.log(`${f}: ${missing.length} missing, ${extra.length} extra`);
        for (const s of missing) console.log(`  + ${JSON.stringify(s)}`);
        for (const s of extra) console.log(`  - ${JSON.stringify(s)}`);
      } else console.log(`${f}: ${keys.length} strings, complete`);
    }
    process.exit(bad ? 1 : 0);
  }
}
