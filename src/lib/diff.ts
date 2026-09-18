/**
 * Deterministic text comparison.
 *
 * Prompt Studio compares two versions of a prompt with a plain longest-common-
 * subsequence diff — no model, no API, no network. The same two inputs always
 * produce the same output, which is what makes "what changed between version 2
 * and version 3" a fact rather than an opinion.
 */

export type DiffOp = "equal" | "added" | "removed";

export interface DiffPart {
  op: DiffOp;
  value: string;
}

/**
 * Longest common subsequence of two token arrays, as a list of operations.
 *
 * Classic dynamic-programming LCS. Quadratic in the token count, which is fine
 * for prompts — a long cinematic prompt is a few hundred words, not a novel.
 */
function lcsDiff(a: string[], b: string[]): Array<{ op: DiffOp; index: number }> {
  const rows = a.length;
  const cols = b.length;
  // table[i][j] = LCS length of a[i..] and b[j..]
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const ops: Array<{ op: DiffOp; index: number }> = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      ops.push({ op: "equal", index: j });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ op: "removed", index: i });
      i++;
    } else {
      ops.push({ op: "added", index: j });
      j++;
    }
  }
  while (i < rows) ops.push({ op: "removed", index: i++ });
  while (j < cols) ops.push({ op: "added", index: j++ });
  return ops;
}

/** Splits into words while keeping the whitespace, so a rebuild is lossless. */
function tokenize(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

/**
 * Word-level diff of two prompts, with runs of the same operation merged so the
 * result reads as phrases rather than a stream of single words.
 */
export function diffWords(before: string, after: string): DiffPart[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const ops = lcsDiff(a, b);

  const parts: DiffPart[] = [];
  for (const { op, index } of ops) {
    const value = op === "removed" ? a[index] : b[index];
    const last = parts[parts.length - 1];
    if (last && last.op === op) last.value += value;
    else parts.push({ op, value });
  }
  return parts;
}

/** Line-level diff, for prompts whose structure is what changed. */
export function diffLines(before: string, after: string): DiffPart[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const ops = lcsDiff(a, b);

  const parts: DiffPart[] = [];
  for (const { op, index } of ops) {
    const value = op === "removed" ? a[index] : b[index];
    const last = parts[parts.length - 1];
    if (last && last.op === op) last.value += `\n${value}`;
    else parts.push({ op, value });
  }
  return parts;
}

export interface DiffSummary {
  changed: boolean;
  addedWords: number;
  removedWords: number;
}

/** A one-line verdict, for badges and lists. */
export function summariseDiff(before: string, after: string): DiffSummary {
  let added = 0;
  let removed = 0;
  for (const part of diffWords(before, after)) {
    const words = part.value.trim() === "" ? 0 : part.value.trim().split(/\s+/).length;
    if (part.op === "added") added += words;
    if (part.op === "removed") removed += words;
  }
  return { changed: added > 0 || removed > 0, addedWords: added, removedWords: removed };
}

/**
 * Whether two prompts differ at all.
 *
 * Line endings are normalised first: CRLF versus LF is a transport artifact
 * (a form body encodes newlines as CRLF), not an edit the filmmaker made.
 */
export function promptsDiffer(a: string, b: string): boolean {
  return normalise(a) !== normalise(b);
}

function normalise(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}
