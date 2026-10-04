import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  configDir: string;
  configFile: string;
  tasks: string;
  stateDir: string;
  taskState: string;
  locks: string;
  runs: string;
  journal: string;
  stopFile: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = homedir();
  const configDir = env.ROUTINE_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "routine");
  const stateDir = env.ROUTINE_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "routine");
  return {
    configDir,
    configFile: join(configDir, "config.yaml"),
    tasks: join(configDir, "tasks"),
    stateDir,
    taskState: join(stateDir, "tasks"),
    locks: join(stateDir, "locks"),
    runs: join(stateDir, "runs"),
    journal: join(stateDir, "journal.jsonl"),
    stopFile: join(stateDir, "STOPPED"),
  };
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
