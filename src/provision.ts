import { access, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import {
  containerExec,
  containerExecStreaming,
  docker,
  type Container,
  shQuote,
} from "./docker.js";

export interface TargetInfo {
  home: string;
  nodeVersion: string;
  npmVersion: string;
  uid: string;
  gid: string;
}

function hostPiDirectory(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export interface PiExtension {
  name: string;
  source: string;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isJsTsFile(path: string): boolean {
  return path.endsWith(".ts") || path.endsWith(".js");
}

/** Resolve a package's name, preferring its declared `package.json` name. */
async function packageName(dir: string): Promise<string> {
  try {
    const manifest: unknown = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    const name = (manifest as { name?: unknown }).name;
    if (typeof name === "string" && name) return name;
  } catch {
    // Ignore unreadable or invalid package.json
  }
  return dir.split("/").pop() ?? dir;
}

async function settingsPackages(): Promise<string[]> {
  const settingsPath = join(hostPiDirectory(), "settings.json");
  try {
    const manifest: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
    const packages = (manifest as { packages?: unknown }).packages;
    if (!Array.isArray(packages)) return [];
    return packages
      .map((entry) => (typeof entry === "string" ? entry : (entry as { source?: unknown }).source))
      .filter((entry): entry is string => typeof entry === "string");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function resolvePackageDir(source: string): Promise<string | undefined> {
  if (source.startsWith("npm:")) {
    const spec = source.slice("npm:".length).trim();
    const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@.+)?$/);
    const name = match ? match[1] : spec;
    const dir = join(hostPiDirectory(), "npm", "node_modules", name);
    return (await isDirectory(dir)) ? dir : undefined;
  }
  if (source.startsWith("git:") || source.startsWith("github:")) return undefined;
  const resolved = resolve(hostPiDirectory(), source);
  return (await isDirectory(resolved)) ? resolved : undefined;
}

export function resolveSavedExtensions(names: string[], discovered: PiExtension[]): PiExtension[] {
  const byName = new Map(discovered.map((extension) => [extension.name, extension]));
  const resolved = new Map<string, PiExtension>();
  const missing: string[] = [];
  for (const name of names) {
    const found = byName.get(name);
    if (found === undefined) {
      missing.push(name);
      continue;
    }
    const existing = resolved.get(found.name);
    if (existing === undefined || existing.source === found.source) resolved.set(found.name, found);
  }
  if (missing.length > 0)
    console.log(`Not found, skipping saved extensions: ${missing.join(", ")}`);
  return [...resolved.values()];
}

export async function inspectTarget(container: Container): Promise<TargetInfo> {
  const output = await containerExec(
    container,
    'set -eu; command -v node >/dev/null; command -v npm >/dev/null; printf \'%s\\n%s\\n%s\\n%s\\n%s\\n\' "$HOME" "$(node --version)" "$(npm --version)" "$(id -u)" "$(id -g)"',
  );
  const [home, nodeVersion, npmVersion, uid, gid] = output.trim().split("\n");
  if (!home || !nodeVersion || !npmVersion || !uid || !gid) {
    throw new Error("Could not determine the container user's Node/npm environment.");
  }
  return { home, nodeVersion, npmVersion, uid, gid };
}

export async function hasCommand(container: Container, command: string): Promise<boolean> {
  const result = await containerExec(
    container,
    `if command -v ${shQuote(command)} >/dev/null 2>&1; then printf yes; else printf no; fi`,
  );
  return result.trim() === "yes";
}

export type PackageManager = "apt-get" | "apk" | "dnf";

export async function packageManager(container: Container): Promise<PackageManager | undefined> {
  const result = await containerExec(
    container,
    'for command in apt-get apk dnf; do if command -v "$command" >/dev/null 2>&1; then printf \'%s\' "$command"; exit 0; fi; done',
  );
  const manager = result.trim();
  return manager === "apt-get" || manager === "apk" || manager === "dnf" ? manager : undefined;
}

export async function installTmux(container: Container, manager: PackageManager): Promise<void> {
  const command = {
    "apt-get": "export DEBIAN_FRONTEND=noninteractive; apt-get update; apt-get install -y tmux",
    apk: "apk add --no-cache tmux",
    dnf: "dnf install -y tmux",
  }[manager];
  console.log(`Installing tmux with ${manager}...`);
  await containerExecStreaming(container, command, "0");
}

export async function findPi(
  container: Container,
  target: TargetInfo,
): Promise<string | undefined> {
  const managedPi = `${target.home}/.pi/agent/runtime/node_modules/.bin/pi`;
  const result = await containerExec(
    container,
    `if test -x ${shQuote(managedPi)}; then printf '%s' ${shQuote(managedPi)}; elif command -v pi >/dev/null 2>&1; then command -v pi; fi`,
  );
  return result.trim() || undefined;
}

export async function installPi(container: Container, target: TargetInfo): Promise<string> {
  const existingPi = await findPi(container, target);
  if (existingPi) return existingPi;

  const runtimeDirectory = `${target.home}/.pi/agent/runtime`;
  const piBinary = `${runtimeDirectory}/node_modules/.bin/pi`;
  console.log("Installing Pi...");
  await containerExecStreaming(
    container,
    `npm install --ignore-scripts --prefix ${shQuote(runtimeDirectory)} @earendil-works/pi-coding-agent`,
  );
  return piBinary;
}

async function runInteractive(container: Container, command: string): Promise<void> {
  const args = ["exec", "--interactive", "--tty"];
  if (container.remoteUser) args.push("--user", container.remoteUser);
  args.push(container.id, "sh", "-lc", command);

  await new Promise<void>((resolve, reject) => {
    const child = spawn("docker", args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Pi exited with code ${code ?? "unknown"}.`));
    });
  });
}

export async function startPi(
  container: Container,
  workspace: string,
  piBinary: string,
  useTmux: boolean,
): Promise<void> {
  const piCommand = shQuote(piBinary);
  const command = useTmux
    ? `tmux has-session -t dcpi-pi 2>/dev/null || tmux new-session -d -s dcpi-pi -c ${shQuote(workspace)} ${shQuote(piCommand)}; exec tmux attach-session -t dcpi-pi`
    : `cd ${shQuote(workspace)}; exec ${piCommand}`;
  await runInteractive(container, command);
}

export async function copyIntoContainer(
  container: Container,
  target: TargetInfo,
  selectedExtensions: PiExtension[],
  copyAuth: boolean,
): Promise<void> {
  const piDirectory = `${target.home}/.pi`;
  const stateDirectory = `${piDirectory}/agent`;
  const extensionsDirectory = `${stateDirectory}/extensions`;
  console.log(`Preparing ${stateDirectory}...`);
  await containerExec(
    container,
    `umask 077; mkdir -p ${shQuote(piDirectory)} ${shQuote(extensionsDirectory)}; chown ${target.uid}:${target.gid} ${shQuote(piDirectory)}; chown -R ${target.uid}:${target.gid} ${shQuote(stateDirectory)}; chmod 700 ${shQuote(stateDirectory)} ${shQuote(extensionsDirectory)}`,
    "0",
  );

  for (const extension of selectedExtensions) {
    console.log(`Copying extension: ${extension.name}`);
    await docker(["cp", extension.source, `${container.id}:${extensionsDirectory}/`]);
    await containerExec(
      container,
      `chown -R ${target.uid}:${target.gid} ${shQuote(join(extensionsDirectory, extension.name))}`,
      "0",
    );
  }

  if (copyAuth) {
    const source = join(hostPiDirectory(), "auth.json");
    await access(source);
    const destination = `${stateDirectory}/auth.json`;
    console.log("Copying auth.json...");
    await docker(["cp", source, `${container.id}:${destination}`]);
    await containerExec(
      container,
      `chown ${target.uid}:${target.gid} ${shQuote(destination)}; chmod 600 ${shQuote(destination)}`,
      "0",
    );
  }
}

export async function extensions(): Promise<PiExtension[]> {
  const registered = new Map<string, string>();
  const extensionsDirectory = join(hostPiDirectory(), "extensions");
  try {
    const entries = await readdir(extensionsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() || (entry.isFile() && isJsTsFile(entry.name))) {
        registered.set(entry.name, join(extensionsDirectory, entry.name));
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const source of await settingsPackages()) {
    const packageDirectory = await resolvePackageDir(source);
    if (!packageDirectory) continue;
    const name = await packageName(packageDirectory);
    if (name === "" || name === "." || name === "..") continue;
    if (!registered.has(name)) registered.set(name, packageDirectory);
  }
  return [...registered.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, source]) => ({ name, source }));
}
