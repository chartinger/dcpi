import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Container } from "./docker.js";

export interface SavedContainerConfig {
  workspace: string;
  extensions: string[];
}

interface DcpiConfig {
  containers: Record<string, unknown>;
}

function configPath(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "dcpi", "containers.json");
}

function containerConfigKey(container: Container): string {
  return `${container.identity}\u0000${container.remoteUser ?? ""}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSavedContainerConfig(value: unknown): value is SavedContainerConfig {
  return (
    isRecord(value) &&
    typeof value.workspace === "string" &&
    value.workspace.startsWith("/") &&
    Array.isArray(value.extensions) &&
    value.extensions.every((extension) => typeof extension === "string")
  );
}

async function readConfig(): Promise<DcpiConfig> {
  try {
    const raw: unknown = JSON.parse(await readFile(configPath(), "utf8"));
    if (!isRecord(raw) || !isRecord(raw.containers)) return { containers: {} };
    return { containers: raw.containers };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { containers: {} };
    throw new Error(
      `Could not read dcpi configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function savedConfig(container: Container): Promise<SavedContainerConfig | undefined> {
  const saved = (await readConfig()).containers[containerConfigKey(container)];
  return isSavedContainerConfig(saved) ? saved : undefined;
}

export async function saveConfig(container: Container, saved: SavedContainerConfig): Promise<void> {
  const config = await readConfig();
  config.containers[containerConfigKey(container)] = saved;
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}
