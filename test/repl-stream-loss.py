#!/usr/bin/env python3
"""
The event stream is the REPL's only view of a turn, and losing it used to be silent.

opencode serves its events over one long-lived HTTP response: streamed text,
tool rows, the question prompt and the session.idle that ends the turn all
arrive there. moat subscribes to it once, at startup.

So when that response ends -- the box is stopped, the server dies, the forward
goes away -- nothing will ever arrive again. Before this test, the loop that
read it was wrapped in a bare "catch (error) {}": the failure vanished, busy
stayed true, and the REPL sat there with a spinner turning forever. Every line
typed afterwards was answered with "queued -- the agent will pick this up when
the current step finishes", for a turn that was already over, and the answer
never came. The only clue was the absence of one.

What is checked here is the honesty of the failure: the REPL says the stream is
gone, it stops claiming the turn is still running, it refuses to send rather
than fire a prompt whose answer it cannot show, and it still answers commands.

The reproduction is a real one: a real pty, a real sandbox, a real turn in
flight against the model stub, and then "moat down" from outside while that turn
is still running.

Usage: python3 test/repl-stream-loss.py [projectDir]
"""
import os
import pty
import re
import select
import shutil
import signal
import subprocess
import sys
import threading
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/moat-demo/streamloss"))
PORT = int(os.environ.get("MOCK_PORT", "5595"))

# Long enough that the turn is still in flight when the box is stopped
# underneath it. This is the whole setup: a turn that finishes before the kill
# would leave the stream idle when it dies, which is a different path.
MODEL_DELAY_MS = 8000

FIXTURE = {
    "package.json": '{\n  "name": "streamloss",\n  "type": "module"\n}\n',
    "src/thing.js": 'export function thing() {\n  return "thing"\n}\n',
}


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, **kw)


def moat(args, env, **kw):
    return sh(["node", os.path.join(REPO, "cmd", "main.ts")] + args, cwd=PROJECT, env=env, **kw)


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
    sh(["git", "commit", "-qm", "streamloss: initial commit"], cwd=PROJECT)


def start_mock():
    proc = subprocess.Popen(
        ["node", os.path.join(REPO, "test", "mock-model.mjs"),
         "--port", str(PORT),
         "--delay", str(MODEL_DELAY_MS),
         "--script", os.path.join(REPO, "test", "scripts", "basic.json"),
         "--record", "/tmp/moat-stream-loss-mock.jsonl"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    time.sleep(1.2)
    return proc


def main() -> int:
    fresh_fixture()
    mock = start_mock()
    env = dict(os.environ, MOAT_CREDENTIAL="stream-loss-credential")
    sh(["node", os.path.join(REPO, "cmd", "main.ts"), "destroy", "--yes"], cwd=PROJECT, env=env)
    boot = moat(["up", "--quiet", "--no-detect", "--profile", "node",
                 "--base-url", "http://127.0.0.1:%d/v1" % PORT,
                 "--model", "mock-model"], env)
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
    write_failed = False

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
        nonlocal write_failed
        try:
            os.write(fd, text.encode())
        except OSError:
            # The REPL exited. That is itself a result: a stream failure that
            # kills the process is not the quiet hang this test is about.
            write_failed = True
            return
        drain(wait)

    # Stopping the box has to happen while the pty keeps being drained, so it
    # runs beside the read loop.
    kill_result = {}

    def stop_box() -> None:
        result = moat(["down"], env)
        kill_result["rc"] = result.returncode
        kill_result["out"] = (result.stdout or "") + (result.stderr or "")

    try:
        drain(3.0)
        send("write a file called hello.txt with the word hi in it\n", 3.0)
        stopper = threading.Thread(target=stop_box)
        stopper.start()
        stopper.join(timeout=90)
        # The stream dies when the box does; give the REPL a moment to notice.
        drain(6.0)
        print("--- moat down said ---")
        print(kill_result.get("out", "(no result: moat down did not finish)"))
        print("--- after the box stopped ---")
        send("are you still there\n", 3.0)
        send("/help\n", 2.0)
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
        moat(["destroy", "--yes"], env)

    raw = output.decode("utf-8", "replace")
    text = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", raw)
    print(text)

    checks = [
        ("the session started and the turn began", "\u203a" in text),
        # The bug: catching nothing and saying nothing. The spinner kept
        # turning and the turn looked like it was still going.
        ("the REPL said the event stream was gone", "lost the event stream" in text),
        ("it still answers commands, so it is not wedged", "/stop" in text),
        # The line the old code printed after a stream death: it claimed the
        # agent would pick the message up when the current step finished, for a
        # turn whose events could no longer arrive.
        ("the next message was refused, not queued", "not sent:" in text),
        ("nothing was queued for a turn that was already gone",
         "queued \u2014 the agent will pick this up" not in text),
        ("the REPL was still alive to take the command", not write_failed),
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
