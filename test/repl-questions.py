#!/usr/bin/env python3
"""
Check that the agent can ask the user a question in the interactive CLI, and
that the answer gets back to it.

Only interactive mode enables the question tool: in batch mode a question nobody
can answer is a hang, so moat refuses it there.
"""
import os, pty, re, select, shutil, signal, subprocess, sys, time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/moat-demo/question-demo"))
PORT = int(os.environ.get("MOCK_PORT", "5597"))

def sh(cmd, **kw):
    return subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, **kw)

def main() -> int:
    shutil.rmtree(PROJECT, ignore_errors=True)
    os.makedirs(PROJECT, exist_ok=True)
    with open(os.path.join(PROJECT, "README.md"), "w") as fh:
        fh.write("# demo\n")
    sh(["git", "init", "-q", "-b", "main"], cwd=PROJECT)
    sh(["git", "config", "user.email", "d@e.com"], cwd=PROJECT)
    sh(["git", "config", "user.name", "D"], cwd=PROJECT)
    sh(["git", "add", "-A"], cwd=PROJECT)
    sh(["git", "commit", "-qm", "init"], cwd=PROJECT)

    mock = subprocess.Popen(
        ["node", os.path.join(REPO, "test", "mock-model.mjs"), "--port", str(PORT),
         "--script", os.path.join(REPO, "test", "scripts", "asks-a-question.json"),
         "--record", "/tmp/moat-question-mock.jsonl"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    time.sleep(1.2)

    env = dict(os.environ, MOAT_CREDENTIAL="question-demo-cred")
    sh(["node", os.path.join(REPO, "cmd", "main.ts"), "destroy", "--yes"], cwd=PROJECT, env=env)
    boot = sh(["node", os.path.join(REPO, "cmd", "main.ts"), "up", "--quiet", "--base-url",
               f"http://127.0.0.1:{PORT}/v1", "--model", "mock-model"], cwd=PROJECT, env=env)
    if boot.returncode != 0:
        print(boot.stdout, boot.stderr); mock.send_signal(signal.SIGTERM); return 1

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(PROJECT)
        os.environ.update(env)
        os.execvp("node", ["node", os.path.join(REPO, "cmd", "main.ts"), "attach"])

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
        drain(2.0)
        os.write(fd, b"make the migration\n"); drain(6.0)
        os.write(fd, b"2\n"); drain(8.0)          # answer by number
        os.write(fd, b"/verify\n"); drain(6.0)
        os.write(fd, b"/quit\n"); drain(1.0)
    finally:
        try: os.close(fd)
        except OSError: pass
        try:
            os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError): pass
        mock.send_signal(signal.SIGTERM)

    text = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", output.decode("utf-8", "replace"))
    print(text)

    checks = [
        ("the agent asked a question", "Which database" in text),
        ("the options were shown", "postgres" in text and "sqlite" in text),
        ("the answer was delivered", "answered" in text),
        ("the agent continued after the answer", "choice.txt" in text or "Done, using" in text),
    ]
    print("\n--- checks ---")
    failed = 0
    for name, ok in checks:
        print(f"  {'pass' if ok else 'FAIL'}  {name}")
        failed += 0 if ok else 1
    print(f"\n{len(checks)-failed}/{len(checks)} checks passed")
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(main())
