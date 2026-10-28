// `e`, `pa edit` and plugin actions, routed the same way from pi and from `pa`.

import path from "node:path";

import type { Status } from "../types.js";
import { chooseEditor, describeEditor, openInEditor, type EditorChoice } from "./editor.js";
import type { LoadedPlugins } from "./loader.js";
import type { ActionTarget } from "./types.js";

export interface ActionOutcome {
  lines: string[];
  exitCode?: number;
  /** A plugin keeps serving after its action returned: `pa` stays in the foreground. */
  keepAlive?: boolean;
  url?: string;
}

export function actionTarget(s: Pick<Status, "key" | "name" | "scope" | "dir">): ActionTarget {
  return { key: s.key, name: s.name, scope: s.scope, dir: s.dir, file: path.join(s.dir, "AUTOMATION.md") };
}

/** What `e` does here, in the words of the list's menu. */
export function editLabel(plugins: LoadedPlugins): { label: string; why: string } {
  const plugin = plugins.action("edit");
  if (plugin) {
    return { label: plugin.action.label, why: plugin.action.description ?? `${plugin.action.label}.` };
  }
  return { label: "Edit AUTOMATION.md", why: "Open its AUTOMATION.md in your editor." };
}

export async function runAction(args: {
  id: string;
  plugins: LoadedPlugins;
  status?: Pick<Status, "key" | "name" | "scope" | "dir">;
  where: "cli" | "host";
  open?: boolean;
  /** Tests choose the editor; everyone else gets `chooseEditor`. */
  editor?: (file: string) => EditorChoice;
  openEditor?: (choice: EditorChoice, file: string) => Promise<string | undefined>;
}): Promise<ActionOutcome> {
  const target = args.status ? actionTarget(args.status) : undefined;
  if (args.plugins.action(args.id)) {
    const { result, problem } = await args.plugins.runAction(args.id, {
      ...(target ? { automation: target } : {}),
      where: args.where,
      open: args.open ?? true,
    });
    if (problem) return { lines: [`plugin ${problem}`], exitCode: 2 };
    return {
      lines: [result?.message ?? (result?.url ? `${args.id}: ${result.url}` : `${args.id}: done`)],
      ...(result?.keepAlive ? { keepAlive: true } : {}),
      ...(result?.url ? { url: result.url } : {}),
    };
  }
  if (args.id !== "edit") return { lines: [`no plugin adds ${args.id}`], exitCode: 1 };
  if (!target) return { lines: ["edit needs an automation: edit <name>"], exitCode: 1 };
  const choice = args.editor?.(target.file) ?? chooseEditor({ file: target.file, where: args.where });
  const failed = await (args.openEditor ?? openInEditor)(choice, target.file);
  if (failed) return { lines: [`could not open ${target.file}: ${failed}`], exitCode: 2 };
  return { lines: [`${choice.kind === "command" ? "edited" : "opened"} ${target.name}'s AUTOMATION.md in ${describeEditor(choice)}`] };
}
