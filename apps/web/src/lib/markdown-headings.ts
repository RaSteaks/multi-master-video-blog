export const ATX_HEADING = /^ {0,3}(#{1,6})(?:\s+|$)(.*)$/;

export function* markdownHeadings(markdown: string) {
  let fence: { marker: "`" | "~"; length: number } | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);

    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      const length = fenceMatch[1].length;

      if (!fence) {
        fence = { marker, length };
        continue;
      }

      if (fence.marker === marker && length >= fence.length) {
        fence = null;
      }

      continue;
    }

    if (fence) continue;

    const headingMatch = line.match(ATX_HEADING);
    if (!headingMatch) continue;

    const level = headingMatch[1].length;
    const text = cleanHeadingText(headingMatch[2]);
    if (!text) continue;

    yield { level, text };
  }
}

export function cleanHeadingText(value: string) {
  return value
    .replace(/\s+#+\s*$/, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~]/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
