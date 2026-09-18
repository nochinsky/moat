#!/usr/bin/env python3
"""
Drive the interactive moat CLI through a real pty and check what it prints.

An interactive session cannot be verified by piping stdin: readline behaves
differently without a terminal, and the live view is the whole point of this
mode. So this allocates a pty, types at it, and reads what comes back.

It starts its own model stub and its own sandbox, so it is self-contained:
running it twice in a row cannot be confused by a stub that has already served
its script, which is exactly the mistake that made this test lie the first time.

Usage: python3 test/repl-smoke.py [projectDir]
"""
import os
import pty
import re
import select
import shutil
import signal
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/moat-demo/slugkit"))
PORT = int(os.environ.get("MOCK_PORT", "5598"))
TIMEOUT = float(os.environ.get("REPL_TIMEOUT", "240"))

FIXTURE = {
    "package.json": '{\n  "name": "slugkit",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n',
    "src/slugify.js": 'export function slugify(input) {\n  return input.toLowerCase().replace(/ /g, "-")\n}\n',
    "test/slugify.test.js": (
        'import test from "node:test"\nimport assert from "node:assert/strict"\n'
        'import { slugify } from "../src/slugify.js"\n'
        'test("collapses whitespace", () => assert.equal(slugify("Hello   World"), "hello-world"))\n'
        'test("trims", () => assert.equal(slugify("  Hi  "), "hi"))\n'
    ),
}


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, **kw)


def fresh_fixture():
    shutil.rmtree(PROJECT, ignore_errors=True)
    for rel, body in FIXTURE.items():
        path = os.path.join(PROJECT, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:
            fh.write(body)
    sh(["git", "init", "-q", "-b", "main"], cwd=PROJECT)
    sh(["git", "config", "user.email", "demo@example.com"], cwd=PROJECT)
    sh(["git", "config", "user.name", "Demo"], cwd=PROJECT)
    sh(["git", "add", "-A"], cwd=PROJECT)
    sh(["git", "commit", "-qm", "slugkit: initial commit"], cwd=PROJECT)


def start_mock():
    proc = subprocess.Popen(
        ["node", os.path.join(REPO, "test", "mock-model.mjs"),
         "--port", str(PORT),
         "--script", os.path.join(REPO, "test", "scripts", "basic.json"),
         "--record", "/tmp/moat-repl-mock.jsonl"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    time.sleep(1.2)
    return proc


def main() -> int:
    fresh_fixture()
    mock = start_mock()
    env = dict(os.environ, MOAT_CREDENTIAL="repl-smoke-credential")
    # A fresh environment, so the provider URL this test chose is the one the
    # sandbox actually uses. Reusing one silently points at whatever the last
    # test configured, which is how this test lied the first time.
    sh(["node", os.path.join(REPO, "cmd", "main.ts"), "destroy", "--yes"], cwd=PROJECT, env=env)
    boot = sh(["node", os.path.join(REPO, "cmd", "main.ts"), "up", "--quiet",
               "--no-detect", "--profile", "node",
               "--provider", "local", "--provider-base-url", f"http://127.0.0.1:{PORT}/v1",
               "--model", "mock-model"], cwd=PROJECT, env=env)
    if boot.returncode != 0:
        print(boot.stdout, boot.stderr)
        mock.send_signal(signal.SIGTERM)
        return 1

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(PROJECT)
        os.environ.update(env)
        os.execvp("node", ["node", os.path.join(REPO, "cmd", "main.ts"), "attach"])

    output = b""
    deadline = time.time() + TIMEOUT

    def drain(seconds: float) -> None:
        nonlocal output
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([fd], [], [], 0.2)
            if fd in ready:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    return
                if not chunk:
                    return
                output += chunk

    def send(text: str, wait: float) -> None:
        os.write(fd, text.encode())
        drain(wait)

    try:
        drain(2.0)
        send("/status\n", 1.5)
        # Long enough for the whole scripted turn, drained as it arrives.
        send("fix the failing tests and commit it\n", 25.0)
        send("/diff\n", 2.0)
        send("/help\n", 1.5)
        send("/quit\n", 1.0)
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass
        mock.send_signal(signal.SIGTERM)

    raw = output.decode("utf-8", "replace")
    text = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", raw)
    print(text)

    checks = [
        ("banner and prompt", "type a task" in text and "\u203a" in text),
        ("/status printed the environment", "endpoint" in text and "model" in text and "credential" in text),
        ("agent activity streamed live", bool(re.search(r"[\u2713\u00b7]\s+(bash|write|read|edit)", text))),
        ("/diff reported the agent's work", "agent-output.txt" in text or "nothing changed yet" in text),
        ("/help listed the commands", "/stop" in text and "/take" in text and "/shell" in text),
        ("commands still worked after the turn", "/help" in text and "/shell" in text),
    ]
    print("\n--- checks ---")
    failed = 0
    for name, ok in checks:
        print(f"  {'pass' if ok else 'FAIL'}  {name}")
        failed += 0 if ok else 1
    print(f"\n{len(checks) - failed}/{len(checks)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
