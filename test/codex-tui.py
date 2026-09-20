#!/usr/bin/env python3
"""
Drive `moat` into the default runtime's TUI through a real pty.

Codex is the default runtime now, and its interactive surface is Codex's own TUI, attached
to a pty inside the box. `moat shell` proved the pty plumbing long ago; what was never
tested is that `moat` *reaches* the TUI with this runtime instead of printing help or dying
with an error. That needs no model call, so this runs keyless (a dummy credential is set so
Codex has its env var, and nothing is ever sent to a provider).

Usage: python3 test/codex-tui.py [projectDir]
"""
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/moat-demo/codex-tui"))
TIMEOUT = float(os.environ.get("CODEX_TUI_TIMEOUT", "90"))
MOAT = ["node", os.path.join(REPO, "cmd", "main.ts")]


def sh(args, cwd=PROJECT, env=None):
    return subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True)


def fixture() -> None:
    os.makedirs(os.path.join(PROJECT, "src"), exist_ok=True)
    open(os.path.join(PROJECT, "README.md"), "w").write("# codex tui fixture\n")
    open(os.path.join(PROJECT, "src", "app.js"), "w").write("export const ok = true\n")
    if not os.path.isdir(os.path.join(PROJECT, ".git")):
        sh(["git", "init", "-q", "-b", "main", "."])
    sh(["git", "add", "-A"])
    sh(["git", "-c", "user.email=e2e@example.com", "-c", "user.name=e2e", "commit", "-qm", "base"])


def main() -> int:
    fixture()
    env = dict(os.environ, MOAT_MOCK_CREDENTIAL="codex-tui-dummy-credential")
    sh(MOAT + ["destroy", "--yes"], env=env)
    boot = sh(MOAT + ["up", "--quiet", "--no-detect",
                       "--credential-env", "MOAT_MOCK_CREDENTIAL"], env=env)
    if boot.returncode != 0:
        print("boot failed:", boot.returncode)
        print(boot.stdout[-2000:], boot.stderr[-2000:])
        return 1
    # Human output goes to stderr (stdout is reserved for --json), so ask for the machine
    # form here: reading the wrong stream made this test report an empty status.
    probe = sh(MOAT + ["status", "--json"], env=env)
    try:
        state = json.loads(probe.stdout)
    except ValueError:
        print("status --json did not produce JSON:\n" + probe.stdout[-2000:] + probe.stderr[-2000:])
        return 1
    if state.get("runtime") != "codex":
        print("this fixture is not on the codex runtime: %r" % state.get("runtime"))
        return 1

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(PROJECT)
        os.environ.update(env)
        os.environ["TERM"] = "xterm-256color"
        os.execvp("node", MOAT)

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    output = b""
    deadline = time.time() + TIMEOUT
    alive_since = time.time()

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

    settled = 0.0
    try:
        # Wait for the screen to be drawn: the TUI writes escape sequences and keeps
        # running, while a failure writes a message and exits.
        while time.time() < deadline:
            drain(0.5)
            if b"\x1b[" in output:
                settled = time.time() - alive_since
                break
        # It has to *stay* up while waiting for input; that is what makes it interactive.
        drain(3.0)
        alive = sh(["kill", "-0", str(pid)]).returncode == 0
        os.write(fd, b"\x03")
        drain(1.0)
        os.write(fd, b"\x03")
        drain(3.0)
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

    raw = output.decode("utf-8", "replace")
    text = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", raw)
    print(text[-3000:])
    after = json.loads(sh(MOAT + ["status", "--json"], env=env).stdout)

    checks = [
        ("the TUI was reached, not the help text", "usage: moat" not in text and "unknown command" not in text),
        ("it drew a screen and kept running", settle_ok := (b"\x1b[" in output and alive)),
        ("Ctrl-C left the sandbox running", bool(after.get("running"))),
    ]
    failed = [name for name, ok in checks if not ok]
    for name, ok in checks:
        print(("pass  " if ok else "FAIL  ") + name)
    print("codex tui: " + ("FAILED — " + ", ".join(failed) if failed else "the default runtime opens a live TUI"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
