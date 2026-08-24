import { App, Notice } from "obsidian";

/**
 * Bridge to the GridSense plugin — "New grid" in the toolbox panel.
 *
 * GridSense is a separate plugin, so this is a hand-off, not an integration:
 * we run its own "Open grid for folder…" command (which puts up its folder
 * picker) and otherwise explain, precisely, why we couldn't. Three different
 * things can be wrong and they need three different fixes, so they get three
 * different messages — "GridSense isn't installed" is unhelpful and wrong when
 * the plugin is sitting there disabled.
 *
 * Nothing here imports from GridSense: the only coupling is its plugin id and
 * command id, both checked at runtime, so Bases Toolbox neither depends on it
 * nor breaks when it's absent.
 */

const GRIDSENSE_ID = "gridsense";
/** GridSense's own command — opens its folder picker, then the grid. */
const OPEN_GRID_COMMAND = `${GRIDSENSE_ID}:open-grid-for-folder`;

/** `app.plugins` and `app.commands` are undocumented — narrow casts, as
 * elsewhere in this plugin. */
interface AppInternals {
  plugins?: {
    /** Enabled plugins, by id. */
    plugins?: Record<string, unknown>;
    /** Every INSTALLED plugin's manifest, by id — present while disabled. */
    manifests?: Record<string, unknown>;
  };
  commands?: {
    executeCommandById: (id: string) => boolean | void;
    commands?: Record<string, unknown>;
  };
}

export type GridSenseState = "missing" | "disabled" | "ready";

/** Whether GridSense is installed, and if so whether it's switched on. */
export function gridSenseState(app: App): GridSenseState {
  const { plugins } = app as unknown as AppInternals;
  if (plugins?.plugins?.[GRIDSENSE_ID]) return "ready";
  if (plugins?.manifests?.[GRIDSENSE_ID]) return "disabled";
  return "missing";
}

/**
 * Open GridSense's "new grid" flow, or say why we can't. Returns false when
 * nothing was opened, so callers can skip any follow-up of their own.
 */
export function openNewGrid(app: App): boolean {
  const state = gridSenseState(app);
  if (state === "missing") {
    new Notice(
      "Grids come from the GridSense plugin, which isn't installed. Install it from Settings → Community plugins (search “GridSense”), then try again.",
      10000
    );
    return false;
  }
  if (state === "disabled") {
    new Notice(
      "GridSense is installed but turned off. Enable it under Settings → Community plugins, then try again.",
      10000
    );
    return false;
  }

  const internals = app as unknown as AppInternals;
  // Enabled but the command is gone = GridSense renamed or dropped it. Say so
  // rather than silently doing nothing, which is what executeCommandById would
  // otherwise give us.
  if (internals.commands?.commands && !internals.commands.commands[OPEN_GRID_COMMAND]) {
    new Notice(
      "GridSense is enabled, but its “Open grid for folder” command wasn't found — it may have changed in a newer version. Open a grid from GridSense itself.",
      10000
    );
    return false;
  }
  internals.commands?.executeCommandById(OPEN_GRID_COMMAND);
  return true;
}
