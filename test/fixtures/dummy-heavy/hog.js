// 80MB를 실제로 써서(0이 아닌 값) 쥐고 있다가, 확장 호스트가 끝나면 같이 끝난다.
const hold = Buffer.alloc(80 * 1024 * 1024, 7);
const parent = Number(process.argv[2]);
setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch {
    process.exit(0);
  }
  hold[0] = (hold[0] + 1) % 256;
}, 1000);
