/** The plugins this host loads, composed with pi's services. Used by pi, workers and `pa` alike. */
import { createHostServices } from "../../plugins/host.js";
import { loadPlugins, NO_PLUGINS } from "../../plugins/loader.js";
import { createPiServices } from "./compose.js";
export function piHostServices(args) {
    const services = createPiServices();
    return createHostServices({
        stateDir: args.stateDir,
        cwd: args.cwd,
        models: {
            resolver: () => services.modelResolver(),
            choices: (cwd) => services.modelChoices(cwd),
        },
    });
}
/** The plugins `config.plugins` names, or none — without touching the disk when there are none. */
export function loadConfiguredPlugins(args) {
    const entries = args.config.plugins ?? [];
    if (entries.length === 0)
        return Promise.resolve(NO_PLUGINS);
    return loadPlugins({
        entries,
        where: args.where,
        host: () => piHostServices({ stateDir: args.stateDir, cwd: args.cwd }),
    });
}
//# sourceMappingURL=plugins.js.map