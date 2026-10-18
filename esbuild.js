const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    // restartHelper는 VS Code가 종료된 뒤에도 살아 있어야 하므로 별도 파일로 내보낸다.
    entryPoints: { extension: 'src/extension.ts', restartHelper: 'src/restartHelper.ts' },
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    // jsonc-parser의 UMD 빌드는 내부 모듈을 동적으로 require해서 번들에 들어가지 않는다. ESM 빌드를 쓴다.
    mainFields: ['module', 'main'],
    target: 'node20',
    outdir: 'dist',
    external: ['vscode'],
    logLevel: 'info',
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
