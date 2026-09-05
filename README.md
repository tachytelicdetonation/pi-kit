# pi-kit

Personal extensions for the Pi coding agent. The main package is **Helm**, a
full-screen terminal interface for workflows, background tasks, session history,
and usage monitoring.

## Helm

[Read the interface guide](helm/README.md) for the screen map, controls, and
workflow behavior. The [workflow documentation](helm/docs/workflows/README.md)
covers the workflow subsystem.

## Install from a local checkout

With Pi already installed, clone this repository and install the Helm package:

```bash
git clone https://github.com/tachytelicdetonation/pi-kit.git
cd pi-kit
pi install "$PWD/helm"
```

In the Pi terminal interface, run:

```text
/helm
```

Helm depends on the host Pi environment and its configured tools. See
[helm/package.json](helm/package.json) for package and peer dependencies, and the
Helm guide for the features that rely on external tools.

## Development and attribution

Each extension is a separate package. Helm's source, build commands, and tests
live under [helm](helm). The repository also retains design documents and
previews used during development.

Vendored components retain their upstream attribution and license files. Consult
the component documentation when reusing code.
