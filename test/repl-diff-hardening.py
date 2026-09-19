#!/usr/bin/env python3
"""
/diff must not run the agent's programs on the host.

The sandbox's git repository is the agent's: it can write .git/config and craft
commits. Host-side git reads that config, and some keys name programs git runs.
log.showSignature is one: on a commit carrying any gpgsig header, git executes
gpg.program. An agent can point that at a script it wrote into /work -- whose
host path it reads straight out of /proc/self/mountinfo -- and wait.

The REPL's /diff was the one host-side git call left outside sandboxGit, so the
repository config was live for it. This drives a real pty, with the config and the
crafted commit planted exactly as the agent would leave them, and asserts that the
program did not run while the diff still rendered.

Usage: python3 test/repl-diff-hardening.py [projectDir]
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
PROJECT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/moat-demo/diff-hardening"))
PORT = int(os.environ.get("MOCK_PORT", "5593"))
MARKER = "/tmp/moat-diff-hardening-marker"
SUBJECT = "agent: crafted commit"

FIXTURE = {
    "package.json": '{\n  "name": "diff-hardening",\n  "type": "module"\n}\n',
    "src/thing.js": 'export function thing() {\n  return "thing"\n}\n',
}


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, **kw)


def git(cwd, *args, **kw):
    return subprocess.run(["git", "-C", cwd] + list(args), capture_output=True, text=True, **kw)


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
    sh(["git", "commit", "-qm", "diff-hardening: initial commit"], cwd=PROJECT)


def plant(env_dir: str) -> str:
    """What the agent can leave in its own repository, from inside the box."""
    work = os.path.join(env_dir, "rootfs", "work")
    gpg = os.path.join(work, "evil-gpg.sh")
    with open(gpg, "w") as fh:
        fh.write("#!/bin/sh\necho ran >> %s\n" % MARKER)
    os.chmod(gpg, 0o755)

    # A commit with any signature header makes git try to verify it.
    raw = git(work, "cat-file", "commit", "HEAD").stdout
    headers, _, _ = raw.partition("\n\n")
    lines = headers.split("\n")
    lines += [
        "gpgsig -----BEGIN PGP SIGNATURE-----",
        " ",
        "iQEcBAABCAAGBQJ" + "A" * 60,
        " -----END PGP SIGNATURE-----",
    ]
    crafted = "\n".join(lines) + "\n\n" + SUBJECT + "\n"
    sha = subprocess.run(
        ["git", "-C", work, "hash-object", "-t", "commit", "-w", "--stdin"],
        input=crafted, capture_output=True, text=True,
    ).stdout.strip()
    branch = git(work, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    git(work, "update-ref", "refs/heads/%s" % branch, sha)
    git(work, "config", "log.showSignature", "true")
    git(work, "config", "gpg.program", gpg)
    return branch


def main() -> int:
    fresh_fixture()
    if os.path.exists(MARKER):
        os.remove(MARKER)
    env = dict(os.environ, MOAT_CREDENTIAL="diff-hardening-credential")
    moat(["destroy", "--yes"], env)
    boot = moat(["up", "--quiet", "--no-detect", "--profile", "node",
                 "--base-url", "http://127.0.0.1:%d/v1" % PORT, "--model", "mock-model"], env)
    if boot.returncode != 0:
        print(boot.stdout, boot.stderr)
        return 1

    status = moat(["status"], env)
    env_dir = ""
    for line in (status.stdout + status.stderr).splitlines():
        if line.startswith("env "):
            env_dir = line.split(None, 1)[1].strip()
    if not env_dir:
        print("could not read the environment directory from moat status")
        print(status.stdout, status.stderr)
        return 1
    branch = plant(env_dir)
    print("planted in %s: branch %s, log.showSignature=true, gpg.program=<work>/evil-gpg.sh" % (env_dir, branch))

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
        send("/diff\n", 6.0)
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
        moat(["down"], env)
        moat(["destroy", "--yes"], env)

    raw = output.decode("utf-8", "replace")
    text = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", raw)
    print(text)
    ran = os.path.exists(MARKER)
    if ran:
        print("--- the program the agent planted ran on the host: ---")
        print(open(MARKER).read())
        os.remove(MARKER)

    checks = [
        ("the session started", "\u203a" in text),
        ("/diff rendered the branch log", SUBJECT in text),
        ("the agent's gpg program did not run on the host", not ran),
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
