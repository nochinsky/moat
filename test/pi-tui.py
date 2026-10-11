#!/usr/bin/env python3
"""Enter Pi through moat on a real pty, without a model call, then leave the box running."""
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
import tempfile
import termios
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="moat-pi-tui-")
MOAT = ["node", os.path.join(REPO, "cmd", "main.ts")]
TIMEOUT = float(os.environ.get("PI_TUI_TIMEOUT", "90"))

def run(args):
    return subprocess.run(args, cwd=PROJECT, capture_output=True, text=True)

def main():
    os.makedirs(PROJECT, exist_ok=True)
    with open(os.path.join(PROJECT, "README.md"), "w") as f:
        f.write("# Pi TUI fixture\n")
    run(["git", "init", "-q", "-b", "main"])
    run(["git", "add", "-A"])
    run(["git", "-c", "user.name=Pi Test", "-c", "user.email=pi@moat.invalid", "commit", "-qm", "base"])
    boot = run(MOAT + ["up", "--quiet", "--no-detect", "--no-credential", "--base-url", "http://127.0.0.1:5597/v1", "--model", "mock-model"])
    if boot.returncode:
        print(boot.stderr); return 1
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(PROJECT)
        os.environ["TERM"] = "xterm-256color"
        os.execvp("node", MOAT + ["--quiet", "--no-credential"])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    output = bytearray()
    def drain(seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if select.select([fd], [], [], .1)[0]:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    return
                output.extend(data)
                # Answer a terminal cursor-position probe as a real terminal would.
                if b"\x1b[6n" in data:
                    os.write(fd, b"\x1b[1;1R")
    child_status = None
    try:
        deadline = time.monotonic() + TIMEOUT
        while time.monotonic() < deadline:
            drain(.3)
            text = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", output.decode("utf8", "replace"))
            if "mock-model" in text and ("pi v" in text.lower() or "1.1.0" in text):
                break
        drain(2)
        child, status = os.waitpid(pid, os.WNOHANG)
        alive = child == 0
        if child:
            child_status = status
        if alive:
            os.write(fd, b"\x03"); drain(.5)
            os.write(fd, b"\x03"); drain(2)
        text = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", output.decode("utf8", "replace"))
        state = json.loads(run(MOAT + ["status", "--json"]).stdout)
        checks = {
            "Pi's own model screen was reached": "mock-model" in text and "1.1.0" in text and b"\x1b[" in output,
            "the TUI waited for input": alive,
            "leaving Pi kept the sandbox running": bool(state.get("running")),
        }
        for name, ok in checks.items():
            print(("pass  " if ok else "FAIL  ") + name)
        if not all(checks.values()):
            print(text[-3000:])
        print("pi tui: " + ("the default runtime opens a live TUI" if all(checks.values()) else "FAILED"))
        return 0 if all(checks.values()) else 1
    finally:
        os.close(fd)
        if child_status is None:
            try:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            except (ProcessLookupError, ChildProcessError):
                pass
        run(MOAT + ["down", "--quiet"])

if __name__ == "__main__":
    sys.exit(main())
