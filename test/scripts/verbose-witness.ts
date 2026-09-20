/**
 * A witness for `--verbose`, run as a child process.
 *
 * `log.debug` writes to this process's stderr, which the test runner shares with its
 * own output, so the observation happens out of process: this script switches verbose
 * on, emits one debug line, and exits. `verbose-check.test.ts` runs it with and without
 * the switch and compares.
 *
 * `process.exit` rather than falling off the end: stderr to a pipe is asynchronous, and
 * this is the case where the write has to be flushed before the process is gone.
 */
import * as log from "../../lib/log.ts"

const mode = process.argv[2]
if (mode === "on") log.setVerbose(true)
if (mode === "env") {
  // The environment variable still works on its own, which is what a caller who cannot
  // pass a flag relies on.
}
log.debug("VERBOSE-WITNESS: this line only exists when verbose is on")
log.info("VERBOSE-WITNESS: this line is always printed")
process.exit(0)
