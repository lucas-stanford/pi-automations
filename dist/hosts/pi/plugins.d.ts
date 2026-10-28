/** The plugins this host loads, composed with pi's services. Used by pi, workers and `pa` alike. */
import { type LoadedPlugins } from "../../plugins/loader.js";
import type { HostServices, PluginWhere } from "../../plugins/types.js";
import type { Config } from "../../types.js";
export declare function piHostServices(args: {
    stateDir: string;
    cwd: () => string;
}): HostServices;
/** The plugins `config.plugins` names, or none — without touching the disk when there are none. */
export declare function loadConfiguredPlugins(args: {
    config: Pick<Config, "plugins">;
    stateDir: string;
    where: PluginWhere;
    cwd: () => string;
}): Promise<LoadedPlugins>;
