#!/bin/zsh
# 격리된 VS Code 인스턴스로 "실행 중 워크스페이스 state.vscdb 수정 → reload" 반영 여부를 시험한다.
P=${0:A:h:h:h}; G=$P/.vscode-test/gate; CODE="/Applications/Visual Studio Code.app/Contents/MacOS/Code"
dbval(){ local f=$(grep -l "$G/ws" $G/ud/User/workspaceStorage/*/workspace.json 2>/dev/null | head -1); [ -n "$f" ] && sqlite3 "${f:h}/state.vscdb" "select value from ItemTable where key='extensionsIdentifiers/disabled'"; }
launch(){
  "$CODE" --user-data-dir $G/ud --extensions-dir $G/exts --extensionDevelopmentPath=$P/experiments/gate/gate \
    --skip-welcome --skip-release-notes --disable-workspace-trust $G/ws > $G/run-$1.out 2>&1 &
  local pid=$!; for i in {1..90}; do kill -0 $pid 2>/dev/null || break; sleep 1; done
  kill -0 $pid 2>/dev/null && { echo "run$1: 90초 내 종료 안 됨, 강제 종료"; kill $pid; }
  echo "run$1 끝: phase=$(cat $G/phase 2>/dev/null) db=$(dbval)"
}
rm -f $G/log.jsonl $G/phase
launch 1
[ "$(cat $G/phase 2>/dev/null)" = after-relaunch ] && launch 2
