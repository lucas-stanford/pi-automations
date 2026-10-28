// The HTML report: self-contained (inline CSS, no script), grouped like the listing.
import { summaryLine } from "./summary.js";
import { formatDuration } from "./duration.js";
import { scheduleText } from "./listing.js";
import { tildify } from "./paths.js";
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
const CSS = `
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.5rem 4rem;
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: Canvas; color: CanvasText;
  }
  main { max-width: 68rem; margin: 0 auto; }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
  .meta { opacity: .65; font-size: .85rem; margin-bottom: 2rem; }
  h2 {
    font-size: .78rem; text-transform: uppercase; letter-spacing: .09em;
    opacity: .6; margin: 2.25rem 0 .6rem; font-weight: 600;
  }
  h2 .path { text-transform: none; letter-spacing: 0; opacity: .75; font-weight: 400; }
  hr { border: 0; border-top: 1px solid; opacity: .18; margin: 2.5rem 0 0; }
  table { width: 100%; border-collapse: collapse; margin-bottom: .5rem; }
  th, td { text-align: left; padding: .4rem .6rem; vertical-align: top; }
  th { font-size: .72rem; text-transform: uppercase; letter-spacing: .07em; opacity: .55; }
  tbody tr { border-top: 1px solid; border-color: color-mix(in srgb, CanvasText 12%, transparent); }
  td.name { font-weight: 600; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, "Cascadia Code", Consolas, monospace; font-size: .86em; }
  .state { font-size: .78rem; padding: .1rem .45rem; border-radius: 999px; white-space: nowrap;
           border: 1px solid; border-color: color-mix(in srgb, CanvasText 25%, transparent); }
  .state.armed { border-color: color-mix(in srgb, #16a34a 60%, transparent); }
  .state.off, .state.disabled { opacity: .7; }
  .state.invalid { border-color: color-mix(in srgb, #dc2626 60%, transparent); }
  .reason { opacity: .75; font-size: .87rem; padding-left: .6rem; }
  details { margin: .35rem 0 1.25rem; }
  summary { cursor: pointer; font-size: .85rem; opacity: .7; }
  .runs { margin-top: .5rem; font-size: .87rem; }
  .runs td { padding: .25rem .6rem; }
  .ok { color: #16a34a; } .failed { color: #dc2626; }
  .skipped, .missed, .aborted { opacity: .7; }
  .empty { opacity: .6; font-style: italic; padding: .4rem .6rem; }
  /* fm's flowchart. The SVG is an opaque light card (fm has no theme option), so it sits on its
     own rounded panel rather than blending into a dark page and looking like a rendering fault. */
  .flow { margin: .6rem 0; padding: .5rem; border-radius: 8px; background: #fff; overflow-x: auto; }
  .flow svg { display: block; max-width: 100%; height: auto; }
  .flow-list { margin: .6rem 0; padding: .5rem; border-radius: 8px; overflow-x: auto; font-size: .85rem; }
  .flow-note { opacity: .6; font-style: italic; padding: .4rem .6rem; }
`;
function stateCell(s) {
    return `<span class="state ${s.state}">${s.state}</span>`;
}
function runsTable(records) {
    if (records.length === 0)
        return `<div class="empty">no runs recorded</div>`;
    const rows = records
        .slice()
        .reverse()
        .map((r) => {
        const when = (r.endedAt ?? r.startedAt ?? r.recordedAt).replace("T", " ").slice(0, 16);
        const duration = r.startedAt && r.endedAt
            ? formatDuration(Date.parse(r.endedAt) - Date.parse(r.startedAt))
            : "—";
        // The same sentence every other surface shows — what the run said, or why it did not run.
        const detail = summaryLine(r, 200);
        const count = r.count && r.count > 1 ? ` ×${r.count}` : "";
        return `<tr>
        <td class="mono">${escapeHtml(when)}</td>
        <td class="${r.outcome}">${escapeHtml(r.outcome)}${escapeHtml(count)}</td>
        <td class="mono">${escapeHtml(duration)}</td>
        <td class="mono">${escapeHtml(r.model ?? "—")}</td>
        <td>${escapeHtml(detail)}</td>
      </tr>`;
    })
        .join("\n");
    return `<table class="runs">
    <thead><tr><th>when</th><th>outcome</th><th>took</th><th>model</th><th>detail</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}
function group(title, path, statuses, recordsByKey, home, flowSvgFor) {
    const header = `<h2>${escapeHtml(title)} <span class="path">· ${escapeHtml(tildify(path, home))}</span></h2>`;
    if (statuses.length === 0) {
        return `${header}<div class="empty">none</div>`;
    }
    const rows = statuses
        .map((s) => {
        const schedule = scheduleText(s);
        const hooks = s.automation
            ? `${s.automation.hooks.pre.length} / ${s.automation.hooks.post.length}`
            : "—";
        const reason = s.reason
            ? `<tr><td></td><td colspan="4" class="reason">${escapeHtml(s.reason)}</td></tr>`
            : "";
        const runs = recordsByKey[s.key] ?? [];
        return `<tr>
          <td class="name">${escapeHtml(s.name)}</td>
          <td>${stateCell(s)}</td>
          <td class="mono">${escapeHtml(schedule)}</td>
          <td class="mono">${escapeHtml(s.nextFire ?? (s.nextCheck ? `check ${s.nextCheck}` : "—"))}</td>
          <td class="mono">${escapeHtml(hooks)}</td>
        </tr>
        ${reason}
        <tr><td colspan="5"><details><summary>last ${runs.length} run${runs.length === 1 ? "" : "s"}</summary>${runsTable(runs)}${flowBlock(runs[0], flowSvgFor)}</details></td></tr>`;
    })
        .join("\n");
    return `${header}<table>
    <thead><tr><th>name</th><th>state</th><th>schedule</th><th>next</th><th>hooks pre/post</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}
/** The run's flowchart inlined (not linked), then what it published. */
function flowBlock(record, flowSvgFor) {
    const notes = notesBlock(record);
    if (!record?.steps || !flowSvgFor)
        return notes;
    let art;
    try {
        art = flowSvgFor(record);
    }
    catch {
        art = undefined;
    }
    if (art?.svg) {
        // The wrapper keeps the opaque card from touching the surrounding text.
        return `<div class="flow">${art.svg}</div>${notes}`;
    }
    if (art?.md) {
        return `<pre class="flow-list">${escapeHtml(art.md)}</pre>${notes}`;
    }
    return `<div class="flow-note">flowchart not available</div>${notes}`;
}
// A run's message, then its notes, each with its links. Only http(s) links are ever recorded, so
// every href is one.
function notesBlock(record) {
    const notes = [...(record?.message ? [{ ...record.message, lead: "Message: " }] : []), ...(record?.notes ?? []).map((n) => ({ ...n, lead: "" }))];
    if (notes.length === 0)
        return "";
    const items = notes
        .map((n) => {
        const links = n.links
            .filter((l) => /^https?:\/\//i.test(l.url))
            .map((l) => `<a href="${escapeHtml(l.url)}">${escapeHtml(l.label ?? l.url)}</a>`)
            .join(" · ");
        return `<li>${n.lead ? `<strong>${escapeHtml(n.lead)}</strong>` : ""}${escapeHtml(n.text)}${links ? ` — ${links}` : ""}</li>`;
    })
        .join("");
    return `<ul class="notes">${items}</ul>`;
}
export function renderReport(statuses, recordsByKey, config, now, opts) {
    const user = statuses.filter((s) => s.scope === "user");
    const project = statuses.filter((s) => s.scope === "repository");
    const userRoots = [...new Set(user.map((s) => s.root.path))].sort();
    const projectRoots = [...new Set(project.map((s) => s.root.path))].sort();
    const sections = [];
    if (userRoots.length === 0) {
        sections.push(group("User", `${opts.home}/.agents/automations`, [], recordsByKey, opts.home, opts.flowSvgFor));
    }
    else {
        for (const root of userRoots) {
            sections.push(group("User", root, user.filter((s) => s.root.path === root), recordsByKey, opts.home, opts.flowSvgFor));
        }
    }
    if (projectRoots.length > 0) {
        sections.push("<hr>");
        for (const root of projectRoots) {
            sections.push(group("Repository", root, project.filter((s) => s.root.path === root), recordsByKey, opts.home, opts.flowSvgFor));
        }
    }
    const counts = {
        armed: statuses.filter((s) => s.state === "armed").length,
        off: statuses.filter((s) => s.state === "off").length,
        disabled: statuses.filter((s) => s.state === "disabled").length,
        invalid: statuses.filter((s) => s.state === "invalid").length,
    };
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Agent Automations — ${escapeHtml(now.toISOString().slice(0, 10))}</title>
<style>${CSS}</style>
</head>
<body>
<main>
  <h1>Agent Automations</h1>
  <div class="meta">
    ${escapeHtml(now.toISOString())} ·
    ${counts.armed} armed · ${counts.off} off · ${counts.disabled} disabled · ${counts.invalid} invalid ·
    grace ${escapeHtml(config.grace)} · default timeout ${escapeHtml(config.defaultTimeout)}
  </div>
  ${sections.join("\n")}
</main>
</body>
</html>
`;
}
/** The command that opens a file. Not `cmd /c start`, which would interpret `&` in a path. */
export function openCommand(file, platform = process.platform) {
    if (platform === "darwin")
        return { file: "open", args: [file] };
    if (platform === "win32")
        return { file: "explorer.exe", args: [file] };
    return { file: "xdg-open", args: [file] };
}
//# sourceMappingURL=report.js.map