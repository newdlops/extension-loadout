// 메모리 측정 시험용: 확장 폴더 안의 스크립트로 80MB를 쥔 자식 프로세스를 띄운다(언어 서버 흉내).
const { spawn } = require('child_process');
const path = require('path');
exports.activate = () => {
  spawn(process.execPath, [path.join(__dirname, 'hog.js'), String(process.pid)], {
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
};
