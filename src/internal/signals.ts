import type { ClassificationRule } from "../types.js";

/**
 * Cross-category keep_always floor, applied before any profile's own rules in
 * every category. This is the structural backbone of the Honest Response
 * Principle: no profile can (accidentally or otherwise) drop a line that looks
 * like a failure, because the check runs before the profile ever sees the line.
 * Patterns are anchored and specific to avoid false positives on clean runs —
 * e.g. `Error:\s` requires the colon+space, not just the substring "error".
 */
export const UNIVERSAL_KEEP_ALWAYS: ClassificationRule[] = [
  { tag: "keep_always", test: (l) => /^\s*(FAIL|FAILED)\b/.test(l) },
  { tag: "keep_always", test: (l) => /\bAssertionError\b/.test(l) },
  { tag: "keep_always", test: (l) => /\bError:\s/.test(l) },
  { tag: "keep_always", test: (l) => /^\s+at\s+\S+\s*\(/.test(l) }, // JS stack frame
  { tag: "keep_always", test: (l) => /^Traceback \(most recent call last\):/.test(l) },
  // tsc / rustc errors — NOT anchored to line start: rustc puts "error[E0308]"
  // at column 0, but tsc's default reporter prefixes it with "file:line:col - ",
  // so an anchored pattern would silently miss every real tsc error line.
  { tag: "keep_always", test: (l) => /\berror(\[[A-Za-z]*\d+\]|\s*TS\d+)/i.test(l) },
  { tag: "keep_always", test: (l) => /\[exit code:\s*\d+\]/.test(l) },
  { tag: "keep_always", test: (l) => /\[process killed/.test(l) },
  { tag: "keep_always", test: (l) => /^\s*(×|✗|✖)\s/.test(l) }, // unicode fail markers
  { tag: "keep_always", test: (l) => /^ERROR\b|^FATAL\b/.test(l) },
];
