export type TaskType = "copy" | "theme" | "component" | "page" | "bugfix";
const deny =
  /\b(secret\w*|env|environment|token\w*|password\w*|credential\w*|install\w*|dependenc\w*|curl|wget|eval|exec|shell|sudo)\b|package\.json|lockfile|workflow|\.github|\.env|fetch\s+external|https?:\/\/|delete\s+(?:the\s+)?repo|ignore\s+(?:all|previous)|system\s+prompt/i;
export function classify(text: string): TaskType {
  if (/\b(fix|bug|broken|error)\b/i.test(text)) return "bugfix";
  if (/\b(color|colour|theme|purple|font|background)\b/i.test(text))
    return "theme";
  if (/\b(page|route|landing)\b/i.test(text)) return "page";
  if (/\b(button|card|component|panel|widget)\b/i.test(text))
    return "component";
  return "copy";
}
export function checkIdea(text: string): TaskType {
  if (!text.trim() || text.length > 280)
    throw new Error("Ideas must be 1–280 characters");
  if (deny.test(text)) throw new Error("Request blocked by safety rules");
  return classify(text);
}
export interface DiffEntry {
  path: string;
  added: number;
  removed: number;
  binary?: boolean;
  unsafe?: boolean;
}
export function diffGate(entries: DiffEntry[], maxFiles = 8, maxLines = 400) {
  if (!entries.length) throw new Error("No changes produced");
  if (
    entries.length > maxFiles ||
    entries.reduce((n, e) => n + e.added + e.removed, 0) > maxLines
  )
    throw new Error("Diff exceeds size limit");
  for (const e of entries)
    if (
      e.binary ||
      e.unsafe ||
      /(^|\/)(package\.json|[^/]*lock[^/]*|\.github|\.git|\.env[^/]*|next\.config\.[^/]+)(\/|$)/i.test(
        e.path,
      ) ||
      e.path.includes("..") ||
      e.path.startsWith("/")
    )
      throw new Error("Forbidden diff path or file type");
  return {
    files: entries.map((e) => e.path),
    added: entries.reduce((n, e) => n + e.added, 0),
    removed: entries.reduce((n, e) => n + e.removed, 0),
  };
}
