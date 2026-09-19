#!/usr/bin/env python3
"""
Agent text must not be able to drive the terminal it is printed on.

The answer, the reasoning, commit subjects, change paths and the sandbox log all
come from the box, and a terminal reads escape sequences in them: OSC 0 retitles
the window, OSC 52 writes the clipboard where the terminal allows it, CSI 2J clears
the screen, and a carriage return overwrites the row. Tool output was already
stripped; the model's own words were not, so a prompt injection (or a file full of
escape bytes the model echoes) could repaint the transcript the user is reading.

This drives the real pty against the stub, with an answer, a commit subject and a
file name each carrying a distinct sequence, and asserts that the sequences are
absent from the pty stream while their words are still on screen.

Usage: python3 test/repl-escapes.py [projectDir]
"""
import json
import os
import pty
import re
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/moat-demo/escapes"))
PORT = int(os.environ.get("MOCK_PORT", "5594"))

ESC = "\u001b"
BEL = "\u0007"
ANSWER_ATTACK = "pwned-answer" + BEL
SUBJECT_ATTACK = "pwned-subject" + BEL
FILE_ATTACK = "pwned-file" + BEL

FIXTURE = {
    "package.json": '{\n  "name": "escapes",\n  "type": "module"\n}\n',
    "src/thing.js": 'export function thing() {\n  return "thing"\n}\n',
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
    sh(["git", "commit", "-qm", "escapes: initial commit"], cwd=PROJECT)


def write_script() -> str:
    """The stub's steps, with the escape bytes written by json.dump, not by hand."""
    command = (
        "printf 'agent file\\n' > escaped.txt && "
        "printf x > $'esc-file-\\033]0;" + FILE_ATTACK + "\\007.txt' && "
        "git add escaped.txt && "
        "git -c user.email=agent@moat.invalid -c user.name=agent commit -qm "
        "$'agent: subject \\033]0;" + SUBJECT_ATTACK + "\\007 here' && "
        "git rev-parse --short HEAD"
    )
    script = [
        {"tool": "bash", "args": {"command": command}},
        {"text": "before " + ESC + "]0;" + ANSWER_ATTACK + " mid " + ESC + "[2J after"},
    ]
    path = os.path.join(tempfile.gettempdir(), "moat-escapes-script.json")
    with open(path, "w") as fh:
        json.dump(script, fh)
    return path


def start_mock(script_path):
    proc = subprocess.Popen(
        ["node", os.path.join(REPO, "test", "mock-model.mjs"),
         "--port", str(PORT),
         "--script", script_path,
         "--record", "/tmp/moat-escapes-mock.jsonl"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    time.sleep(1.2)
    return proc


def main() -> int:
    fresh_fixture()
    mock = start_mock(write_script())
    env = dict(os.environ, MOAT_CREDENTIAL="escapes-credential")
    sh(["node", os.path.join(REPO, "cmd", "main.ts"), "destroy", "--yes"], cwd=PROJECT, env=env)
    boot = sh(["node", os.path.join(REPO, "cmd", "main.ts"), "up", "--quiet",
               "--no-detect", "--profile", "node",
               "--base-url", "http://127.0.0.1:%d/v1" % PORT, "--model", "mock-model"], cwd=PROJECT, env=env)
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
        try:
            os.write(fd, text.encode())
        except OSError:
            return
        drain(wait)

    try:
        drain(3.0)
        send("write a file and commit it\n", 25.0)
        send("/take\n", 4.0)
        send("/diff\n", 4.0)
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
        sh(["node", os.path.join(REPO, "cmd", "main.ts"), "down"], cwd=PROJECT, env=env)
        sh(["node", os.path.join(REPO, "cmd", "main.ts"), "destroy", "--yes"], cwd=PROJECT, env=env)

    raw = output.decode("utf-8", "replace")
    # Readability only: this strips CSI colour codes, and deliberately leaves OSC
    # sequences in place, so the checks below are the thing that finds them.
    text = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", raw)
    print(text)

    checks = [
        ("the session started and the turn ran", "\u203a" in text and "agent: subject" in text),
        ("the answer was displayed", "before" in text and "mid" in text and "after" in text),
        ("the answer's window-title sequence never reached the terminal", ESC + "]0;" + ANSWER_ATTACK not in raw),
        ("the answer's erase-display sequence never reached the terminal", ESC + "[2J" not in raw),
        ("a commit subject from the sandbox is stripped", ESC + "]0;" + SUBJECT_ATTACK not in raw),
        ("a changed file name from the sandbox is stripped", ESC + "]0;" + FILE_ATTACK not in raw),
        ("the file name's own text still shows", "esc-file-" in text),
    ]
    print("\n--- checks ---")
    failed = 0
    for name, ok in checks:
        print("  %s  %s" % ("pass" if ok else "FAIL", name))
        failed += 0 if ok else 1
    print("\n%d/%d checks passed" % (len(checks) - failed, len(checks)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
