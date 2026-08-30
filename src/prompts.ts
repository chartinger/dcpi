import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { styleText } from "node:util";

import type { SavedContainerConfig } from "./config.js";
import type { Container } from "./docker.js";

export async function withEscape<T>(prompt: (signal: AbortSignal) => Promise<T>): Promise<T> {
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

export function isCancellation(error: unknown): boolean {
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

export async function chooseWorkspace(container: Container, previous?: string): Promise<string> {
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

export function printContainers(items: Container[]): void {
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

export async function chooseContainer(items: Container[], requested?: string): Promise<Container> {
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

export async function chooseExtensions(items: string[], previous?: string[]): Promise<string[]> {
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

export async function chooseAuthCopy(): Promise<boolean> {
  return withEscape((signal) =>
    confirm(
      { message: "Copy host Pi auth.json into the container? (Esc to cancel)", default: false },
      { signal },
    ),
  );
}

export async function useSavedConfig(saved: SavedContainerConfig): Promise<boolean> {
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

export async function confirmProvisioning(): Promise<boolean> {
  return withEscape((signal) =>
    confirm({ message: "Provision and attach now? (Esc to cancel)", default: false }, { signal }),
  );
}
