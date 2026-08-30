#!/usr/bin/env node

import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { execFile, spawn } from "node:child_process";
import { access, chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify, styleText } from "node:util";

const execFileAsync = promisify(execFile);

interface Container {
  id: string;
  name: string;
  identity: string;
  workspace: string | undefined;
  remoteUser: string | undefined;
}

interface SavedContainerConfig {
  workspace: string;
  extensions: string[];
}

interface DcpiConfig {
  containers: Record<string, unknown>;
}

interface ContainerInspect {
  Id: string;
  Name: string;
  Config: { Labels?: Record<string, string>; User?: string };
}

interface DevContainerMetadata {
  remoteUser?: string;
  workspaceFolder?: string;
}

interface TargetInfo {
  home: string;
  nodeVersion: string;
  npmVersion: string;
  uid: string;
  gid: string;
}

function hostPiDirectory(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
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

async function savedConfig(container: Container): Promise<SavedContainerConfig | undefined> {
  const saved = (await readConfig()).containers[containerConfigKey(container)];
  return isSavedContainerConfig(saved) ? saved : undefined;
}

async function saveConfig(container: Container, saved: SavedContainerConfig): Promise<void> {
  const config = await readConfig();
  config.containers[containerConfigKey(container)] = saved;
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function withEscape<T>(prompt: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onData = (data: Buffer) => {
    if (data.length === 1 && data[0] === 0x1b) controller.abort();
  };
  process.stdin.on("data", onData);
  try {
    return await prompt(controller.signal);
  } finally {
    process.stdin.off("data", onData);
  }
}

function isCancellation(error: unknown): boolean {
  return (
    error instanceof Error &&
    ["AbortPromptError", "CancelPromptError", "ExitPromptError"].includes(error.name)
  );
}

function selectionKeysHelp(keys: [string, string][]): string {
  const hints = [...keys, ["Esc", "cancel"] as [string, string]];
  return hints
    .map(([key, action]) => `${styleText("bold", key)} ${styleText("dim", action)}`)
    .join(styleText("dim", " • "));
}

async function docker(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("docker", args, { encoding: "utf8" });
    return stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code === "ENOENT") {
      throw new Error("Docker is not installed or is not available on PATH.");
    }
    const detail = failure.stderr?.trim() || failure.message;
    throw new Error(`Docker command failed: docker ${args.join(" ")}\n${detail}`);
  }
}

async function dockerStreaming(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("docker", args, { stdio: "inherit" });
    child.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("Docker is not installed or is not available on PATH."));
      } else {
        reject(error);
      }
    });
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Docker command failed: docker ${args.join(" ")}`));
    });
  });
}

function metadata(raw: string | undefined): DevContainerMetadata {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    const entries = Array.isArray(value) ? value : [value];
    return entries.reduce<DevContainerMetadata>((result, entry) => {
      if (entry && typeof entry === "object") {
        const item = entry as DevContainerMetadata;
        return { ...result, ...item };
      }
      return result;
    }, {});
  } catch {
    return {};
  }
}

function isDevContainer(labels: Record<string, string>): boolean {
  return "devcontainer.local_folder" in labels || "devcontainer.metadata" in labels;
}

async function containers(): Promise<Container[]> {
  const ids = (await docker(["ps", "--quiet"])).split("\n").filter(Boolean);
  const found: Container[] = [];

  for (const id of ids) {
    const raw = await docker(["inspect", id]);
    const [inspect] = JSON.parse(raw) as ContainerInspect[];
    const labels = inspect.Config.Labels ?? {};
    if (!isDevContainer(labels)) continue;

    const info = metadata(labels["devcontainer.metadata"]);
    found.push({
      id: inspect.Id,
      name: inspect.Name.replace(/^\//, ""),
      identity: labels["devcontainer.local_folder"] ?? inspect.Name.replace(/^\//, ""),
      workspace: info.workspaceFolder ?? labels["devcontainer.local_folder"],
      remoteUser: (info.remoteUser ?? inspect.Config.User) || undefined,
    });
  }

  return found.sort((a, b) => a.name.localeCompare(b.name));
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function containerExec(
  container: Container,
  command: string,
  user = container.remoteUser,
): Promise<string> {
  const args = ["exec"];
  if (user) args.push("--user", user);
  args.push(container.id, "sh", "-lc", command);
  return docker(args);
}

async function containerExecStreaming(
  container: Container,
  command: string,
  user = container.remoteUser,
): Promise<void> {
  const args = ["exec"];
  if (user) args.push("--user", user);
  args.push(container.id, "sh", "-lc", command);
  await dockerStreaming(args);
}

async function inspectTarget(container: Container): Promise<TargetInfo> {
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

async function chooseWorkspace(container: Container, previous?: string): Promise<string> {
  if (container.workspace?.startsWith("/")) return container.workspace;
  const name = (container.workspace ?? container.name).split(/[\\/]/).filter(Boolean).at(-1);
  return withEscape((signal) =>
    input(
      {
        message: "Container workspace directory (Esc to cancel)",
        default: previous ?? `/workspaces/${name ?? container.name}`,
        validate: (value) =>
          value.startsWith("/") ? true : "Workspace must be an absolute container path.",
      },
      { signal },
    ),
  );
}

async function hasCommand(container: Container, command: string): Promise<boolean> {
  const result = await containerExec(
    container,
    `if command -v ${shQuote(command)} >/dev/null 2>&1; then printf yes; else printf no; fi`,
  );
  return result.trim() === "yes";
}

async function packageManager(
  container: Container,
): Promise<"apt-get" | "apk" | "dnf" | undefined> {
  const result = await containerExec(
    container,
    'for command in apt-get apk dnf; do if command -v "$command" >/dev/null 2>&1; then printf \'%s\' "$command"; exit 0; fi; done',
  );
  const manager = result.trim();
  return manager === "apt-get" || manager === "apk" || manager === "dnf" ? manager : undefined;
}

async function installTmux(
  container: Container,
  manager: "apt-get" | "apk" | "dnf",
): Promise<void> {
  const command = {
    "apt-get": "export DEBIAN_FRONTEND=noninteractive; apt-get update; apt-get install -y tmux",
    apk: "apk add --no-cache tmux",
    dnf: "dnf install -y tmux",
  }[manager];
  console.log(`Installing tmux with ${manager}...`);
  await containerExecStreaming(container, command, "0");
}

async function findPi(container: Container, target: TargetInfo): Promise<string | undefined> {
  const managedPi = `${target.home}/.pi/agent/runtime/node_modules/.bin/pi`;
  const result = await containerExec(
    container,
    `if test -x ${shQuote(managedPi)}; then printf '%s' ${shQuote(managedPi)}; elif command -v pi >/dev/null 2>&1; then command -v pi; fi`,
  );
  return result.trim() || undefined;
}

async function installPi(container: Container, target: TargetInfo): Promise<string> {
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

async function startPi(
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

async function copyIntoContainer(
  container: Container,
  target: TargetInfo,
  selectedExtensions: string[],
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
    const source = join(hostPiDirectory(), "extensions", extension);
    console.log(`Copying extension: ${extension}`);
    await docker(["cp", source, `${container.id}:${extensionsDirectory}/`]);
    await containerExec(
      container,
      `chown -R ${target.uid}:${target.gid} ${shQuote(join(extensionsDirectory, extension))}`,
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

async function extensions(): Promise<string[]> {
  const directory = join(hostPiDirectory(), "extensions");
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || (entry.isFile() && entry.name.endsWith(".ts")))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }
}

function printContainers(items: Container[]): void {
  if (items.length === 0) {
    console.log("No running Dev Containers found.");
    return;
  }
  for (const item of items) {
    console.log(
      `${item.name}\t${item.workspace ?? "(workspace unknown)"}\t${item.remoteUser ?? "(user unknown)"}\t${item.id.slice(0, 12)}`,
    );
  }
}

async function chooseContainer(items: Container[], requested?: string): Promise<Container> {
  if (requested) {
    const matches = items.filter(
      (item) => item.id.startsWith(requested) || item.name === requested,
    );
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) throw new Error(`No running Dev Container matches ${requested}.`);
    throw new Error(`More than one Dev Container matches ${requested}.`);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("A container name or ID is required outside an interactive terminal.");
  }
  return withEscape((signal) =>
    select(
      {
        message: "Select a Dev Container",
        choices: items.map((item) => ({
          name: `${item.name} — ${item.workspace ?? "workspace unknown"} — ${item.remoteUser ?? "user unknown"}`,
          value: item,
        })),
        theme: { style: { keysHelpTip: selectionKeysHelp } },
      },
      { signal },
    ),
  );
}

async function chooseExtensions(items: string[], previous?: string[]): Promise<string[]> {
  if (items.length === 0) return [];
  return withEscape((signal) =>
    checkbox(
      {
        message: "Select Pi extensions to copy",
        choices: items.map((item) => ({
          name: item,
          value: item,
          checked: previous?.includes(item) ?? false,
        })),
        theme: { style: { keysHelpTip: selectionKeysHelp } },
      },
      { signal },
    ),
  );
}

async function chooseAuthCopy(): Promise<boolean> {
  return withEscape((signal) =>
    confirm(
      { message: "Copy host Pi auth.json into the container? (Esc to cancel)", default: false },
      { signal },
    ),
  );
}

async function useSavedConfig(saved: SavedContainerConfig): Promise<boolean> {
  return withEscape((signal) =>
    confirm(
      {
        message: `Use saved configuration (${saved.workspace}; ${saved.extensions.length} extensions) and connect? (No to configure)`,
        default: true,
      },
      { signal },
    ),
  );
}

function usage(): void {
  console.log(
    "Usage: dcpi [list [--json] | extensions [--json] | connect [container-name-or-id] [--tmux]]",
  );
}

async function main(): Promise<void> {
  const [command = "connect", ...arguments_] = process.argv.slice(2);

  if (command === "list") {
    const items = await containers();
    if (arguments_[0] === "--json") console.log(JSON.stringify(items, null, 2));
    else printContainers(items);
    return;
  }

  if (command === "extensions") {
    const items = await extensions();
    if (arguments_[0] === "--json") console.log(JSON.stringify(items, null, 2));
    else console.log(items.join("\n"));
    return;
  }

  if (command === "connect") {
    const useTmux = arguments_.includes("--tmux");
    const targets = arguments_.filter((argument) => argument !== "--tmux");
    if (targets.length > 1) throw new Error("connect accepts at most one container name or ID.");

    const items = await containers();
    if (items.length === 0) throw new Error("No running Dev Containers found.");
    const container = await chooseContainer(items, targets[0]);
    const target = await inspectTarget(container);
    const saved = await savedConfig(container);
    const useSaved = saved ? await useSavedConfig(saved) : false;
    const workspace =
      useSaved && saved ? saved.workspace : await chooseWorkspace(container, saved?.workspace);
    const existingPi = await findPi(container, target);
    const tmuxPresent = useTmux && (await hasCommand(container, "tmux"));

    if (useSaved && existingPi && (!useTmux || tmuxPresent)) {
      console.log(`Connecting with saved configuration to existing Pi: ${existingPi}`);
      await startPi(container, workspace, existingPi, useTmux);
      return;
    }

    const manager = useTmux && !tmuxPresent ? await packageManager(container) : undefined;
    if (useTmux && !tmuxPresent && !manager) {
      throw new Error(
        "tmux is absent and no supported package manager (apt-get, apk, dnf) was found.",
      );
    }

    const selectedExtensions =
      useSaved && saved
        ? saved.extensions
        : await chooseExtensions(await extensions(), saved?.extensions);
    const copyAuth = useSaved ? false : await chooseAuthCopy();
    if (!useSaved) {
      console.log("\nProvisioning plan:");
      console.log(`  container: ${container.name} (${container.id.slice(0, 12)})`);
      console.log(`  workspace: ${workspace}`);
      console.log(`  remote user: ${container.remoteUser ?? "container default"}`);
      console.log(`  Node/npm: ${target.nodeVersion} / ${target.npmVersion}`);
      console.log(
        `  Pi: ${existingPi ? `already available (${existingPi})` : `install into ${target.home}/.pi/agent/runtime`}`,
      );
      console.log(
        `  tmux: ${useTmux ? (tmuxPresent ? "already available" : `install (${manager})`) : "disabled"}`,
      );
      console.log(`  extensions: ${selectedExtensions.join(", ") || "none"}`);
      console.log(`  copy auth.json: ${copyAuth ? "yes" : "no"}`);
      const proceed = await withEscape((signal) =>
        confirm(
          { message: "Provision and attach now? (Esc to cancel)", default: false },
          { signal },
        ),
      );
      if (!proceed) {
        console.log("Provisioning cancelled.");
        return;
      }
    } else {
      console.log("Using saved configuration...");
    }

    if (useTmux && !tmuxPresent && manager) await installTmux(container, manager);
    if (!existingPi || !useSaved) {
      await copyIntoContainer(container, target, selectedExtensions, copyAuth);
    }
    const piBinary = existingPi ?? (await installPi(container, target));
    if (!useSaved) await saveConfig(container, { workspace, extensions: selectedExtensions });
    console.log(
      `Starting ${useTmux ? "Pi in tmux" : "a new Pi session"} (state: ${target.home}/.pi/agent)...`,
    );
    await startPi(container, workspace, piBinary, useTmux);
    return;
  }

  usage();
  process.exitCode = 1;
}

void main().catch((error: unknown) => {
  if (isCancellation(error)) {
    console.log("\nCancelled.");
    return;
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
