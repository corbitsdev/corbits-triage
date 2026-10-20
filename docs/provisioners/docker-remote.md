# Docker on another machine

The [Docker provisioner](docker.md) can run sidecars on a Docker daemon on another machine, such as a VPS, so a hub on a platform without Docker (Railway, for example) can still run code review in containers. The hub reaches the daemon over TLS with client certificates, the way the docker CLI does, and the containers dial the hub at its public address.

You need:

- A Linux machine with Docker Engine, at least 4 GiB of memory (each sidecar may use 2 GiB; see [Memory](docker.md#memory)) and a DNS name or fixed IP address. Use it for nothing else: whoever holds the client certificate controls it.
- The hub reachable from that machine at its public `https://` address (`BETTER_AUTH_BASE_URL`). Sidecars dial it with `wss://`; their hub token and credentials cross that socket, so the hub refuses a remote daemon whose sidecars would dial plain `ws://`.
- A user with `sudo` on the VPS, other than root.
- `openssl` and the docker CLI on your own computer.

## 1. Install Docker

On the VPS, install Docker Engine from [Docker's instructions for your distribution](https://docs.docker.com/engine/install/), and check `sudo docker info` answers.

## 2. Make the certificates

On your own computer, in an empty directory, with `HOST` the VPS's DNS name and `IP` its address:

```sh
HOST=docker.example.com
IP=203.0.113.10

# Certificate authority
openssl genrsa -out ca-key.pem 4096
openssl req -new -x509 -days 825 -sha256 -key ca-key.pem -out ca.pem -subj "/CN=triage-docker-ca"

# Server certificate for the daemon; the hub checks the name it dials against it
openssl genrsa -out server-key.pem 4096
openssl req -new -sha256 -key server-key.pem -out server.csr -subj "/CN=$HOST"
printf 'subjectAltName = DNS:%s,IP:%s\nextendedKeyUsage = serverAuth\n' "$HOST" "$IP" > server.cnf
openssl x509 -req -days 825 -sha256 -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -out server-cert.pem -extfile server.cnf

# Client certificate for the hub (and for you, to build the image)
openssl genrsa -out key.pem 4096
openssl req -new -sha256 -key key.pem -out client.csr -subj "/CN=triage-hub"
printf 'extendedKeyUsage = clientAuth\n' > client.cnf
openssl x509 -req -days 825 -sha256 -in client.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -out cert.pem -extfile client.cnf

chmod 0400 ca-key.pem server-key.pem key.pem
```

Keep `ca-key.pem` offline; it signs new certificates. The hub needs `ca.pem`, `cert.pem` and `key.pem`, as variables (step 6); the daemon needs `ca.pem`, `server-cert.pem` and `server-key.pem`.

The certificates expire after 825 days. Before then, sign new server and client certificates with the same CA, replace them on the VPS and in the hub's variables, and restart both; the hub reads its variables only at boot. A new CA means replacing `ca.pem` on both sides too. To cut off a leaked client key, make a new CA and new certificates; Docker has no revocation list.

## 3. Turn on TLS in the daemon

Copy the daemon's three files to the VPS as your `sudo` user (`admin` here), then move them into place, readable only by root:

```sh
scp ca.pem server-cert.pem server-key.pem admin@$HOST:
ssh admin@$HOST 'sudo install -o root -g root -m 0444 ca.pem server-cert.pem /etc/docker/ && sudo install -o root -g root -m 0400 server-key.pem /etc/docker/ && rm ca.pem server-cert.pem server-key.pem'
```

On the VPS, write `/etc/docker/daemon.json`:

```json
{
  "hosts": ["unix:///var/run/docker.sock", "tcp://0.0.0.0:2376"],
  "tls": true,
  "tlsverify": true,
  "tlscacert": "/etc/docker/ca.pem",
  "tlscert": "/etc/docker/server-cert.pem",
  "tlskey": "/etc/docker/server-key.pem"
}
```

The packaged service also passes `-H fd://`, which conflicts with `hosts`. Override it with `sudo systemctl edit docker`:

```ini
[Service]
ExecStart=
ExecStart=/usr/bin/dockerd --containerd=/run/containerd/containerd.sock
```

Then `sudo systemctl restart docker`. With `tlsverify`, the daemon accepts only clients holding a certificate your CA signed. Never expose port 2375 (plain `tcp://`); the hub refuses it for any machine but its own.

## 4. Firewall

Allow SSH and 2376, and nothing else inbound. With `ufw`:

```sh
sudo ufw default deny incoming
sudo ufw allow OpenSSH
sudo ufw allow from <hub's outbound address> to any port 2376 proto tcp
sudo ufw enable
```

Narrow 2376 to the hub's outbound address when the hub's platform gives it a fixed one. Without one, open 2376 to everyone (`sudo ufw allow 2376/tcp`) and rely on the client certificate. Sidecars publish no ports; they only dial out, to the hub and to the APIs their workflows call.

From your computer, check the daemon answers over TLS:

```sh
DOCKER_HOST=tcp://$HOST:2376 DOCKER_TLS_VERIFY=1 DOCKER_CERT_PATH=$PWD docker info
```

## 5. Put the sidecar image on the VPS

The image must be on the VPS's daemon, built from the same commit as the hub. Build it there straight from a checkout of that commit; the build runs on the VPS, so the image has its architecture, and no registry is involved:

```sh
DOCKER_HOST=tcp://$HOST:2376 DOCKER_TLS_VERIFY=1 DOCKER_CERT_PATH=/path/to/certs \
  docker build --target sidecar -t corbits-triage-sidecar .
```

Rebuild it every time you deploy a new hub version. A hub whose image is missing logs `docker_sidecars_off` and runs no code review.

## 6. Point the hub at it

Set on the hub:

| Variable | Value |
| --- | --- |
| `DOCKER_HOST` | `tcp://docker.example.com:2376`, the name or address in the server certificate |
| `DOCKER_TLS_CA` | `ca.pem` as one line of base64 |
| `DOCKER_TLS_CERT` | `cert.pem` as one line of base64 |
| `DOCKER_TLS_KEY` | `key.pem` as one line of base64 |
| `BETTER_AUTH_BASE_URL` | the hub's public `https://` address, as already set |

The hub takes its TLS material only from these variables and writes no certificate files; it does not read `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH` or `~/.docker`. Set all three or none: the hub refuses to start with only some, or with a value that is not base64 of a PEM certificate (`DOCKER_TLS_CA`, `DOCKER_TLS_CERT`) or private key (`DOCKER_TLS_KEY`). Base64 keeps each PEM file on one line, which `.env` files and every platform's variable editor keep intact. From the directory holding the three files, print the `.env` lines:

```sh
printf 'DOCKER_TLS_CA=%s\nDOCKER_TLS_CERT=%s\nDOCKER_TLS_KEY=%s\n' \
  "$(base64 < ca.pem | tr -d '\n')" "$(base64 < cert.pem | tr -d '\n')" "$(base64 < key.pem | tr -d '\n')"
```

`DOCKER_TLS_KEY` holds the client key, so treat it as a secret: whoever has it controls the VPS's Docker.

Leave `HUB_SIDECAR_WEBSOCKET_URL` unset. Sidecars on the VPS then dial `BETTER_AUTH_BASE_URL` with `wss://` and `/api/sidecars/ws`, while the hub's own local sidecars keep dialling it on loopback. Setting it would send local sidecars out through the public address too. `compose.tls.yml` sets it to `wss://<domain>`, which remote sidecars can also dial.

Sidecars on another machine never get the loopback rewrite the hub's own Docker uses. The hub does not register Docker, and logs why, when the address they would dial is not `wss://` or names the hub's own machine (`localhost`, `127.x`, `0.0.0.0`, `[::1]`).

### On Railway

From the directory holding `ca.pem`, `cert.pem` and `key.pem`, with the Railway CLI linked to the hub's project and `hub` the hub's service name:

```sh
railway variable set --service hub DOCKER_HOST=tcp://docker.example.com:2376 \
  "DOCKER_TLS_CA=$(base64 < ca.pem | tr -d '\n')" \
  "DOCKER_TLS_CERT=$(base64 < cert.pem | tr -d '\n')" \
  "DOCKER_TLS_KEY=$(base64 < key.pem | tr -d '\n')"
```

Or paste the lines the `printf` above prints into the service's Variables → Raw Editor. Setting the variables redeploys the hub. Set them again with the new files when you rotate the certificates.

## 7. Check

Restart the hub and read its boot log. With the VPS registered there is no `docker_sidecars_off` line, and `docker_sidecars_swept` says how many leftover containers it removed. Otherwise the line gives the reason; [Not registered](docker.md#not-registered) lists each one and its fix.

Turn on code review for a repository. Its sidecar shows up on the VPS:

```sh
DOCKER_HOST=tcp://$HOST:2376 DOCKER_TLS_VERIFY=1 DOCKER_CERT_PATH=/path/to/certs docker ps --filter label=corbits.hub
```

The provisioner's capacity comes from the VPS's memory, as `docker info` reports it. Pointing the hub at another daemon changes its binding; see [What is isolated](docker.md#what-is-isolated).
