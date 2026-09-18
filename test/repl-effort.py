#!/usr/bin/env python3
"""
Verify the reasoning-effort control against a real DeepSeek environment.

The stub suites cannot cover this. `--base-url` makes moat declare a custom
model with no capability metadata, so it honestly has no effort levels to
offer; the levels only exist for a model the catalog describes. This test
therefore needs a real DeepSeek environment and spends a few tokens.

What it proves, in increasing order of strength:
  1. `/model` reports the levels the server says this model has.
  2. `/think <level>` is accepted, and a level the model does not have is
     refused rather than silently ignored.
  3. the turn actually went out at that level: the sandbox's own server records
     `variant` on the assistant message it produced, and that is read back over
     the API rather than taken from moat's output.

Chain this sits on, verified separately:
  - `session/llm/request.ts` maps `model.variants[variant]` into the provider
    options merged into the request, which for `@ai-sdk/openai-compatible` is
    `{ reasoningEffort: <level> }` (provider/transform.ts).
  - `api.deepseek.com` accepts reasoning_effort in {low, medium, high, max} for
    deepseek-v4-pro and answers 422 for anything else.

What it does NOT claim: that a given level changes the answer to any particular
prompt. That is model behaviour, and one sample cannot show it.

Usage: python3 test/repl-effort.py [projectDir]
"""
import base64
import json
import os
import pty
import re
import select
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/moat-demo/effort"))
TIMEOUT = float(os.environ.get("REPL_TIMEOUT", "300"))
MODEL = os.environ.get("EFFORT_MODEL", "deepseek-v4-pro")
MOAT = ["node", os.path.join(REPO, "cmd", "main.ts")]
QUESTION = "How many times does the letter r appear in strawberry? Answer with just the number."


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, **kw)


def fresh_fixture():
    shutil.rmtree(PROJECT, ignore_errors=True)
    os.makedirs(os.path.join(PROJECT, "src"), exist_ok=True)
    with open(os.path.join(PROJECT, "README.md"), "w") as fh:
        fh.write("# effort fixture\n")
    with open(os.path.join(PROJECT, "src", "math.js"), "w") as fh:
        fh.write("export function add(a, b) { return a + b }\n")
    sh(["git", "init", "-q", "-b", "main"], cwd=PROJECT)
    sh(["git", "config", "user.email", "demo@example.com"], cwd=PROJECT)
    sh(["git", "config", "user.name", "Demo"], cwd=PROJECT)
    sh(["git", "add", "-A"], cwd=PROJECT)
    sh(["git", "commit", "-qm", "effort: initial commit"], cwd=PROJECT)


def env_dir() -> str | None:
    """The environment directory moat created for this project."""
    out = sh(MOAT + ["status", "--json"], cwd=PROJECT)
    try:
        state = json.loads(out.stdout)
        return os.path.join(os.path.expanduser("~"), ".moat", "envs", state["id"])
    except Exception:
        return None


def api(directory: str, path: str):
    with open(os.path.join(directory, "server-password")) as fh:
        password = fh.read().strip()
    with open(os.path.join(directory, "state.json")) as fh:
        port = json.load(fh)["port"]
    token = base64.b64encode(f"opencode:{password}".encode()).decode()
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", headers={"Authorization": f"Basic {token}"}
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read())


def assistant_messages(directory: str) -> list[dict]:
    """Every assistant message, in the order the server lists them."""
    found = []
    for session in api(directory, "/session"):
        for message in api(directory, f"/session/{session['id']}/message"):
            info = message.get("info") or {}
            if info.get("role") == "assistant":
                found.append({"info": info, "parts": message.get("parts") or []})
    return found


def reasoning_chars(message: dict) -> int:
    return sum(len(p.get("text") or "") for p in message["parts"] if p.get("type") == "reasoning")


def main() -> int:
    fresh_fixture()
    sh(MOAT + ["destroy", "--yes"], cwd=PROJECT)
    boot = sh(MOAT + ["up", "--quiet", "--no-detect", "--model", MODEL], cwd=PROJECT)
    if boot.returncode != 0:
        print(boot.stdout, boot.stderr)
        return 1
    if "no DEEPSEEK_API_KEY" in boot.stdout + boot.stderr:
        print("no credential available; this test needs a real DeepSeek key")
        return 2

    directory = env_dir()
    if not directory:
        print("could not locate the environment directory")
        return 1

    # Set the level in the CLI, then send one message. Anything the server
    # records about that message came from moat's own request.
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(PROJECT)
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
        os.write(fd, text.encode())
        drain(wait)

    try:
        drain(2.0)
        send("/model\n", 3.0)
        send("/think\n", 3.0)
        send("/think max\n", 2.0)
        send("/status\n", 2.0)
        send("/think not-a-level\n", 2.0)
        send("/thinking\n", 1.0)
        # A question that actually requires working out, asked identically both
        # ways. A trivial prompt can be answered without any reasoning at all,
        # which would make the comparison below meaningless rather than false.
        send(f"{QUESTION}\n", 60.0)
        # Thinking is on by default in DeepSeek and its effort scale has no
        # "off": turning it off is a separate documented parameter. moat exposes
        # it as a variant, so it should be offered and it should work.
        send("/think off\n", 2.0)
        send(f"{QUESTION}\n", 60.0)
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

    text = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", output.decode("utf-8", "replace"))
    print(text)

    messages = assistant_messages(directory)
    recorded = messages[0]["info"].get("variant") if messages else None
    print(f"\nserver recorded variant for the turn: {recorded!r}")

    # The `off` turn is the newest: it must carry the variant, and it must have
    # produced no reasoning at all. The first turn establishes that this model
    # does reason, so the second one is a real comparison and not a coincidence.
    off_turn = next((m for m in messages if m["info"].get("variant") == "off"), None)
    reasoned = [m for m in messages if m["info"].get("variant") != "off"]
    off_reasoning = reasoning_chars(off_turn) if off_turn else -1
    baseline_reasoning = sum(reasoning_chars(m) for m in reasoned)
    print(f"reasoning characters: with thinking {baseline_reasoning}, with thinking off {off_reasoning}")

    checks = [
        ("/model listed the DeepSeek models", "deepseek/" in text and MODEL in text),
        ("/model reported this model's effort levels", "effort:" in text and "max" in text),
        ("/think listed the levels", re.search(r"\u203a\s+max", text) is not None),
        ("/think max was accepted", "effort is now max" in text),
        ("/status showed the effort", "effort max" in text),
        ("/think refused a level that does not exist", "is not one of" in text),
        ("/thinking toggled", "showing reasoning" in text),
        ("the chosen effort reached the server", recorded == "max"),
        ("/think offered the documented off switch", "off" in text and "thinking is now" not in text),
        ("/think off was accepted", "effort is now off" in text),
        ("thinking off reached the server", off_turn is not None),
        ("thinking off produced no reasoning", off_reasoning == 0),
    ]
    # Deliberately not asserted here: that thinking *on* produces reasoning. It
    # is model behaviour, not plumbing — the same question with the same effort
    # reasoned once and answered from memory the next time, which briefly looked
    # like the effort was being dropped. test/wire-effort.py settles that
    # question by reading the request body instead of the model's mood.
    print("\n--- checks ---")
    failed = 0
    for name, ok in checks:
        print(f"  {'pass' if ok else 'FAIL'}  {name}")
        failed += 0 if ok else 1
    print(f"\n{len(checks) - failed}/{len(checks)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
