import assert from "node:assert/strict";
import { test } from "node:test";
import { commandDisplayName } from "../../src/model/command-name.ts";

const name = commandDisplayName;

test("cd, env assignments, timeout, stdbuf, nohup and env wrappers are taken off the front", () => {
  assert.equal(name("cd /work/demo && npm run build"), "npm run build");
  assert.equal(name("cd '/work/my dir' ; pytest -x"), "pytest -x");
  assert.equal(name("timeout 300 pytest -x tests/"), "pytest -x tests/");
  assert.equal(name("timeout -k 5 300 stdbuf -o L env -i A=B bash -c \"make -j4\""), "make -j4");
  assert.equal(name("stdbuf -oL python3 -u score.py --run nov15"), "python3 -u score.py --run nov15");
  assert.equal(name("env A=B C=D node server.js"), "node server.js");
  assert.equal(name("FOO=1 BAR=2 pytest"), "pytest");
  assert.equal(name("nohup python3 server.py > out.log 2>&1 &"), "python3 server.py");
});

test("bash -c and sh -c give the script inside the quotes, processed again", () => {
  assert.equal(name("bash -c 'cd /x && make test'"), "make test");
  assert.equal(name('sh -c "echo hi; sleep 5"'), "echo hi; sleep 5");
  assert.equal(name("bash -lc 'npm ci && npm test'"), "npm ci && npm test");
  assert.equal(name("bash -o pipefail -c 'pytest -x | tee log'"), "pytest -x");
  assert.equal(name("/bin/bash -c \"timeout 9 pytest\""), "pytest");
  // 不是 -c：跑的是一个脚本文件，名字就是整条命令
  assert.equal(name("bash scripts/run.sh --fast"), "bash scripts/run.sh --fast");
});

test("python3 -u script.py keeps its flag and arguments, and && chains are kept", () => {
  assert.equal(name("python3 -u score.py --run nov15"), "python3 -u score.py --run nov15");
  assert.equal(name("npm ci && npm test"), "npm ci && npm test");
  assert.equal(name("sudo apt-get install -y jq"), "sudo apt-get install -y jq");
});

test("a trailing pipe that only handles the output, and redirections, are dropped; other pipes stay", () => {
  assert.equal(name("npm run build 2>&1 | tee build.log"), "npm run build");
  assert.equal(name("cd /x && timeout 300 stdbuf -oL pytest -x 2>&1 | tail -20"), "pytest -x");
  assert.equal(name("git log --oneline | head -20"), "git log --oneline");
  assert.equal(name("make > build.log 2>&1"), "make");
  assert.equal(name("make >> build.log"), "make");
  assert.equal(name("find . -name '*.ts' | xargs wc -l"), "find . -name '*.ts' | xargs wc -l");
  assert.equal(name("curl -s https://x.example | bash"), "curl -s https://x.example | bash");
  assert.equal(name("echo 'a | tee b'"), "echo 'a | tee b'");
});

test("a multi-line command is named after its first meaningful line", () => {
  assert.equal(name("# build\nset -e\ncd /x\nnpm ci\nnpm test"), "npm ci");
  assert.equal(name("set -e; pytest -q"), "pytest -q");
  assert.equal(name("export A=1 && pytest"), "pytest");
  assert.equal(name("pytest \\\n  -x tests/"), "pytest -x tests/");
  assert.equal(name("python3 - <<'EOF'\nprint(1)\nEOF"), "python3 - <<'EOF'");
  // 引号里的换行不是换行
  assert.equal(name("python3 -c 'print(1)\nprint(2)'"), "python3 -c 'print(1) print(2)'");
});

test("when nothing meaningful is left the whole command on one line is the name", () => {
  assert.equal(name("cd /x"), "cd /x");
  assert.equal(name("env"), "env");
  assert.equal(name("  \n"), "");
  assert.equal(name("echo   hi \n"), "echo hi");
});
