/**
 * Text from the sandbox, made safe to print.
 *
 * The answer, the reasoning, tool output, commit subjects, branch names, change
 * paths and the boot log all come from inside the box, and a terminal acts on the
 * escape sequences in them: OSC 0 retitles the window, OSC 52 writes the clipboard
 * where the terminal allows it, CSI 2J clears the screen, and a carriage return
 * overwrites the row — enough to repaint the transcript the user is reading, which
 * is exactly what a prompt injection wants.
 *
 * It lives in `lib/` rather than `cmd/display.ts` because the copy-out layer needs
 * it too: `moat fetch` and `moat apply` print paths the agent chose.
 *
 * Escape sequences are dropped rather than escaped so that, for example, a test
 * runner's coloured output reads as plain text instead of arriving as literal
 * `[32m` noise. Every ESC byte is removed — as a sequence or as a control
 * character — so a sequence split across two chunks cannot be reassembled.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "") // OSC … BEL/ST
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\u001b[@-Z\\-_]/g, "") // other two-byte sequences
    .replace(/\r/g, "") // carriage returns overwrite the current row
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "") // control chars
}
