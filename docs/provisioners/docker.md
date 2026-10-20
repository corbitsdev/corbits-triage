# Docker provisioner

`packages/provisioner-docker` runs each sidecar in a container of its own and declares `isolation:workload` and `network:outbound`. The hub registers it after the [local process provisioner](local.md), so it hosts workflows that require `isolation:workload`, and every workflow probe.

## Set up

1. Install Docker Desktop (macOS, Windows) or Docker Engine (Linux) on the hub's machine, and start it. For Docker on another machine, such as a VPS, follow [Docker on another machine](docker-remote.md) instead.
2. Build the sidecar image from the repository root, and rebuild it after changing the code:

   ```sh
   docker build --target sidecar -t corbits-triage-sidecar .
   ```

3. Start the hub. It looks for the daemon the way the docker CLI does:
   - `DOCKER_HOST`, if set (`unix:///path` or `tcp://host:port`), over mutual TLS when `DOCKER_TLS_CA`, `DOCKER_TLS_CERT` and `DOCKER_TLS_KEY` hold `ca.pem`, `cert.pem` and `key.pem` as base64 ([Docker on another machine](docker-remote.md#6-point-the-hub-at-it));
   - else the docker CLI's context: `DOCKER_CONTEXT`, else the current context in `~/.docker/config.json`;
   - else `/var/run/docker.sock`, then `~/.docker/run/docker.sock` (Docker Desktop).
4. Check the hub's boot log. With Docker registered there is no `docker_sidecars_off` line, and `docker_sidecars_swept` says how many leftover containers it removed.

Containers dial the hub at `HUB_SIDECAR_WEBSOCKET_URL`, with a loopback host replaced by `host.docker.internal`. Containers on [another machine](docker-remote.md) dial the hub's public `wss://` address instead. A hub that itself runs in a container needs the daemon's socket mounted and its port published to the Docker host.

Under Docker Compose, `compose.docker.yml` builds the `corbits-triage-sidecar` image before the hub starts and mounts the host's Docker socket into the hub at `/var/run/docker.sock`, where the hub finds it; `compose.yml` already publishes the hub's port. The host socket is `/var/run/docker.sock` unless `DOCKER_SOCKET` in `.env` names another, such as rootless Docker's `$XDG_RUNTIME_DIR/docker.sock` or Podman's. The hub then controls that Docker, which on Linux is root on the host: whoever takes over the hub takes over the machine.

```sh
docker compose -f compose.yml -f compose.docker.yml up --build -d
```

## Memory

Each container may use 2 GiB of memory and 1024 processes. The provisioner declines a new sidecar while the daemon's memory (on Docker Desktop, the memory given to its VM), less 2 GiB for each of this hub's containers and each one it is starting, is below 2 GiB. Docker therefore needs more than 2 GiB of memory for one sidecar: a VM given exactly 2 GiB reports about 1986 MiB and fits none. The hub retries a declined sidecar with backoff, up to Interchange's 10 ensure attempts; after the tenth the deployment fails. Give Docker Desktop more memory to run more at once.

## What is isolated

Each sidecar has its own container, processes, filesystem and data volume, with a read-only root, no Linux capabilities, no new privileges and no Docker socket. It holds only its own hub token and a credential key of its own. It shares the host's kernel and has outbound network.

Containers are labelled with a hub id derived from the hub's Postgres cluster, database and schema, so hubs sharing a daemon never touch each other's containers. At boot the hub removes its containers that no allocation or probe still holds. Pointing the hub at another daemon or database changes the provisioner's binding, and sidecars placed through the old one are not cleaned up through the new one.

## Not registered

The hub logs `docker_sidecars_off` with one of these reasons:

| Reason | Fix |
| --- | --- |
| `no Docker daemon found` | Start Docker, or set `DOCKER_HOST`. |
| `Docker at … has no corbits-triage-sidecar image or does not answer` | Build the image (step 2); check the daemon is running and the address is `unix://` or `tcp://`. |
| `Triage cannot connect to Docker at … (… is another machine; reach it over TLS …)` | Plain `tcp://` is refused for any host but this machine. Set `DOCKER_TLS_CA`, `DOCKER_TLS_CERT` and `DOCKER_TLS_KEY` ([Docker on another machine](docker-remote.md)). |
| `Docker at … is on another machine, which reaches Triage only over TLS` | Set `BETTER_AUTH_BASE_URL` to the hub's `https://` address, or `HUB_SIDECAR_WEBSOCKET_URL` to a `wss://` one. |
| `Docker at … is on another machine, which cannot reach Triage at its own address` | Set `BETTER_AUTH_BASE_URL` to the hub's public address. |
| `Code review cannot run in Docker while GITHUB_API_ORIGIN is set` | Unset `GITHUB_API_ORIGIN`: the module it generates under `HUB_DATA_DIR` is not in the image. |
| `The Docker CLI's settings on this server cannot be read` | Fix or remove `~/.docker/config.json`, or the context `DOCKER_CONTEXT` names; or set `DOCKER_HOST`. |
| `Triage cannot read its database's identity, which keeps its containers apart from other servers'` | Postgres refused the hub id query (`pg_control_system()` and the database's oid); the error says why. |
| `The Docker address … is not a URL` | Set `DOCKER_HOST` to `unix:///path` or `tcp://host:port`. |
