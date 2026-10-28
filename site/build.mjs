// Builds the Agent Automations site: site/content/*.md -> site/dist/ (HTML, Markdown copies,
// llms.txt and a search index), plus pages rendered from skills/agent-automations and a verbatim
// copy of that folder. No configuration, no network, no dependencies beyond `yaml`, which the
// package already has. The output is deterministic so the committed site/dist can be checked
// against a fresh build.

import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse as parseYaml } from "yaml";

export const SITE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SITE_DIR, "..");
const CONTENT_DIR = path.join(SITE_DIR, "content");
const ASSETS_DIR = path.join(SITE_DIR, "assets");
export const DEFAULT_OUT = path.join(SITE_DIR, "dist");
export const SKILL_DIR = path.join(ROOT, "skills", "agent-automations");
/** Where the copy of the skill folder goes in the output, and its zip beside it. */
export const SKILL_OUT = "skills/agent-automations";
export const SKILL_ZIP = "skills/agent-automations.zip";

export const SITE_TITLE = "Agent Automations";
export const SITE_TAGLINE = "A standardized way to tell AI agents when to act.";

export const SKILL_GROUP = "Agent skill";
/** The one host's own pages. Every other page stays host-neutral (test/site.test.ts checks). */
export const PI_GROUP = "pi-automations";
/** Sidebar groups, in order. The empty group is the unlabelled top of the sidebar. */
export const GROUPS = ["", "For automation authors", "For host implementors", SKILL_GROUP, "Optional", PI_GROUP];

// ---------------------------------------------------------------------------------------------
// Small helpers

const lf = (s) => s.replace(/\r\n?/g, "\n");

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** `on.schedule.cron` -> `on-schedule-cron`; `` `name` field `` -> `name-field`. */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_]/g, "")
    .replace(/[./:]/g, " ")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/** Split `---\n<yaml>\n---\n<body>`. */
export function splitFrontMatter(text) {
  const src = lf(text);
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  if (!m) return { data: {}, body: src };
  return { data: parseYaml(m[1]) ?? {}, body: m[2] };
}

/** `markdown automation title="a b" invalid='x'` -> { lang, flags, attrs }. */
export function parseInfo(info) {
  const out = { lang: "", flags: new Set(), attrs: {} };
  const re = /([\w-]+)(?:=(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)))?/g;
  let first = true;
  let m;
  while ((m = re.exec(info.trim()))) {
    const [, key, dq, sq, bare] = m;
    const value = dq !== undefined ? dq.replace(/\\(.)/g, "$1") : sq ?? bare;
    if (first && value === undefined) {
      out.lang = key.toLowerCase();
    } else if (value === undefined) {
      out.flags.add(key);
    } else {
      out.attrs[key] = value;
    }
    first = false;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Syntax highlighting: a few small line-oriented tokenizers, enough to colour the examples.

const span = (cls, text) => (text === "" ? "" : `<span class="tok-${cls}">${escapeHtml(text)}</span>`);

/** Split a YAML value from a trailing ` # comment`, respecting quotes. */
function splitComment(s) {
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(s[i - 1]))) return [s.slice(0, i), s.slice(i)];
  }
  return [s, ""];
}

function yamlValue(v) {
  const [value, comment] = splitComment(v);
  const trimmed = value.trimEnd();
  const trail = value.slice(trimmed.length);
  let out;
  if (trimmed === "") out = "";
  else if (/^(true|false|null|~)$/.test(trimmed)) out = span("kw", trimmed);
  else if (/^-?\d+(\.\d+)?$/.test(trimmed)) out = span("num", trimmed);
  else if (/^[|>][-+]?$/.test(trimmed)) out = span("punct", trimmed);
  else out = span("str", trimmed);
  return out + escapeHtml(trail) + span("com", comment);
}

function highlightYamlLine(line) {
  if (/^\s*(---|\.\.\.)\s*$/.test(line)) return span("punct", line);
  if (/^\s*#/.test(line)) return span("com", line);
  const m = /^(\s*)(-\s+)?([^\s:#"'][^:#]*?|"[^"]*"|'[^']*')(:)(\s|$)(.*)$/.exec(line);
  if (m) {
    const [, indent, dash = "", key, colon, space, rest] = m;
    return escapeHtml(indent) + span("punct", dash) + span("key", key) + span("punct", colon) + escapeHtml(space) + yamlValue(rest);
  }
  const item = /^(\s*)(-\s+)(.*)$/.exec(line);
  if (item) return escapeHtml(item[1]) + span("punct", item[2]) + yamlValue(item[3]);
  if (/^\s+\S/.test(line)) {
    const indent = /^\s*/.exec(line)[0];
    return escapeHtml(indent) + yamlValue(line.slice(indent.length));
  }
  return escapeHtml(line);
}

function highlightYaml(code) {
  return code.split("\n").map(highlightYamlLine).join("\n");
}

function inlineCodeTokens(text) {
  return text
    .split(/(`[^`]+`)/)
    .map((part) => (/^`[^`]+`$/.test(part) ? span("code", part) : escapeHtml(part)))
    .join("");
}

function highlightMarkdownBody(lines) {
  let fence = "";
  return lines.map((line) => {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) {
        fence = "";
        return span("punct", line);
      }
      return span("code", line);
    }
    if (f) {
      fence = f[1];
      return span("punct", line);
    }
    if (/^#{1,6}\s/.test(line)) return span("head", line);
    const li = /^(\s*)([-*+]|\d+[.)])(\s.*)$/.exec(line);
    if (li) return escapeHtml(li[1]) + span("punct", li[2]) + inlineCodeTokens(li[3]);
    return inlineCodeTokens(line);
  });
}

function highlightMarkdown(code) {
  const lines = code.split("\n");
  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close > 0) {
      return [
        ...lines.slice(0, close + 1).map(highlightYamlLine),
        ...highlightMarkdownBody(lines.slice(close + 1)),
      ].join("\n");
    }
  }
  return highlightMarkdownBody(lines).join("\n");
}

const JS_KEYWORDS = new Set(
  "const let var function return if else for while do switch case break continue new try catch finally throw async await import from export default of in typeof instanceof class extends null undefined true false this".split(" "),
);

function highlightJs(code) {
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(code))) {
    out += escapeHtml(code.slice(last, m.index));
    if (m[1]) out += span("com", m[1]);
    else if (m[2]) out += span("str", m[2]);
    else if (m[3]) out += span("num", m[3]);
    else if (JS_KEYWORDS.has(m[4])) out += span("kw", m[4]);
    else if (code[re.lastIndex] === "(") out += span("fn", m[4]);
    else out += escapeHtml(m[4]);
    last = re.lastIndex;
  }
  return out + escapeHtml(code.slice(last));
}

function highlightShell(code) {
  return code
    .split("\n")
    .map((line) => {
      if (/^\s*#/.test(line)) return span("com", line);
      const prompt = /^(\s*)(\$ |> )?/.exec(line);
      let rest = line.slice(prompt[0].length);
      let out = escapeHtml(prompt[1]) + span("punct", prompt[2] ?? "");
      const cmd = /^[\w./~-]+/.exec(rest);
      if (cmd) {
        out += span("fn", cmd[0]);
        rest = rest.slice(cmd[0].length);
      }
      const [body, comment] = splitComment(rest);
      out += body
        .split(/("(?:[^"\\]|\\.)*"|'[^']*'|\s--?[\w-]+)/)
        .map((part) => {
          if (/^["']/.test(part)) return span("str", part);
          if (/^\s--?[\w-]+$/.test(part)) return escapeHtml(part[0]) + span("kw", part.slice(1));
          return escapeHtml(part);
        })
        .join("");
      return out + span("com", comment);
    })
    .join("\n");
}

function highlightJson(code) {
  return code.replace(/("(?:[^"\\]|\\.)*")(\s*:)?|(\b-?\d+(?:\.\d+)?\b)|\b(true|false|null)\b|(\/\/[^\n]*)/g, (all, str, colon, num, kw, com) => {
    if (str) return colon ? span("key", str) + escapeHtml(colon) : span("str", str);
    if (num) return span("num", num);
    if (kw) return span("kw", kw);
    if (com) return span("com", com);
    return escapeHtml(all);
  }).replace(/(^|<\/span>)([^<]+)(?=<span|$)/g, (all, pre, text) => pre + text);
}

function highlightTree(code) {
  return code
    .split("\n")
    .map((line) => {
      const [body, comment] = splitComment(line);
      return escapeHtml(body) + span("com", comment);
    })
    .join("\n");
}

export function highlight(code, lang) {
  switch (lang) {
    case "yaml":
    case "yml":
      return highlightYaml(code);
    case "markdown":
    case "md":
      return highlightMarkdown(code);
    case "js":
    case "javascript":
    case "mjs":
    case "ts":
    case "typescript":
      return highlightJs(code);
    case "sh":
    case "bash":
    case "shell":
    case "console":
    case "powershell":
    case "ps1":
      return highlightShell(code);
    case "tree":
    case "text":
    case "txt":
      return highlightTree(code);
    default:
      return escapeHtml(code);
  }
}

// ---------------------------------------------------------------------------------------------
// Icons: simple strokes drawn for this site.

const svg = (body, size = 16) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICONS = {
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  chevron: svg('<path d="M7 10l5 5 5-5"/>'),
  chevronRight: svg('<path d="M10 7l5 5-5 5"/>'),
  chevronLeft: svg('<path d="M14 7l-5 5 5 5"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'),
  toc: svg('<path d="M4 6h16M4 12h10M4 18h13"/>', 14),
  github: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>`,
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>'),
  moon: svg('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>'),
  menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>', 14),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  tip: svg('<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0 0 12 3Z"/>'),
  warning: svg('<path d="M12 4 2.8 19.5h18.4Z"/><path d="M12 10v4M12 17h.01"/>'),
  x: svg('<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>'),
  file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9.5 13.5 8 15l1.5 1.5M14.5 13.5 16 15l-1.5 1.5"/>', 20),
  start: svg('<path d="M5 19c1.5-4 4.5-7.5 9-10l3-3c1.2-1.2 3-1 3-1s.2 1.8-1 3l-3 3c-2.5 4.5-6 7.5-10 9"/><path d="M9 11 6.5 9.5 3 11l3.5 1M13 15l1.5 2.5L13 21l-1-3.5"/>', 20),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 20),
  server: svg('<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M8 7.5h.01M8 16.5h.01"/>', 20),
};

const CARD_ICONS = { quickstart: "start", specification: "file", hosts: "server" };

// ---------------------------------------------------------------------------------------------
// Markdown: the subset these pages use (headings, paragraphs, lists, tables, fences, quotes and
// GitHub-style alerts, links, emphasis, inline code), with a `<!-- cards -->` marker.

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_RE = /^( *)([-*+]|\d+[.)])( +|$)(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const HR_RE = /^ {0,3}([-*_])( *\1){2,} *$/;
const ALERTS = {
  NOTE: ["note", "info", "Note"],
  TIP: ["tip", "tip", "Tip"],
  WARNING: ["warning", "warning", "Warning"],
  IMPORTANT: ["important", "info", "Important"],
};

function isBlockStart(line, next) {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    /^ {0,3}>/.test(line) ||
    LIST_RE.test(line) ||
    HR_RE.test(line) ||
    /^\s*<!--.*-->\s*$/.test(line) ||
    (line.includes("|") && next !== undefined && TABLE_SEP_RE.test(next))
  );
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "\\|";
      i++;
      continue;
    }
    if (ch === "`") code = !code;
    if (ch === "|" && !code) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

class Renderer {
  constructor(page, pages) {
    this.page = page;
    this.pages = pages;
    this.headings = [];
    this.ids = new Map();
    this.examples = [];
  }

  uniqueId(base) {
    const id = base || "section";
    const n = this.ids.get(id) ?? 0;
    this.ids.set(id, n + 1);
    return n === 0 ? id : `${id}-${n}`;
  }

  href(url) {
    const mapped = this.page.resolveLink?.(url);
    if (mapped !== undefined) return mapped;
    const m = /^([\w-]+)\.md(#[\w-]*)?$/.exec(url);
    if (m && this.pages.has(m[1])) return `${m[1]}.html${m[2] ?? ""}`;
    return url;
  }

  inline(text) {
    const stash = [];
    const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;
    let s = text.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks, code) => {
      const inner = /^ [\s\S]* $/.test(code) && code.trim() !== "" ? code.slice(1, -1) : code;
      return keep(`<code>${escapeHtml(inner.replace(/\\\|/g, "|"))}</code>`);
    });
    s = s.replace(/<(https?:\/\/[^\s>]+)>/g, (_, url) => keep(`<a href="${escapeHtml(url)}" class="external" rel="noopener">${escapeHtml(url)}</a>`));
    s = s.replace(/\\([\\`*_[\]()#+\-.!|<>])/g, (_, ch) => keep(escapeHtml(ch)));
    s = escapeHtml(s);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
      const href = this.href(decodeEntities(url));
      const external = /^https?:/.test(href);
      const inner = this.emphasis(label).replace(/\u0000(\d+)\u0000/g, (_m, k) => stash[Number(k)]);
      return keep(`<a href="${escapeHtml(href)}"${external ? ' class="external" rel="noopener"' : ""}>${inner}</a>`);
    });
    s = this.emphasis(s);
    for (let pass = 0; pass < 3 && s.includes("\u0000"); pass++) {
      s = s.replace(/\u0000(\d+)\u0000/g, (_, k) => stash[Number(k)]);
    }
    return s;
  }

  emphasis(s) {
    return s
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, "$1<em>$2</em>")
      .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1<em>$2</em>");
  }

  render(markdown) {
    return this.blocks(lf(markdown).split("\n"));
  }

  blocks(lines) {
    const out = [];
    let cards = false;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") {
        i++;
        continue;
      }

      const fence = FENCE_RE.exec(line);
      if (fence) {
        const [, indent, marker, info] = fence;
        const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
        const body = [];
        i++;
        while (i < lines.length && !close.test(lines[i])) {
          body.push(lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i].trimStart());
          i++;
        }
        i++;
        out.push(this.code(body.join("\n"), info));
        continue;
      }

      const comment = /^\s*<!--\s*(.*?)\s*-->\s*$/.exec(line);
      if (comment) {
        if (comment[1] === "cards") cards = true;
        i++;
        continue;
      }

      const heading = HEADING_RE.exec(line);
      if (heading) {
        out.push(this.heading(heading[1].length, heading[2]));
        i++;
        continue;
      }

      if (HR_RE.test(line)) {
        out.push("<hr>");
        i++;
        continue;
      }

      if (/^ {0,3}>/.test(line)) {
        const quoted = [];
        while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
          quoted.push(lines[i].replace(/^ {0,3}> ?/, ""));
          i++;
        }
        out.push(this.quote(quoted));
        continue;
      }

      if (line.includes("|") && TABLE_SEP_RE.test(lines[i + 1] ?? "")) {
        const rows = [line];
        const align = splitRow(lines[i + 1]).map((c) =>
          c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "",
        );
        i += 2;
        while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
          rows.push(lines[i]);
          i++;
        }
        out.push(this.table(rows.map(splitRow), align));
        continue;
      }

      if (LIST_RE.test(line)) {
        const consumed = this.list(lines, i, cards);
        out.push(consumed.html);
        i = consumed.next;
        cards = false;
        continue;
      }

      const para = [line];
      i++;
      while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i], lines[i + 1])) {
        para.push(lines[i]);
        i++;
      }
      out.push(`<p>${this.inline(para.map((l) => l.trim()).join("\n"))}</p>`);
    }
    return out.join("\n");
  }

  heading(level, raw) {
    const html = this.inline(raw);
    if (level === 1) return `<h1>${html}</h1>`;
    const text = stripTags(html);
    const id = this.uniqueId(slugify(text));
    if (level <= 3) this.headings.push({ level, id, text });
    return `<h${level} id="${id}"><a class="heading-anchor" href="#${id}" aria-label="Link to this section: ${escapeHtml(text)}">${ICONS.link}</a>${html}</h${level}>`;
  }

  quote(lines) {
    const alert = /^\[!(\w+)\]\s*$/.exec(lines[0] ?? "");
    if (alert && ALERTS[alert[1].toUpperCase()]) {
      const [cls, icon, label] = ALERTS[alert[1].toUpperCase()];
      const inner = this.blocks(lines.slice(1));
      return `<div class="callout callout-${cls}" role="note" aria-label="${label}"><span class="callout-icon">${ICONS[icon]}</span><div class="callout-body">${inner}</div></div>`;
    }
    return `<blockquote>${this.blocks(lines)}</blockquote>`;
  }

  table(rows, align) {
    const [head, ...body] = rows;
    const cell = (tag, c, j) => `<${tag}${align[j] ? ` style="text-align:${align[j]}"` : ""}>${this.inline(c)}</${tag}>`;
    return [
      '<div class="table-wrap"><table>',
      `<thead><tr>${head.map((c, j) => cell("th", c, j)).join("")}</tr></thead>`,
      `<tbody>${body.map((r) => `<tr>${head.map((_, j) => cell("td", r[j] ?? "", j)).join("")}</tr>`).join("\n")}</tbody>`,
      "</table></div>",
    ].join("\n");
  }

  list(lines, start, cards) {
    const first = LIST_RE.exec(lines[start]);
    const baseIndent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const items = [];
    let loose = false;
    let i = start;
    for (;;) {
      const m = LIST_RE.exec(lines[i]);
      const contentIndent = baseIndent + m[2].length + Math.max(1, m[3].length);
      const body = [m[4]];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === "") {
          body.push("");
          i++;
          continue;
        }
        const indent = /^ */.exec(l)[0].length;
        const afterBlank = body[body.length - 1] === "";
        if (indent >= baseIndent + 2) {
          body.push(l.slice(Math.min(indent, contentIndent)));
          i++;
          continue;
        }
        if (!afterBlank && !isBlockStart(l, lines[i + 1])) {
          body.push(l.trim());
          i++;
          continue;
        }
        break;
      }
      let blanks = 0;
      while (body.length && body[body.length - 1] === "") {
        body.pop();
        blanks++;
      }
      if (body.slice(1).some((l) => l === "")) loose = true;
      items.push(body);
      const next = i < lines.length ? LIST_RE.exec(lines[i]) : null;
      if (next && next[1].length === baseIndent && /\d/.test(next[2]) === ordered) {
        if (blanks > 0) loose = true;
        continue;
      }
      break;
    }

    if (cards) return { html: this.cards(items), next: i };

    const tag = ordered ? "ol" : "ul";
    const n = Number.parseInt(first[2], 10);
    const startAttr = ordered && n !== 1 ? ` start="${n}"` : "";
    const lis = items.map((body) => {
      let html = this.blocks(body);
      if (!loose) html = html.replace(/^<p>([\s\S]*?)<\/p>(?=\n|$)/, "$1");
      return `<li>${html}</li>`;
    });
    return { html: `<${tag}${startAttr}>\n${lis.join("\n")}\n</${tag}>`, next: i };
  }

  cards(items) {
    const cards = items.map((body) => {
      const raw = body.join(" ").trim();
      const m = /^\[([^\]]+)\]\(([^)]+)\)\s*(?:—|:|-)\s*(.*)$/.exec(raw);
      if (!m) throw new Error(`${this.page.slug}.md: a card must be "[Title](link) — description": ${raw}`);
      const [, title, url, desc] = m;
      const key = url.replace(/\.md.*$/, "");
      const icon = ICONS[CARD_ICONS[key] ?? "file"];
      return `<a class="card" href="${escapeHtml(this.href(url))}"><span class="card-icon">${icon}</span><span class="card-title">${this.inline(title)}</span><span class="card-desc">${this.inline(desc)}</span></a>`;
    });
    return `<div class="cards">\n${cards.join("\n")}\n</div>`;
  }

  code(body, info) {
    const { lang, flags, attrs } = parseInfo(info);
    if (flags.has("automation") || flags.has("frontmatter")) {
      this.examples.push({ lang, flags: [...flags], attrs: { ...attrs }, code: body });
    }
    const invalid = attrs.invalid !== undefined;
    const title = attrs.title ? `<span class="code-title">${escapeHtml(attrs.title)}</span>` : "";
    const badge = invalid ? `<span class="code-badge">Refused</span>` : "";
    const header = title || badge ? `<div class="code-head">${title}${badge}</div>` : "";
    const error = invalid
      ? `<div class="code-error"><span class="code-error-icon">${ICONS.x}</span><code>${escapeHtml(attrs.invalid)}</code></div>`
      : "";
    const copy = `<button type="button" class="copy-code" aria-label="Copy code" hidden>${ICONS.copy}</button>`;
    const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    const cls = ["code-block", invalid ? "is-invalid" : "", header ? "has-head" : ""].filter(Boolean).join(" ");
    return `<div class="${cls}">${header}<div class="code-body">${copy}<pre tabindex="0"><code${langClass}>${highlight(body, lang)}</code></pre></div>${error}</div>`;
  }
}

/** Every code example marked `automation` or `frontmatter` in a Markdown text, in order. */
export function extractExamples(markdown) {
  const r = new Renderer({ slug: "example" }, new Set());
  r.render(markdown);
  return r.examples;
}

// ---------------------------------------------------------------------------------------------
// Pages

function readPages() {
  const files = readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".md")).sort();
  const pages = files.map((file) => {
    const text = lf(readFileSync(path.join(CONTENT_DIR, file), "utf8"));
    const { data, body } = splitFrontMatter(text);
    const slug = file.replace(/\.md$/, "");
    for (const key of ["title", "description"]) {
      if (typeof data[key] !== "string" || data[key].trim() === "") {
        throw new Error(`site/content/${file}: front matter needs a ${key}`);
      }
    }
    const group = data.group ?? "";
    if (!GROUPS.includes(group)) throw new Error(`site/content/${file}: unknown group ${JSON.stringify(group)}`);
    return {
      slug,
      file,
      title: data.title,
      nav: data.nav ?? data.title,
      description: data.description,
      group,
      order: Number(data.order ?? 999),
      body: body.replace(/^\n+/, ""),
    };
  });
  return pages;
}

function sortPages(pages) {
  return [...pages].sort(
    (a, b) =>
      GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || a.order - b.order || a.slug.localeCompare(b.slug),
  );
}

/**
 * The skill's SKILL.md and references/*.md as pages, in their own words. SKILL.md takes its title
 * and lead from its frontmatter; a reference takes its title from its `#` heading and its lead
 * from the paragraph under it. Links to those files go to their pages, and links to any other
 * file in the skill go to the copy of it.
 */
function readSkillPages() {
  const files = walkFiles(SKILL_DIR);
  const docs = ["SKILL.md", ...files.filter((f) => /^references\/[^/]+\.md$/.test(f))];
  const slugOf = new Map(docs.map((f) => [f, f === "SKILL.md" ? "skill" : `skill-${path.posix.basename(f, ".md")}`]));

  const resolveFrom = (from) => (url) => {
    if (/^([a-z][\w+.-]*:|#)/i.test(url)) return undefined;
    const [target, hash] = url.split("#");
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(from), target));
    if (rel.startsWith("..")) return undefined;
    const anchor = hash ? `#${hash}` : "";
    return slugOf.has(rel) ? `${slugOf.get(rel)}.html${anchor}` : `${SKILL_OUT}/${rel}${anchor}`;
  };

  return docs.map((file, i) => {
    const raw = lf(readFileSync(path.join(SKILL_DIR, file), "utf8"));
    const { data, body } = splitFrontMatter(raw);
    const lines = body.replace(/^\n+/, "").split("\n");
    const h1 = HEADING_RE.exec(lines[0] ?? "");
    const heading = h1 && h1[1] === "#" ? h1[2] : undefined;
    if (heading !== undefined) lines.shift();
    while (lines[0]?.trim() === "") lines.shift();

    const page = {
      slug: slugOf.get(file),
      file: `${SKILL_OUT}/${file}`,
      group: SKILL_GROUP,
      order: i + 1,
      nav: file,
      raw: `${SKILL_OUT}/${file}`,
      markdown: raw,
      resolveLink: resolveFrom(file),
    };
    if (file === "SKILL.md") {
      for (const key of ["name", "description"]) {
        if (typeof data[key] !== "string" || data[key].trim() === "") throw new Error(`${page.file}: frontmatter needs a ${key}`);
      }
      return { ...page, title: data.name, leadMarkdown: data.description.replace(/\s+/g, " ").trim(), downloads: true, body: lines.join("\n") };
    }
    if (heading === undefined) throw new Error(`${page.file}: needs a # heading`);
    let lead = [];
    if (lines.length && !isBlockStart(lines[0], lines[1])) {
      const end = lines.findIndex((l) => l.trim() === "" || isBlockStart(l));
      lead = lines.splice(0, end < 0 ? lines.length : end);
    }
    return { ...page, title: heading, titleMarkdown: heading, leadMarkdown: lead.join(" "), body: lines.join("\n") };
  });
}

/** The generated download links at the top of the SKILL.md page. */
function skillDownloadsHtml() {
  const files = walkFiles(SKILL_DIR);
  const a = (href, text) => `<a href="${escapeHtml(href)}"><code>${escapeHtml(text)}</code></a>`;
  const items = files.map((f) => `<li>${a(`${SKILL_OUT}/${f}`, f)}</li>`).join("");
  return [
    '<div class="skill-download">',
    `<p>Download: ${a(SKILL_ZIP, path.posix.basename(SKILL_ZIP))} · ${a(`${SKILL_OUT}/SKILL.md`, "SKILL.md")}</p>`,
    `<details><summary>All files (${files.length})</summary><ul>${items}</ul></details>`,
    "</div>",
  ].join("\n");
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A stored (uncompressed) zip with a fixed date, so the same files always give the same bytes. */
export function zipFiles(entries) {
  const DOS_DATE = 0x21; // 1980-01-01
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    parts.push(local, n, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(n.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, n);
    offset += local.length + n.length + data.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

function repository() {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const raw = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url ?? "";
  const url = raw.replace(/^git\+/, "").replace(/\.git$/, "");
  const label = url.replace(/^https?:\/\/github\.com\//, "");
  return { url, label };
}

function navHtml(pages, current) {
  return GROUPS.map((group) => {
    const items = pages
      .filter((p) => p.group === group)
      .map((p) => {
        const here = p.slug === current.slug;
        return `<li><a href="${p.slug}.html"${here ? ' aria-current="page"' : ""}>${escapeHtml(p.nav)}</a></li>`;
      })
      .join("");
    if (!items) return "";
    const label = group ? `<p class="nav-group-label">${escapeHtml(group)}</p>` : "";
    return `<div class="nav-group">${label}<ul>${items}</ul></div>`;
  }).join("");
}

function tocHtml(headings) {
  const items = headings
    .map((h) => `<li class="toc-l${h.level}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
    .join("");
  if (!items) return "";
  return `<nav class="toc" aria-label="On this page"><p class="toc-title">${ICONS.toc}<span>On this page</span></p><ul>${items}</ul></nav>`;
}

function pagerHtml(pages, index) {
  const prev = pages[index - 1];
  const next = pages[index + 1];
  const a = (p, dir) =>
    p
      ? `<a class="pager-${dir}" href="${p.slug}.html" rel="${dir}">${dir === "prev" ? ICONS.chevronLeft : ""}<span class="pager-text"><span class="pager-label">${dir === "prev" ? "Previous" : "Next"}</span><span class="pager-title">${escapeHtml(p.nav)}</span></span>${dir === "next" ? ICONS.chevronRight : ""}</a>`
      : "<span></span>";
  return `<nav class="pager" aria-label="Previous and next page">${a(prev, "prev")}${a(next, "next")}</nav>`;
}

/** What `Copy page` copies and what `<page>.md` contains: the title, the summary, the body. */
function pageMarkdown(page) {
  return `# ${page.title}\n\n> ${page.description}\n\n${page.body.trimEnd()}\n`;
}

function searchSections(page, html) {
  const sections = [];
  const re = /<h([23]) id="([^"]+)">([\s\S]*?)<\/h\1>/g;
  let last = 0;
  let current = { h: "", id: "" };
  const push = (chunk) => {
    const x = stripTags(chunk);
    if (x || current.h) {
      sections.push({ p: page.title, h: current.h, u: `${page.slug}.html${current.id ? `#${current.id}` : ""}`, x: x.slice(0, 1500) });
    }
  };
  let m;
  while ((m = re.exec(html))) {
    push(html.slice(last, m.index));
    current = { h: stripTags(m[3]), id: m[2] };
    last = re.lastIndex;
  }
  push(html.slice(last));
  return sections;
}

function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (all, key) => {
    if (!(key in values)) throw new Error(`template: no value for ${all}`);
    return values[key];
  });
}

function walkFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

/** Every internal link and asset in every page resolves to a file, and every `#id` to an element. */
export function checkLinks(outDir, htmlFiles) {
  const ids = new Map();
  const texts = new Map();
  for (const file of htmlFiles) {
    const html = readFileSync(path.join(outDir, file), "utf8");
    texts.set(file, html);
    ids.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  }
  const problems = [];
  for (const file of htmlFiles) {
    for (const m of texts.get(file).matchAll(/\s(?:href|src)="([^"]+)"/g)) {
      const raw = decodeEntities(m[1]);
      if (/^(https?:|mailto:|data:)/.test(raw)) continue;
      const [target, hash] = raw.split("#");
      const resolved = target === "" ? file : path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
      if (resolved.startsWith("..")) {
        problems.push(`${file}: ${raw} leaves the site`);
        continue;
      }
      let exists = false;
      try {
        exists = statSync(path.join(outDir, resolved)).isFile();
      } catch {
        exists = false;
      }
      if (!exists) {
        problems.push(`${file}: ${raw} does not exist`);
        continue;
      }
      if (hash && resolved.endsWith(".html") && !ids.get(resolved)?.has(hash)) {
        problems.push(`${file}: ${raw} names no element #${hash}`);
      }
    }
  }
  return problems;
}

export function buildSite({ outDir = DEFAULT_OUT, log = () => {} } = {}) {
  const pages = sortPages([...readPages(), ...readSkillPages()]);
  const slugs = new Set(pages.map((p) => p.slug));
  if (slugs.size !== pages.length) throw new Error("two pages have the same slug");
  if (!slugs.has("index")) throw new Error("site/content needs an index.md");
  for (const page of pages) {
    if (page.group !== SKILL_GROUP) continue;
    const r = new Renderer(page, slugs);
    page.titleHtml = page.titleMarkdown === undefined ? escapeHtml(page.title) : r.inline(page.titleMarkdown);
    page.title = stripTags(page.titleHtml);
    page.leadHtml = page.leadMarkdown ? r.inline(page.leadMarkdown) : escapeHtml(page.raw);
    page.description = stripTags(page.leadHtml);
  }
  const template = lf(readFileSync(path.join(SITE_DIR, "template.html"), "utf8"));
  const repo = repository();

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(path.join(outDir, "assets"), { recursive: true });

  const index = [];
  const htmlFiles = [];
  pages.forEach((page, i) => {
    const r = new Renderer(page, slugs);
    let content = r.render(page.body);
    index.push(...searchSections(page, content));
    if (page.downloads) content = `${skillDownloadsHtml()}\n${content}`;
    const markdown = page.markdown ?? pageMarkdown(page);
    const html = fill(template, {
      title: escapeHtml(page.slug === "index" ? `${SITE_TITLE} — ${page.description}` : `${page.title} — ${SITE_TITLE}`),
      description: escapeHtml(page.description),
      siteTitle: escapeHtml(SITE_TITLE),
      repoUrl: escapeHtml(repo.url),
      repoLabel: escapeHtml(repo.label),
      nav: navHtml(pages, page),
      currentNav: escapeHtml(page.nav),
      eyebrow: page.group ? `<p class="eyebrow">${escapeHtml(page.group)}</p>` : "",
      pageTitle: page.titleHtml ?? escapeHtml(page.title),
      lead: page.leadHtml ?? escapeHtml(page.description),
      mdHref: page.raw ?? `${page.slug}.md`,
      content,
      toc: tocHtml(r.headings),
      pager: pagerHtml(pages, i),
      markdownJson: JSON.stringify(markdown).replace(/</g, "\\u003c"),
      iconCopy: ICONS.copy,
      iconCheck: ICONS.check,
      iconChevron: ICONS.chevron,
      iconSearch: ICONS.search,
      iconGithub: ICONS.github,
      iconSun: ICONS.sun,
      iconMoon: ICONS.moon,
      iconMenu: ICONS.menu,
    });
    writeFileSync(path.join(outDir, `${page.slug}.html`), html);
    if (!page.raw) writeFileSync(path.join(outDir, `${page.slug}.md`), markdown);
    htmlFiles.push(`${page.slug}.html`);
    log(`  ${page.slug}.html`);
  });

  for (const asset of readdirSync(ASSETS_DIR).sort()) {
    writeFileSync(path.join(outDir, "assets", asset), lf(readFileSync(path.join(ASSETS_DIR, asset), "utf8")));
  }

  const skillFiles = walkFiles(SKILL_DIR);
  for (const rel of skillFiles) {
    const dst = path.join(outDir, SKILL_OUT, rel);
    mkdirSync(path.dirname(dst), { recursive: true });
    copyFileSync(path.join(SKILL_DIR, rel), dst);
  }
  const zipRoot = path.posix.basename(SKILL_OUT);
  writeFileSync(
    path.join(outDir, SKILL_ZIP),
    zipFiles(skillFiles.map((rel) => ({ name: `${zipRoot}/${rel}`, data: readFileSync(path.join(SKILL_DIR, rel)) }))),
  );

  writeFileSync(
    path.join(outDir, "search-index.js"),
    `window.__SEARCH_INDEX__=${JSON.stringify(index).replace(/</g, "\\u003c")};\n`,
  );

  const llms = [
    `# ${SITE_TITLE}`,
    "",
    `> ${SITE_TAGLINE} An automation is a folder with an AUTOMATION.md: YAML frontmatter that says when an agent runs and what runs before and after it, and a Markdown body that is the prompt for each run. Draft 0.2.`,
    "",
    "## Docs",
    "",
    ...pages.filter((p) => !p.raw).map((p) => `- [${p.title}](${p.slug}.md): ${p.description}`),
    "",
    `## ${SKILL_GROUP}`,
    "",
    ...pages.filter((p) => p.raw).map((p) => `- [${p.title}](${p.raw})${p.downloads ? `: ${p.leadMarkdown}` : ""}`),
    `- [${path.posix.basename(SKILL_ZIP)}](${SKILL_ZIP})`,
    "",
  ].join("\n");
  writeFileSync(path.join(outDir, "llms.txt"), llms);

  const problems = checkLinks(outDir, htmlFiles);
  if (problems.length > 0) throw new Error(`broken links:\n  ${problems.join("\n  ")}`);
  return { pages: pages.map((p) => p.slug), files: walkFiles(outDir) };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const at = process.argv.indexOf("--out");
  const outDir = at > 0 ? path.resolve(process.argv[at + 1]) : DEFAULT_OUT;
  try {
    const { files } = buildSite({ outDir, log: (l) => console.log(l) });
    console.log(`site: ${files.length} files in ${path.relative(process.cwd(), outDir) || "."}`);
  } catch (e) {
    console.error(`site: ${e.message}`);
    process.exit(1);
  }
}
