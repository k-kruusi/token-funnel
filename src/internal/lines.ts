// Pure string transforms — no dependency on the rest of the library.

const MAX_LINE_LENGTH = 10_000;

// Matches ANSI/VT100 escape sequences: CSI sequences (cursor movement, color,
// clear-line), OSC sequences (terminal title), and other C1 escapes. Based on
// the well-known ansi-regex pattern.
const ANSI_PATTERN = new RegExp(
  [
    "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z0-9]*(?:;[a-zA-Z0-9]*)*)?\\u0007)",
    "(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-ntqry=><~]))",
  ].join("|"),
  "g",
);

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * Collapse \r-driven progress-bar overwrites within a line, without disturbing
 * \r\n (Windows) line endings — those are normalized to \n first so they are
 * never mistaken for an overwrite. A bare \r splits a line into segments the
 * terminal would have painted over each other; we keep the last non-empty
 * segment, which is what a viewer would see after all the overwrites settle.
 */
export function collapseCarriageReturn(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  return normalized
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const segments = line.split("\r").filter((s) => s.length > 0);
      return segments.length > 0 ? segments[segments.length - 1] : "";
    })
    .join("\n");
}

/**
 * Split raw tool output into individually-classifiable lines: collapse \r
 * progress overwrites, strip ANSI escapes, and cap any single line's length so
 * a pathological unbroken line (minified JSON, a giant base64 blob) can't blow
 * the budget accounting or the regex passes downstream.
 */
export function splitLines(raw: string): string[] {
  const collapsed = collapseCarriageReturn(raw);
  const stripped = stripAnsi(collapsed);
  return stripped.split("\n").map((line) => {
    if (line.length <= MAX_LINE_LENGTH) return line;
    return `${line.slice(0, MAX_LINE_LENGTH)} … [line truncated, ${line.length} chars total]`;
  });
}
