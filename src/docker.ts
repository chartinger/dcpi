import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface Container {
  id: string;
  name: string;
  identity: string;
  workspace: string | undefined;
  remoteUser: string | undefined;
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

export async function docker(args: string[]): Promise<string> {
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

export async function dockerStreaming(args: string[]): Promise<void> {
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

export async function containers(): Promise<Container[]> {
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

export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function containerExec(
  container: Container,
  command: string,
  user = container.remoteUser,
): Promise<string> {
  const args = ["exec"];
  if (user) args.push("--user", user);
  args.push(container.id, "sh", "-lc", command);
  return docker(args);
}

export async function containerExecStreaming(
  container: Container,
  command: string,
  user = container.remoteUser,
): Promise<void> {
  const args = ["exec"];
  if (user) args.push("--user", user);
  args.push(container.id, "sh", "-lc", command);
  await dockerStreaming(args);
}
