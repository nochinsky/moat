#!/usr/bin/env python3
"""
First run with no key: moat should ask for one, check it, and save it.

Driven through a pty because the prompt reads hidden input from a terminal.
Uses a deliberately wrong key first, to prove the check rejects it, then the
real one from the environment.
"""
import os, pty, re, select, shutil, signal, subprocess, sys, time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/moat-demo/onboard-demo"))
REAL_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
CRED_FILE = os.path.expanduser("~/.moat/credentials.json")
BACKUP = CRED_FILE + ".test-backup"

def sh(cmd, **kw):
    return subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, **kw)

def main() -> int:
    if not REAL_KEY:
        print("set DEEPSEEK_API_KEY to run this (it is used to prove the happy path)")
        return 2

    shutil.rmtree(PROJECT, ignore_errors=True)
    os.makedirs(PROJECT)
    had = os.path.exists(CRED_FILE)
    if had:
        shutil.move(CRED_FILE, BACKUP)

    env = dict(os.environ)
    for name in ("DEEPSEEK_API_KEY", "MOAT_CREDENTIAL"):
        env.pop(name, None)

    try:
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(PROJECT)
            os.environ.clear()
            os.environ.update(env)
            os.execvp("node", ["node", os.path.join(REPO, "cmd", "main.ts"), "up", "--quiet"])

        output = b""
        def drain(seconds):
            nonlocal output
            end = time.time() + seconds
            while time.time() < end:
                ready, _, _ = select.select([fd], [], [], 0.2)
                if fd in ready:
                    try: chunk = os.read(fd, 65536)
                    except OSError: return
                    if not chunk: return
                    output += chunk

        try:
            drain(3.0)
            os.write(fd, b"sk-definitely-not-a-real-key\n"); drain(6.0)
            os.write(fd, (REAL_KEY + "\n").encode()); drain(25.0)
            os.write(fd, b"\x03"); drain(2.0)
        finally:
            try: os.close(fd)
            except OSError: pass
            try:
                os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
            except (ProcessLookupError, ChildProcessError): pass
            sh(["node", os.path.join(REPO, "cmd", "main.ts"), "down"], cwd=PROJECT, env=env)

        text = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", output.decode("utf-8", "replace"))
        print(text)

        saved = os.path.exists(CRED_FILE)
        contents = open(CRED_FILE).read() if saved else ""
        mode = oct(os.stat(CRED_FILE).st_mode & 0o777) if saved else "n/a"

        checks = [
            ("it asked for the key", "DEEPSEEK_API_KEY:" in text),
            ("the key was not echoed", REAL_KEY not in text),
            ("the bad key was rejected", "rejected" in text or "Try again" in text),
            ("the good key was accepted", "key accepted" in text),
            ("it was saved", saved and REAL_KEY in contents),
            ("saved mode is 600", mode == "0o600"),
        ]
        print("--- checks ---")
        failed = 0
        for name, ok in checks:
            print(f"  {'pass' if ok else 'FAIL'}  {name}")
            failed += 0 if ok else 1
        print(f"\n{len(checks)-failed}/{len(checks)} checks passed  (saved mode {mode})")
        return 1 if failed else 0
    finally:
        if had and os.path.exists(BACKUP):
            shutil.move(BACKUP, CRED_FILE)
        elif not had and os.path.exists(CRED_FILE):
            os.remove(CRED_FILE)

if __name__ == "__main__":
    sys.exit(main())
