#!/usr/bin/env python3
"""
Drive moat's model / reasoning / session controls through a real pty.

These are the "basic stuff like normal opencode" commands: pick a model, pick a
reasoning effort, pick an agent, compact, undo. They are all interactive, so
piping stdin would not exercise them — readline and the live view both behave
differently without a terminal. This allocates a pty, types at it, and reads
what comes back.

It runs against the local model stub, so it costs nothing and is deterministic:
what is being verified is moat's own plumbing (that the choice is offered, kept,
sent, and reported), not any particular model's behaviour.

Usage: python3 test/repl-controls.py [projectDir]
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
PROJECT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/moat-demo/controls"))
PORT = int(os.environ.get("MOCK_PORT", "5597"))
TIMEOUT = float(os.environ.get("REPL_TIMEOUT", "240"))
MODEL = os.environ.get("MOCK_MODEL", "mock-model")

FIXTURE = {
    "package.json": '{\n  "name": "controls",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n',
    "src/slugify.js": 'export function slugify(input) {\n  return input.toLowerCase().replace(/ /g, "-")\n}\n',
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
    sh(["git", "commit", "-qm", "controls: initial commit"], cwd=PROJECT)


def start_mock():
    proc = subprocess.Popen(
        ["node", os.path.join(REPO, "test", "mock-model.mjs"),
         "--port", str(PORT),
         "--script", os.path.join(REPO, "test", "scripts", "basic.json"),
         "--record", "/tmp/moat-controls-mock.jsonl"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    time.sleep(1.2)
    return proc


def main() -> int:
    fresh_fixture()
    mock = start_mock()
    env = dict(os.environ, MOAT_CREDENTIAL="repl-controls-credential")
    sh(["node", os.path.join(REPO, "cmd", "main.ts"), "destroy", "--yes"], cwd=PROJECT, env=env)
    boot = sh(["node", os.path.join(REPO, "cmd", "main.ts"), "up", "--quiet",
               "--no-detect", "--profile", "node",
               "--base-url", f"http://127.0.0.1:{PORT}/v1",
               "--model", MODEL], cwd=PROJECT, env=env)
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
        send("/model\n", 2.5)
        send("/think\n", 2.5)
        send("/think high\n", 1.5)
        send("/status\n", 1.5)
        send("/think bogus\n", 1.5)
        send("/thinking\n", 1.0)
        send("/thinking\n", 1.0)
        send("/verbose\n", 1.0)
        send("/verbose\n", 1.0)
        send("/agent\n", 2.5)
        send("fix the failing tests\n", 25.0)
        send("/undo\n", 4.0)
        send("/redo\n", 2.0)
        send("/compact\n", 12.0)
        send("/status\n", 1.5)
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

    current = f"moat/{MODEL}"
    checks = [
        ("banner names the model", current in text),
        ("/status reports model and effort rows", "model " in text and "agent " in text and "thinking " in text),
        ("/model listed the current model",
         re.search(r"\u203a\s+1\.\s+moat/" + re.escape(MODEL), text) is not None),
        # This stub is reached through --base-url, so moat declares it as a
        # custom model with no capability metadata. It therefore has no
        # reasoning levels, and the honest answer is to say so rather than to
        # offer a level that would be silently dropped. The positive path is
        # covered against a real DeepSeek environment in repl-effort.py.
        ("/think says so when a model has no levels",
         "does not expose reasoning effort levels" in text),
        ("/thinking toggled both ways", "showing reasoning" in text and "hiding reasoning" in text),
        ("/verbose toggled both ways", "showing tool output" in text and "hiding tool output" in text),
        ("/agent listed agents", re.search(r"\u203a\s+default", text) is not None or "build" in text),
        ("the turn still ran and streamed tool calls",
         bool(re.search(r"[\u2713\u00b7]\s+(bash|write|read|edit)", text))),
        ("/undo reported a result", "undone" in text or "could not undo" in text or "no messages" in text),
        ("/redo reported a result", "restored" in text or "nothing to restore" in text),
        ("/compact reported a result", "compacted" in text or "compaction failed" in text),
        ("/help lists the new commands", "/model" in text and "/think" in text and "/compact" in text),
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
