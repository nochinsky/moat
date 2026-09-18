#!/usr/bin/env python3
"""
Verify, at the wire, that the reasoning setting moat chose is what DeepSeek got.

Every other test of this feature asks opencode what it thinks it did — the
variant it recorded on the message, the reasoning tokens it counted. That is
evidence about opencode's bookkeeping, not about the request. This one puts a
recording proxy in front of DeepSeek and reads the actual request body, which is
the only place the answer is unambiguous:

    variant "max"  ->  {"reasoning_effort": "max"}
    variant "off"  ->  {"thinking": {"type": "disabled"}}

It uses `--upstream`, which keeps DeepSeek's catalog definition (and therefore
its reasoning levels) while moving the address, so the proxy sees exactly the
traffic moat would have sent to DeepSeek.

This is also what settled a false alarm: a run that produced a wrong answer and
zero reasoning tokens looked like the effort was being dropped, but the proxy
showed the parameter arriving correctly and the model simply not using it. One
sample cannot tell "broken" from "did not feel like thinking", and this test does
not have to guess.

Usage: python3 test/wire-effort.py
Needs a real key in ~/.moat/credentials.json or $DEEPSEEK_API_KEY. Spends a
little: two short turns.
"""
import base64
import http.server
import json
import os
import shutil
import socketserver
import subprocess
import sys
import threading
import time
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT = os.path.abspath(os.path.expanduser("~/moat-demo/wire"))
PORT = int(os.environ.get("PROXY_PORT", "8791"))
MODEL = "deepseek-v4-pro"
MOAT = ["node", os.path.join(REPO, "cmd", "main.ts")]
CAPTURED: list[dict] = []


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, **kw)


class Proxy(http.server.BaseHTTPRequestHandler):
    """Record the request body, forward it to DeepSeek unchanged, stream back."""

    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw)
        except Exception:
            body = {}
        CAPTURED.append(
            {
                "path": self.path,
                "reasoning_effort": body.get("reasoning_effort"),
                "thinking": body.get("thinking"),
                "stream": body.get("stream"),
                "tools": len(body.get("tools") or []),
                "model": body.get("model"),
            }
        )
        request = urllib.request.Request(
            f"https://api.deepseek.com{self.path}",
            data=raw,
            method="POST",
            headers={"content-type": "application/json", "authorization": self.headers.get("authorization", "")},
        )
        try:
            with urllib.request.urlopen(request, timeout=180) as upstream:
                self.send_response(upstream.status)
                for key, value in upstream.headers.items():
                    if key.lower() not in ("transfer-encoding", "content-length", "connection"):
                        self.send_header(key, value)
                self.send_header("connection", "close")
                self.end_headers()
                while True:
                    chunk = upstream.read(4096)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except Exception as error:  # noqa: BLE001 - reported, not swallowed
            self.send_response(502)
            self.end_headers()
            self.wfile.write(str(error).encode())


def fresh_fixture():
    shutil.rmtree(PROJECT, ignore_errors=True)
    os.makedirs(PROJECT, exist_ok=True)
    with open(os.path.join(PROJECT, "a.js"), "w") as fh:
        fh.write("export const x = 1\n")
    sh(["git", "init", "-q", "-b", "main"], cwd=PROJECT)
    sh(["git", "config", "user.email", "demo@example.com"], cwd=PROJECT)
    sh(["git", "config", "user.name", "Demo"], cwd=PROJECT)
    sh(["git", "add", "-A"], cwd=PROJECT)
    sh(["git", "commit", "-qm", "wire: initial commit"], cwd=PROJECT)


def env_dir() -> str | None:
    out = sh(MOAT + ["status", "--json"], cwd=PROJECT)
    try:
        return os.path.join(os.path.expanduser("~"), ".moat", "envs", json.loads(out.stdout)["id"])
    except Exception:
        return None


def api(directory: str, path: str, payload=None):
    with open(os.path.join(directory, "server-password")) as fh:
        password = fh.read().strip()
    with open(os.path.join(directory, "state.json")) as fh:
        port = json.load(fh)["port"]
    token = base64.b64encode(f"opencode:{password}".encode()).decode()
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=data,
        headers={"Authorization": f"Basic {token}", "content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        text = response.read().decode()
    return json.loads(text) if text else None


def main() -> int:
    fresh_fixture()
    sh(MOAT + ["destroy", "--yes"], cwd=PROJECT)

    socketserver.TCPServer.allow_reuse_address = True
    server = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Proxy)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    time.sleep(0.4)

    boot = sh(MOAT + ["up", "--quiet", "--no-detect", "--model", MODEL, "--upstream", f"http://127.0.0.1:{PORT}/v1"], cwd=PROJECT)
    if boot.returncode != 0:
        print(boot.stdout, boot.stderr)
        server.shutdown()
        return 1
    if "no DEEPSEEK_API_KEY" in boot.stdout + boot.stderr:
        print("no credential available; this test needs a real DeepSeek key")
        server.shutdown()
        return 2

    directory = env_dir()
    if not directory:
        print("could not locate the environment directory")
        server.shutdown()
        return 1

    variants = api(directory, "/config/providers")
    provider = next((p for p in variants["providers"] if p["id"] == "deepseek"), None) if variants else None
    levels = sorted((provider or {}).get("models", {}).get(MODEL, {}).get("variants", {}).keys())

    question = "What is 8473 times 2916? Answer with just the number."
    for variant in ("max", "off"):
        session = api(directory, "/session", {"title": f"wire {variant}"})
        api(
            directory,
            f"/session/{session['id']}/prompt_async",
            {"model": {"providerID": "deepseek", "modelID": MODEL}, "variant": variant,
             "parts": [{"type": "text", "text": question}]},
        )
        # Wait for the turn to finish rather than guessing a delay.
        for _ in range(90):
            time.sleep(1)
            messages = api(directory, f"/session/{session['id']}/message") or []
            if any((m.get("info") or {}).get("finish") for m in messages):
                break

    server.shutdown()

    sent = [c for c in CAPTURED if c["tools"] > 0]  # the main turn, not title generation
    print("=== what opencode actually put on the wire ===")
    for entry in sent:
        print(
            f"  reasoning_effort={entry['reasoning_effort']!r} thinking={entry['thinking']!r} "
            f"model={entry['model']} stream={entry['stream']} tools={entry['tools']}"
        )
    print(f"\nreasoning levels the server offered: {levels}")

    saw_max = any(e["reasoning_effort"] == "max" and not e["thinking"] for e in sent)
    saw_off = any((e["thinking"] or {}).get("type") == "disabled" and not e["reasoning_effort"] for e in sent)

    checks = [
        ("--upstream kept the DeepSeek catalog", provider is not None),
        ("the model still offers its reasoning levels", "max" in levels and "off" in levels),
        ("the proxy saw both turns", len(sent) >= 2),
        ("effort max went out as reasoning_effort=max", saw_max),
        ("thinking off went out as thinking.type=disabled", saw_off),
        ("thinking off did not also send an effort", not any(e["reasoning_effort"] and e["thinking"] for e in sent)),
        ("the model name on the wire is DeepSeek's, not moat's", all(e["model"] == MODEL for e in sent)),
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
