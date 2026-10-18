// README 스크린샷을 만든다(macOS 전용 개발 도구). 격리된 VS Code(.vscode-test/shots)에서 예제 프로젝트를 열고
// 사이드바 패널과 대시보드를 캡처해 media/screenshots/에 저장한다. 확장은 먼저 .vscode-test/shots/exts에 설치해 둔다.
//   node scripts/screenshots.mjs
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const locale = process.argv.includes('--ko') ? 'ko' : 'en';
// 언어마다 따로 둔다. 한국어 환경은 언어 팩을 계속 설치해 두어야 첫 실행부터 한국어로 뜬다.
const DIR = path.join(ROOT, '.vscode-test', locale === 'ko' ? 'shots-ko' : 'shots');
const CODE = process.env.VSCODE_EXECUTABLE ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const ud = path.join(DIR, 'ud');
const exts = path.join(DIR, 'exts');
const ws = path.join(DIR, 'acme-shop');
const OUT = path.join(ROOT, 'media', 'screenshots');
const suffix = locale === 'ko' ? '-ko' : '';

for (const f of ['sidebar-ready', 'sidebar-done', 'dashboard-ready', 'dashboard-done']) fs.rmSync(path.join(DIR, f), { force: true });
fs.rmSync(path.join(ud, 'User', 'workspaceStorage'), { recursive: true, force: true });
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  fs.writeFileSync(path.join(ws, rel), text);
};
write('package.json', JSON.stringify({ name: 'acme-shop', private: true, workspaces: ['web'] }, null, 2));
write('requirements.txt', 'django==5.1\n');
write('manage.py', '#!/usr/bin/env python\nimport sys\n');
write('app/views.py', 'from django.http import JsonResponse\n\n\ndef health(request):\n    return JsonResponse({"ok": True})\n');
write('web/package.json', JSON.stringify({ name: 'web', private: true, dependencies: { react: '^19.0.0' } }, null, 2));
write('web/tsconfig.json', JSON.stringify({ compilerOptions: { jsx: 'react-jsx', strict: true } }, null, 2));
write('web/src/App.tsx', 'export function App() {\n  return <main>Acme Shop</main>;\n}\n');
write('.github/workflows/ci.yml', 'on: push\njobs: {}\n');
write(
  '.vscode/extensions.json',
  JSON.stringify({ recommendations: ['ms-python.python', 'esbenp.prettier-vscode', 'charliermarsh.ruff'], unwantedRecommendations: ['streetsidesoftware.code-spell-checker'] }, null, 2),
);
write(
  '.vscode/extension-loadout.json',
  JSON.stringify(
    {
      enable: ['yzhang.markdown-all-in-one'],
      disable: ['vscjava.vscode-gradle'],
      notes: { 'vscjava.vscode-gradle': 'node_modules ships Android build files; we never build them here' },
    },
    null,
    2,
  ),
);

// 화면을 가리는 안내를 끈다.
fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
fs.writeFileSync(
  path.join(ud, 'User', 'settings.json'),
  JSON.stringify({ 'git.openRepositoryInParentFolders': 'never', 'workbench.startupEditor': 'none', 'chat.disableAIFeatures': true, 'workbench.tips.enabled': false }, null, 2),
);
// 전역 설정: Markdown 확장은 전역에서 꺼 두고, "비슷한 폴더에서 Error Lens를 껐다"는 기록을 넣는다.
fs.mkdirSync(path.join(ud, 'User', 'globalStorage'), { recursive: true });
const db = new DatabaseSync(path.join(ud, 'User', 'globalStorage', 'state.vscdb'));
db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
db.prepare('INSERT OR REPLACE INTO ItemTable VALUES (?, ?)').run('extensionsIdentifiers/disabled', JSON.stringify([{ id: 'yzhang.markdown-all-in-one' }]));
const learned = [{ folder: '/work/acme-admin', name: 'acme-admin', signature: ['manage.py', 'package.json', 'requirements.txt'], off: ['usernamehw.errorlens'], on: [], time: Date.now() }];
db.prepare('INSERT OR REPLACE INTO ItemTable VALUES (?, ?)').run('newdlops.extension-loadout', JSON.stringify({ 'extensionLoadout.learned': learned }));
db.close();

// 한국어 환경: 영어 환경의 확장을 복사하고 한국어 언어 팩을 더한 뒤, 번역 캐시가 만들어지도록 한 번 미리 띄운다.
const cli = path.join(path.dirname(CODE), '..', 'Resources', 'app', 'bin', 'code');
const pack = 'ms-ceintl.vscode-language-pack-ko';
if (locale === 'ko' && !fs.existsSync(path.join(exts, 'extensions.json'))) {
  fs.cpSync(path.join(ROOT, '.vscode-test', 'shots', 'exts'), exts, { recursive: true });
}
if (locale === 'ko' && !fs.readdirSync(exts).some((d) => d.startsWith(`${pack}-`))) {
  execFileSync(cli, ['--user-data-dir', ud, '--extensions-dir', exts, '--install-extension', pack], { stdio: 'ignore' });
  // 번역 캐시(clp)는 폴더 창을 처음 열 때 만들어진다.
  const warm = spawn(CODE, ['--locale', 'ko', '--user-data-dir', ud, '--extensions-dir', exts, '--skip-welcome', '--disable-workspace-trust', ws], { stdio: 'ignore' });
  for (let i = 0; i < 60 && !fs.existsSync(path.join(ud, 'clp')); i++) await new Promise((r) => setTimeout(r, 1000));
  await new Promise((r) => setTimeout(r, 5000));
  warm.kill();
  await new Promise((r) => setTimeout(r, 3000));
}

execFileSync(process.execPath, [path.join(ROOT, 'esbuild.js')], { cwd: ROOT, stdio: 'ignore' });
const args = [
  '--locale', locale,
  '--user-data-dir', ud,
  '--extensions-dir', exts,
  `--extensionDevelopmentPath=${ROOT}`,
  `--extensionDevelopmentPath=${path.join(ROOT, 'scripts', 'shots-driver')}`,
  '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
  ws,
  // 다른 창에 가려져도 그리게 해서 화면을 빼앗지 않고 캡처한다.
  // VS Code의 인자 해석기는 모르는 옵션 뒤의 인자를 그 값으로 가져가므로 폴더 경로 뒤에 둔다.
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
];
const child = spawn(CODE, args, { env: { ...process.env, EXTENSION_LOADOUT_SHOTS_DIR: DIR }, stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (name, ms = 180_000) => {
  const until = Date.now() + ms;
  while (!fs.existsSync(path.join(DIR, name))) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${name}`);
    await sleep(500);
  }
};
const windowId = () => {
  const swift = `import CoreGraphics
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
for w in list where (w[kCGWindowOwnerPID as String] as? Int32) == ${child.pid} && (w[kCGWindowLayer as String] as? Int) == 0 {
  let b = w[kCGWindowBounds as String] as! [String: Any]
  if (b["Width"] as? Double ?? 0) > 800 && (b["Height"] as? Double ?? 0) > 500 { print(w[kCGWindowNumber as String]!) }
}`;
  return execFileSync('swift', ['-'], { input: swift }).toString().trim().split('\n')[0];
};
const shoot = (name, crop) => {
  const file = path.join(OUT, `${name}${suffix}.png`);
  execFileSync('screencapture', ['-x', '-o', '-l', windowId(), file]);
  if (crop) {
    // 창의 왼쪽(액티비티 바와 사이드바)만 남긴다. sips의 crop은 가운데 기준이라 CoreGraphics로 자른다.
    const swift = `import Foundation
import ImageIO
import UniformTypeIdentifiers
let url = URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL
let src = CGImageSourceCreateWithURL(url, nil)!
let img = CGImageSourceCreateImageAtIndex(src, 0, nil)!
let w = Int(Double(img.width) * Double(CommandLine.arguments[2])!)
let out = img.cropping(to: CGRect(x: 0, y: 0, width: w, height: img.height))!
let dst = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dst, out, nil)
CGImageDestinationFinalize(dst)`;
    const script = path.join(DIR, 'crop.swift');
    fs.writeFileSync(script, swift);
    execFileSync('swift', [script, file, String(crop)], { stdio: 'ignore' });
  }
  return file;
};

fs.mkdirSync(OUT, { recursive: true });
await waitFor('sidebar-ready');
console.log(shoot('sidebar', 0.42));
fs.writeFileSync(path.join(DIR, 'sidebar-done'), '1');
await waitFor('dashboard-ready');
console.log(shoot('dashboard'));
fs.writeFileSync(path.join(DIR, 'dashboard-done'), '1');
await new Promise((r) => child.on('exit', r));
