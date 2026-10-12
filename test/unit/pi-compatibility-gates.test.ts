import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test, type TestContext } from "node:test"

const ROOT = path.resolve(import.meta.dirname, "../..")
const STEPS = [
  "unborn Git copy-in (real Pi task and read-only review)",
  "Pi customization (package, MCP, resume and headless policy)",
  "Pi container acceptance (task, limits and cleanup)",
]
const SUITES = ["pi-unborn", "pi-customization", "pi-container"]

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-compat-gates-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, "test/evidence"), { recursive: true })
  fs.mkdirSync(path.join(root, "bin"))
  const script = path.join(root, "test/pi-compatibility-hosted.sh")
  fs.copyFileSync(path.join(ROOT, "test/pi-compatibility-hosted.sh"), script)
  const run = { databaseId: 1234, headSha: "test-source", status: "completed", conclusion: "success", url: "https://example.invalid/1234",
    jobs: ["ubuntu-22.04", "ubuntu-24.04"].map(os => ({ name: `sandbox end-to-end (${os})`, conclusion: "success", steps: STEPS.map(name => ({ name, conclusion: "success" })) })) }
  const runFile = path.join(root, "run.json")
  fs.writeFileSync(runFile, JSON.stringify(run))
  for (const os of ["ubuntu-22.04", "ubuntu-24.04"]) {
    fs.mkdirSync(path.join(root, "captures", os), { recursive: true })
    for (const suite of SUITES) fs.writeFileSync(path.join(root, "captures", os, `${suite}.txt`), `${suite}: all criteria passed (unit fixture, not real evidence)\n`)
  }
  fs.writeFileSync(path.join(root, "bin/gh"), `#!/bin/sh
if [ "$2" = view ]; then exec cat "$FIXTURE/run.json"; fi
if [ "$2" = download ]; then
  while [ "$#" -gt 0 ]; do
    case "$1" in --name) name="$2"; shift;; --dir) dir="$2"; shift;; esac
    shift
  done
  mkdir -p "$dir"
  exec cp "$FIXTURE/captures/\${name#evidence-}/"*.txt "$dir/"
fi
exit 1
`, { mode: 0o755 })
  const evidence = path.join(root, "test/evidence/pi-compatibility-hosted.txt")
  fs.writeFileSync(evidence, "prior verified capture\n")
  return { root, run, runFile, evidence, execute: () => spawnSync("bash", [script, "1234"], {
    encoding: "utf8", env: { ...process.env, FIXTURE: root, PATH: `${root}/bin:${process.env.PATH}` },
  }) }
}

test("hosted compatibility requires real passing steps and uploaded captures", t => {
  const f = fixture(t)
  const result = f.execute()
  assert.equal(result.status, 0, result.stderr)
  assert.match(fs.readFileSync(f.evidence, "utf8"), /^pi compatibility hosted: .*uploaded captures checked$/m)
})

test("green jobs with a skipped Pi container step cannot generate passing evidence", t => {
  const f = fixture(t)
  f.run.jobs[0]!.steps[2]!.conclusion = "skipped"
  fs.writeFileSync(f.runFile, JSON.stringify(f.run))
  assert.notEqual(f.execute().status, 0)
  assert.equal(fs.readFileSync(f.evidence, "utf8"), "prior verified capture\n")
})

test("a skipped uploaded container capture is not a passing step's evidence", t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.root, "captures/ubuntu-24.04/pi-container.txt"), "pi-container: SKIPPED (no runtime)\n")
  assert.notEqual(f.execute().status, 0)
  assert.equal(fs.readFileSync(f.evidence, "utf8"), "prior verified capture\n")
})

test("container unavailability exits 77, not zero or a passing capture", t => {
  const f = fixture(t)
  const script = path.join(f.root, "test/pi-container.sh")
  fs.copyFileSync(path.join(ROOT, "test/pi-container.sh"), script)
  fs.writeFileSync(path.join(f.root, "bin/podman"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
  const result = spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, PATH: `${f.root}/bin:${process.env.PATH}` } })
  assert.equal(result.status, 77)
  assert.match(fs.readFileSync(path.join(f.root, "test/evidence/pi-container.txt"), "utf8"), /SKIPPED/)
  assert.doesNotMatch(result.stdout, /all criteria passed/)
})

test("both hosted OS jobs enforce the focused Pi compatibility suites", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8")
  for (const [index, name] of STEPS.entries()) {
    const block = workflow.split(`      - name: ${name}\n`)[1]?.split("      - name:")[0]
    assert.ok(block, name)
    assert.match(block, /if: steps\.userns\.outputs\.available == 'true'/)
    assert.match(block, new RegExp(`run: bash test/${SUITES[index]}\\.sh`))
    assert.doesNotMatch(block, /continue-on-error|\|\| true/)
  }
})
