#!/usr/bin/env node

import { saveConfig, savedConfig } from "./config.js";
import { containers } from "./docker.js";
import {
  copyIntoContainer,
  extensions,
  findPi,
  hasCommand,
  inspectTarget,
  installPi,
  installTmux,
  packageManager,
  quickWorkspace,
  resolveSavedExtensions,
  startPi,
  startShell,
} from "./provision.js";
import {
  chooseAuthCopy,
  chooseContainer,
  chooseExtensions,
  chooseWorkspace,
  confirmProvisioning,
  isCancellation,
  printContainers,
  useSavedConfig,
} from "./prompts.js";

function usage(): void {
  console.log(`Usage:
  dcpi [--setup [--tmux] | --quick-shell]
  dcpi connect [container-name-or-id] [--setup [--tmux] | --quick-shell]
  dcpi list [--json]
  dcpi extensions [--json]
  dcpi --help

Commands:
  connect       Connect to a running Dev Container (default command).
                Start existing Pi, or open a shell if Pi is unavailable.
                Locate the workspace automatically; no provisioning.
  list          List running Dev Containers.
  extensions    List copyable host Pi extensions and packages.

Arguments:
  container-name-or-id
                Select a container by exact name or ID prefix.
                If omitted, prompt for a container (requires a terminal).

Options:
  --setup       Configure the workspace, extensions, and optional auth copy;
                install Pi if needed. Offer to reuse saved configuration.
  --tmux        Install or reuse tmux and attach to a persistent Pi session.
                Requires --setup.
  --quick-shell Always open Bash (or sh), even when Pi is available.
                Cannot be combined with --setup.
  --json        Output JSON instead of text (list and extensions only).
  --help, -h    Show this help and exit; also works after a command.

Examples:
  dcpi
  dcpi connect my-container
  dcpi --setup
  dcpi connect my-container --setup --tmux
  dcpi --quick-shell
  dcpi list --json`);
}

async function connect(arguments_: string[], shellOnly = false): Promise<void> {
  if (arguments_.length > 1) throw new Error("connect accepts at most one container name or ID.");

  const items = await containers();
  if (items.length === 0) throw new Error("No running Dev Containers found.");
  const container = await chooseContainer(items, arguments_[0]);
  const workspace = await quickWorkspace(container);
  if (!workspace) throw new Error("Working directory cannot be found.");

  const piBinary = shellOnly ? undefined : await findPi(container);
  if (piBinary) {
    console.log(`Starting Pi in ${workspace}...`);
    await startPi(container, workspace, piBinary, false);
    return;
  }

  console.log(`Opening a shell in ${workspace}...`);
  await startShell(container, workspace);
}

async function setupConnect(arguments_: string[]): Promise<void> {
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

  const discoveredExtensions = await extensions();
  const selectedExtensions =
    useSaved && saved
      ? resolveSavedExtensions(saved.extensions, discoveredExtensions)
      : await chooseExtensions(discoveredExtensions, saved?.extensions);
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
    console.log(
      `  extensions: ${selectedExtensions.map((extension) => extension.name).join(", ") || "none"}`,
    );
    console.log(`  copy auth.json: ${copyAuth ? "yes" : "no"}`);
    if (!(await confirmProvisioning())) {
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
  if (!useSaved)
    await saveConfig(container, {
      workspace,
      extensions: selectedExtensions.map((extension) => extension.name),
    });
  console.log(
    `Starting ${useTmux ? "Pi in tmux" : "a new Pi session"} (state: ${target.home}/.pi/agent)...`,
  );
  await startPi(container, workspace, piBinary, useTmux);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  const [command = "connect", ...arguments_] = args[0]?.startsWith("--")
    ? ["connect", ...args]
    : args;

  if (command === "list") {
    const items = await containers();
    if (arguments_[0] === "--json") console.log(JSON.stringify(items, null, 2));
    else printContainers(items);
    return;
  }

  if (command === "extensions") {
    const items = await extensions();
    if (arguments_[0] === "--json") console.log(JSON.stringify(items, null, 2));
    else console.log(items.map((extension) => extension.name).join("\n"));
    return;
  }

  if (command === "connect") {
    const setup = arguments_.includes("--setup");
    const shellOnly = arguments_.includes("--quick-shell");
    if (setup && shellOnly) throw new Error("--setup and --quick-shell cannot be used together.");
    if (arguments_.includes("--tmux") && !setup) {
      throw new Error("--tmux requires --setup.");
    }
    const unknownFlag = arguments_.find(
      (argument) =>
        argument.startsWith("--") && !["--setup", "--quick-shell", "--tmux"].includes(argument),
    );
    if (unknownFlag) throw new Error(`Unknown option: ${unknownFlag}`);
    const targets = arguments_.filter(
      (argument) => argument !== "--setup" && argument !== "--quick-shell",
    );
    if (setup) await setupConnect(targets);
    else await connect(targets, shellOnly);
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
