/**
 * Browser ids, `<name>.<8 hex>`: the name for readability, a hash of the full automation key so a user and a
 * repository automation with one name stay apart. Invalid automations are named after any folder, hence the clean-up.
 */

/** 32-bit FNV-1a over UTF-8, the hash pi-automations staggers schedules with. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(text, 'utf8')) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function managerId(key: string): string {
  const name = key.slice(key.lastIndexOf(':') + 1);
  const safe =
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'automation';
  return `${safe}.${fnv1a(key).toString(16).padStart(8, '0')}`;
}

/** The editor page for an automation, relative to the server's URL. */
export function editorPath(key: string): string {
  return `/automations/${managerId(key)}`;
}
