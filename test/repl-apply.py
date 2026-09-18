#!/usr/bin/env python3
"""
The flow the tool is for: `moat` in a directory, tell it what to do, apply the
result without leaving the session.

Runs in a plain non-git directory with nothing in it, which is the case that had
no copy-out path at all before.
"""
import os, pty, re, select, shutil, signal, subprocess, sys, time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/moat-demo/scratch-demo"))
PORT = int(os.environ.get("MOCK_PORT", "5596"))

def sh(cmd, **kw):
    return subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, **kw)

def main() -> int:
    shutil.rmtree(PROJECT, ignore_errors=True)
    os.makedirs(PROJECT)
    assert not os.path.exists(os.path.join(PROJECT, ".git")), "fixture must not be a git repo"

    # A binary file, named to sort before everything else. Both halves matter.
    #
    # The baseline is materialised by running `git archive` and unpacking it, and
    # a tar archive is binary. Piping it through the process meant decoding it to
    # a UTF-8 string and re-encoding it, which is lossy — a byte that is not
    # valid UTF-8 becomes U+FFFD and re-encodes to three bytes, so the archive
    # grows and every header after the damage is read from the wrong offset.
    # tar then stops partway, and because only its exit code was checked, moat
    # reported "nothing to apply" over a tree it had failed to read. A binary
    # file is what triggers it; sorting first is what stops tar early enough to
    # lose the files after it.
    with open(os.path.join(PROJECT, "aaa.bin"), "wb") as fh:
        fh.write(bytes(range(256)) * 400)

    mock = subprocess.Popen(
        ["node", os.path.join(REPO, "test", "mock-model.mjs"), "--port", str(PORT),
         "--script", os.path.join(REPO, "test", "scripts", "basic.json"),
         "--record", "/tmp/moat-apply-mock.jsonl"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    time.sleep(1.2)

    env = dict(os.environ, MOAT_CREDENTIAL="apply-demo-cred")
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
        os.write(fd, b"create a file and commit it\n"); drain(20.0)
        os.write(fd, b"/apply\n"); drain(4.0)
        os.write(fd, b"yes\n"); drain(4.0)
        os.write(fd, b"/quit\n"); drain(1.5)
    finally:
        try: os.close(fd)
        except OSError: pass
        try:
            os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError): pass
        mock.send_signal(signal.SIGTERM)

    text = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", output.decode("utf-8", "replace"))
    print(text)

    landed = sorted(os.listdir(PROJECT))
    # The baseline must be a faithful copy of what was copied in, byte for byte.
    # Reading it back through the text pipeline corrupted it silently, so this
    # compares content rather than just checking the file is there.
    binary = os.path.join(PROJECT, "aaa.bin")
    with open(binary, "rb") as fh:
        binary_intact = fh.read() == bytes(range(256)) * 400
    checks = [
        ("the agent worked", "agent-output.txt" in text),
        ("apply showed a plan", "add" in text and "change(s)" in text),
        ("apply asked before writing", "type \"yes\"" in text),
        ("the file landed in the directory", "agent-output.txt" in landed),
        ("the session stayed open", "/quit" in text),
        # Regression: a binary file in the project used to break the baseline,
        # which made apply report "nothing to apply" and quietly do nothing.
        ("a binary file did not stop the plan", "nothing to apply" not in text),
        ("the binary file survived apply byte for byte", binary_intact),
    ]
    print("\n--- on disk ---")
    print(" ", landed or "(empty)")
    print("\n--- checks ---")
    failed = 0
    for name, ok in checks:
        print(f"  {'pass' if ok else 'FAIL'}  {name}")
        failed += 0 if ok else 1
    print(f"\n{len(checks)-failed}/{len(checks)} checks passed")
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(main())
