let invocations = 0;

export default function extension(pi) {
  const instance = ++invocations;
  let disposed = false;
  pi.events.emit("pi-automations-lifecycle-probe", { event: "factory", instance });
  pi.on("session_start", () => {
    pi.events.emit("pi-automations-lifecycle-probe", { event: "start", instance, disposed });
  });
  pi.on("session_shutdown", () => {
    disposed = true;
    pi.events.emit("pi-automations-lifecycle-probe", { event: "shutdown", instance, disposed });
  });
}
