# dcpi

A host-side CLI for discovering and preparing VS Code Dev Containers for Pi.

This initial bootstrap discovers Dev Containers, checks their Node/npm environment,
and can create container-local Pi state with selected host extensions and optional
credentials. It starts a new Pi session by default. The optional `--tmux` flag installs
or reuses tmux and attaches to a persistent Pi tmux session.

## Platform support

Only WSL2 has been tested. macOS and native Linux hosts should work when the Docker
CLI is installed and available to the invoking user, but remain untested. dcpi targets
Linux Dev Containers; Windows containers are not supported.

```bash
npm install
npm run dev -- list
npm run dev -- extensions
npm run dev -- connect
npm run dev -- connect --tmux

# Build a runnable `dcpi` executable.
npm run build
node dist/index.js list

```

## Commands

- `dcpi list [--json]` lists running Docker containers that carry Dev Container metadata.
- `dcpi extensions [--json]` lists copyable Pi extensions from
  `$PI_CODING_AGENT_DIR/extensions` (default: `~/.pi/agent/extensions`).
- `dcpi connect [container-name-or-id] [--tmux]` checks for Pi in the
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
