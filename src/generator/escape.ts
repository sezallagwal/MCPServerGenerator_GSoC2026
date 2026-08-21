/** Neutralize DSL-authored text before it is interpolated into generated source. */

export function escapeBlockComment(text: string): string {
  return String(text ?? "")
    .replace(/\*\//g, "*\\/")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

/** Escape the pipe and drop newlines, so a value cannot break the table layout. */
export function escapeMarkdownCell(text: string): string {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ")
    .trim();
}
