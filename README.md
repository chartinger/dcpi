# dcpi

A host-side CLI for discovering and preparing VS Code Dev Containers for Pi.

By default, dcpi discovers Dev Containers and starts Pi when available, or opens a
shell otherwise. Use `--setup` to check the Node/npm environment and create
container-local Pi state with selected host extensions and optional credentials.
With `--setup`, the optional `--tmux` flag installs or reuses tmux and attaches to a
persistent Pi tmux session.

## Platform support

Only WSL2 has been tested. macOS and native Linux hosts should work when the Docker
CLI is installed and available to the invoking user, but remain untested. dcpi targets
Linux Dev Containers; Windows containers are not supported.

## Install

```bash
npm install --global @chartinger/dcpi

dcpi list
dcpi extensions
dcpi
dcpi --setup
dcpi connect --setup --tmux
```

Alternatively, run it without a global installation:

```bash
npx @chartinger/dcpi connect
```

## Development

```bash
git clone https://github.com/chartinger/dcpi.git
cd dcpi
npm install
npm run dev -- list
npm run dev -- connect

npm run build
node dist/index.js list
```

## Commands

- `dcpi --help` (also `dcpi -h` or `<command> --help`) explains all commands,
  arguments, and options without connecting to Docker.
- `dcpi` (also `dcpi connect [container-name-or-id]`) selects a running Dev Container, locates its workspace by checking `/workspaces/package.json` and then the first `/workspaces` subdirectory containing `package.json`, and starts Pi there when available. If Pi is unavailable, it opens an interactive shell in that directory instead. It does not provision Pi or prompt for configuration.
- `dcpi --quick-shell` (also `dcpi connect --quick-shell`) performs the same container and workspace selection, but always opens an interactive Bash shell; it falls back to `sh` when Bash is unavailable.
- `dcpi list [--json]` lists running Docker containers that carry Dev Container metadata.
- `dcpi extensions [--json]` lists copyable Pi extensions. It discovers loose `.ts`/`.js`
  files in `$PI_CODING_AGENT_DIR/extensions` (default: `~/.pi/agent/extensions`) and,
  in addition, resolves Pi packages declared in
  `$PI_CODING_AGENT_DIR/settings.json` under `packages` (npm specs such as
  `npm:pi-provider-melious` and local paths such as `../../pi/pi-provider-chax`),
  listing each package by its `package.json` name.
- `dcpi --setup` (also `dcpi connect [container-name-or-id] --setup [--tmux]`) checks for Pi in the
  container-local runtime and on the container user's `PATH`, then interactively
  chooses an allowlist of extensions, asks whether to copy `auth.json` (default: no),
  displays the Node/npm-backed provisioning plan, and requires a final confirmation.
  Provisioning uses standard container-local Pi state at `~/.pi/agent`, copies
  selected files, installs Pi there when absent, then starts a new Pi session.
  `--tmux` additionally installs tmux if needed and attaches to a persistent
  `dcpi-pi` tmux session. After a normal provisioning run, dcpi saves the workspace
  and selected extensions in `~/.config/dcpi/containers.json` (or
  `$XDG_CONFIG_HOME/dcpi/containers.json`), keyed by the Dev Container's local-folder
  label and remote user. On later connections it offers to reuse that configuration.
  If accepted and Pi is already available (and requested tmux is available), dcpi
  connects immediately using the saved workspace. Otherwise it provisions any missing
  Pi or tmux requirement using the saved extensions. Credentials are never saved or
  copied automatically.

`connect` requires an interactive terminal when no container argument is provided.
`--tmux` requires `--setup`; `--setup` and `--quick-shell` cannot be combined.

## Persist Pi state across rebuilds

Pi uses its standard container-local directory, `~/.pi/agent`. Add a named volume to
`devcontainer.json` so sessions, credentials, extensions, and dcpi's local Pi runtime
survive a rebuild. The target must match `remoteUser`'s home directory:

```jsonc
{
  "remoteUser": "node",
  "mounts": ["source=dcpi-${devcontainerId},target=/home/node/.pi/agent,type=volume"],
}
```

`${devcontainerId}` expands to a stable per-Dev-Container identifier. The resulting
Docker volume is named `dcpi-<devcontainer-id>`; it is not Compose-prefixed. Docker
initially mounts a new named volume as `root`; dcpi initializes and assigns the Pi
state directory to `remoteUser` automatically.

For a Compose-based Dev Container, declare and mount the volume in Compose instead:

```yaml
services:
  app:
    volumes:
      - dcpi-state:/home/node/.pi/agent

volumes:
  dcpi-state:
```

Compose normally prefixes the Docker volume name with its project name (for example,
`myproject_dcpi-state`). Set an explicit name when required:

```yaml
volumes:
  dcpi-state:
    name: dcpi-my-project
```
