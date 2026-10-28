/**
 * What only pi-automations' own pages and skill may say: its `pa` command, its `/automations`
 * command, its name, pi itself, and the reporting names it adds. Tuned so that `pass`, `pages`,
 * `.agents/automations/` and `pi.dev` in a URL do not count.
 */
export const PI_ONLY: readonly RegExp[] = [
  /(?<![\w/.-])pa(?![\w-])/,
  /(?<![\w.~-])\/automations\b/,
  /pi-automations/i,
  /(?<![\w./-])pi(?![\w-])/,
  /NOT_AN_EDGE|AUTOMATION_RUN\b|AUTOMATION_STATE_DIR|AUTOMATION_NODE|Automation Manager/,
];

export function mentionsPi(text: string): boolean {
  return PI_ONLY.some((re) => re.test(text));
}
