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
  startPi,
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
  console.log(
    "Usage: dcpi [list [--json] | extensions [--json] | connect [container-name-or-id] [--tmux]]",
  );
}

async function connect(arguments_: string[]): Promise<void> {
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
  if (!useSaved) await saveConfig(container, { workspace, extensions: selectedExtensions });
  console.log(
    `Starting ${useTmux ? "Pi in tmux" : "a new Pi session"} (state: ${target.home}/.pi/agent)...`,
  );
  await startPi(container, workspace, piBinary, useTmux);
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
    await connect(arguments_);
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
