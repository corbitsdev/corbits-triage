# Docker provisioner

`packages/provisioner-docker` runs each sidecar in a container of its own and declares `isolation:workload` and `network:outbound`. The hub registers it after the [local process provisioner](local.md), so it hosts workflows that require `isolation:workload`, and every workflow probe.

## Set up

1. Install Docker Desktop (macOS, Windows) or Docker Engine (Linux) on the hub's machine, and start it. For Docker on another machine, such as a VPS, follow [Docker on another machine](docker-remote.md) instead.
2. Build the sidecar image. The hub runs `corbits-triage-sidecar`. Under Docker Compose, `compose.docker.yml` builds it with the hub. Otherwise build it from the repository root, and rebuild it after changing the code:

   ```sh
   docker build --target sidecar -t corbits-triage-sidecar .
   ```

3. Start the hub. It looks for the daemon the way the docker CLI does:
   - `DOCKER_HOST`, if set (`unix:///path` or `tcp://host:port`), over mutual TLS when `DOCKER_TLS_CA`, `DOCKER_TLS_CERT` and `DOCKER_TLS_KEY` hold `ca.pem`, `cert.pem` and `key.pem` as base64 ([Docker on another machine](docker-remote.md#6-point-the-hub-at-it));
   - else the docker CLI's context: `DOCKER_CONTEXT`, else the current context in `~/.docker/config.json`;
   - else `/var/run/docker.sock`, then `~/.docker/run/docker.sock` (Docker Desktop).
4. Check the hub's boot log. With Docker registered there is no `docker_sidecars_off` line, and `docker_sidecars_swept` says how many leftover containers it removed.

Containers dial the hub at `HUB_SIDECAR_WEBSOCKET_URL`, with a loopback host replaced by `host.docker.internal`. Containers on [another machine](docker-remote.md) dial the hub's public `wss://` address instead. A hub that itself runs in a container needs the daemon's socket mounted and its port published to the Docker host.

Under Docker Compose, `compose.docker.yml` builds the sidecar image and mounts the host's Docker socket into the hub at `/var/run/docker.sock`, where the hub finds it; `compose.yml` already publishes the hub's port. The host socket is `/var/run/docker.sock` unless `DOCKER_SOCKET` in `.env` names another, such as rootless Docker's `$XDG_RUNTIME_DIR/docker.sock` or Podman's. The hub then controls that Docker, which on Linux is root on the host: whoever takes over the hub takes over the machine.

```sh
docker compose -f compose.yml -f compose.docker.yml up -d
```

## Memory

Each container may use 2 GiB of memory and 1024 processes. The provisioner declines a new sidecar while the daemon's memory (on Docker Desktop, the memory given to its VM), less 2 GiB for each of this hub's containers and each one it is starting, is below 2 GiB. Docker therefore needs more than 2 GiB of memory for one sidecar: a VM given exactly 2 GiB reports about 1986 MiB and fits none. The hub retries a declined sidecar with backoff, up to Interchange's 10 ensure attempts; after the tenth the deployment fails. Give Docker Desktop more memory to run more at once.

Measured on Docker Desktop 29.5.3 (2026-10-17): a deployed, idle code review container held 765 to 787 MiB, the sidecar process 442 MiB and its workflow child 406 MiB. A review worker container peaked at about 867 MiB while reviewing a small pull request.

## What is isolated

Each sidecar has its own container, processes, filesystem and data volume, with a read-only root, the image's unprivileged `bun` user (never root, and the data volume is created owned by it), no Linux capabilities, no new privileges and no Docker socket. It holds only its own hub token and a credential key of its own. It shares the host's kernel and has outbound network.

A sandbox for repository commands inside the container needs privileges the container does not have today; they come with the tool that runs those commands.

Containers are labelled with a hub id derived from the hub's Postgres cluster, database and schema, so hubs sharing a daemon never touch each other's containers. At boot the hub removes its containers that no allocation or probe still holds. Pointing the hub at another daemon or database, or a new sidecar image, changes the provisioner's binding, and sidecars placed through the old one are not cleaned up through the new one.

## Not registered

The hub logs `docker_sidecars_off` with one of these reasons:

| Reason | Fix |
| --- | --- |
| `no Docker daemon found` | Start Docker, or set `DOCKER_HOST`. |
| `Docker at … does not answer` | Check the daemon is running and the address is `unix://` or `tcp://`. |
| `Docker at … has no corbits-triage-sidecar image` | Build the image (step 2). |
| `Docker at … is refused (… is another machine; reach it over TLS …)` | Plain `tcp://` is refused for any host but this machine. Set `DOCKER_TLS_CA`, `DOCKER_TLS_CERT` and `DOCKER_TLS_KEY` ([Docker on another machine](docker-remote.md)). |
| `Docker at … is another machine, and its sidecars would dial the hub at … without TLS` | Set `BETTER_AUTH_BASE_URL` to the hub's `https://` address and leave `HUB_SIDECAR_WEBSOCKET_URL` unset. |
| `Docker at … is another machine, and its sidecars would dial the hub at its own address …` | Set `BETTER_AUTH_BASE_URL` to the hub's public address. |
| `the docker CLI's context cannot be read` | Fix or remove `~/.docker/config.json`, or the context `DOCKER_CONTEXT` names; or set `DOCKER_HOST`. |
| `the database does not tell this hub apart from others` | Postgres refused the hub id query (`pg_control_system()` and the database's oid); the error says why. |
