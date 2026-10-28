/** The hooks half of the SDK denial. */

let marker = "PORTABLE-SDK-DENIED";
let pattern = /(^|[\\/])@earendil-works[\\/]|pi-coding-agent|pi-tui/;

export async function initialize(data) {
  if (data?.marker) marker = data.marker;
  if (data?.pattern) pattern = new RegExp(data.pattern);
}

function refuse(what, how) {
  const e = new Error(`${marker}: refused to ${how} ${what}`);
  e.code = "ERR_MODULE_DENIED";
  throw e;
}

const isUrl = (s) => /^[a-z][a-z0-9+.-]*:/i.test(s);

export async function resolve(specifier, context, nextResolve) {
  if (!isUrl(specifier) && pattern.test(specifier)) refuse(specifier, "resolve");
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (pattern.test(decodeURIComponent(url))) refuse(url, "load");
  return nextLoad(url, context);
}
