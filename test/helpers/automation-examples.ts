export interface Example {
  lang: string;
  flags: string[];
  attrs: Record<string, string>;
  code: string;
}

function parseInfo(info: string): Omit<Example, "code"> {
  const out: Omit<Example, "code"> = { lang: "", flags: [], attrs: {} };
  const re = /([\w-]+)(?:=(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)))?/g;
  let first = true;
  let match: RegExpExecArray | null;
  while ((match = re.exec(info.trim()))) {
    const [, key = "", dq, sq, bare] = match;
    const value = dq !== undefined ? dq.replace(/\\(.)/g, "$1") : sq ?? bare;
    if (first && value === undefined) out.lang = key.toLowerCase();
    else if (value === undefined) out.flags.push(key);
    else out.attrs[key] = value;
    first = false;
  }
  return out;
}

export function extractExamples(markdown: string): Example[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const examples: Example[] = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(lines[i] ?? "");
    if (!fence) continue;
    const [, indent = "", marker = "", info = ""] = fence;
    const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
    const body: string[] = [];
    i++;
    while (i < lines.length && !close.test(lines[i] ?? "")) {
      const line = lines[i] ?? "";
      body.push(line.startsWith(indent) ? line.slice(indent.length) : line.trimStart());
      i++;
    }
    if (i >= lines.length) throw new Error("Unclosed Markdown code fence");
    const parsed = parseInfo(info);
    if (parsed.flags.includes("automation") || parsed.flags.includes("frontmatter")) {
      examples.push({ ...parsed, code: body.join("\n") });
    }
  }
  return examples;
}
