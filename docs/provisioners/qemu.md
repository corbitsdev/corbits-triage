# QEMU microVMs

The QEMU provisioner runs each sidecar in a QEMU `microvm` of its own on a Linux machine with KVM, so a code review gets its own kernel, not just its own container. The hub talks over HTTPS to a small agent on that machine (`packages/provisioner-qemu/src/agent.ts`), using one bearer token. The agent starts and stops the VMs. The hub registers it after [Docker](docker.md), [E2B](e2b.md) and [Railway Sandboxes](railway-sandboxes.md). In Settings → Code review → **Where it runs** it is **QEMU microVMs**; code review uses the first ready place in the order shown there, so QEMU is used only when none before it is ready.

Each VM gets:

- 2 GiB of memory and 2 vCPUs. The agent accepts VMs while the machine's memory, less 2 GiB for each VM it runs, has room for another.
- A root disk that is the sidecar image, opened with `snapshot=on`, so each VM's writes go to a temporary file and are discarded when it stops.
- User-mode networking: outbound to the internet only. No ports open on the host, and no access to other VMs, the host's own services, cloud metadata (`169.254.169.254`) or private addresses (`10/8`, `172.16/12`, `192.168/16`); the agent's systemd unit blocks those.
- Its env (the hub address, the sidecar token, a fresh `SIDECAR_CREDENTIAL_ENCRYPTION_KEY`, the adapter manifest), read from a QEMU `fw_cfg` file in `/run/corbits-qemu` only the agent's user can read. The file is deleted when the VM stops.

The VMs are child processes of the agent. Restarting the agent stops them all, and the hub then starts new ones.

## You need

- A Linux x86_64 machine with `/dev/kvm`, used for nothing else, with a DNS name. Each sidecar needs 2 GiB, so the machine needs at least 4 GiB of memory.
- On it: `qemu-system-x86` (QEMU 8 or later), Docker Engine (only to build the root disk), `e2fsprogs`, `openssl`, [Bun](https://bun.sh) where every user can run it (such as `/usr/local/bin`), and [Caddy](https://caddyserver.com/docs/install) for HTTPS.
- The hub reachable from that machine at its public `https://` address (`BETTER_AUTH_BASE_URL`). VMs dial it over `wss://`.

## 1. Install the agent

As root, clone the repository at the hub's commit into a directory the agent's user can read, then run the install script:

```sh
git clone https://github.com/corbitsdev/corbits-triage /opt/corbits-triage
cd /opt/corbits-triage && git checkout <hub commit> && bun install --frozen-lockfile
sh packages/provisioner-qemu/host/install.sh
```

The script:

1. Builds the `sidecar-vm` stage of the Dockerfile (the sidecar image plus `iproute2` and `host/init` as `/sbin/corbits-init`) and turns it into an 8 GiB sparse ext4 file at `/var/lib/corbits-qemu/rootfs.ext4`.
2. Copies the host's kernel, `/boot/vmlinuz-$(uname -r)`, to `/var/lib/corbits-qemu/vmlinuz`.
3. Creates the `corbits-qemu` system user in the `kvm` group and adds the `caddy` user to its group. The first time it runs, it also writes `/etc/corbits-qemu/agent.env` (mode 0600) with a random `QEMU_AGENT_TOKEN`.
4. Installs and starts `corbits-qemu.service`. The agent listens on the Unix socket `/run/corbits-qemu/agent.sock` only.

Rerun it after every hub deploy, so the root disk matches the hub's commit. It keeps the token.

## 2. Put HTTPS in front

The agent listens on a Unix socket only. Caddy gets a certificate for the machine's name and forwards to it:

```sh
printf 'qemu.example.com {\n\treverse_proxy unix//run/corbits-qemu/agent.sock\n}\n' > /etc/caddy/Caddyfile
systemctl restart caddy
```

Open 443 (and 80, for the certificate challenge) in the firewall, and nothing else inbound besides SSH. Every request needs the bearer token. Without it, the agent answers 401.

## 3. Point the hub at it

Set on the hub, then restart it (Settings → Code review shows the first two lines, with Copy):

| Variable | Value |
| --- | --- |
| `QEMU_PROVISIONER_URL` | `https://qemu.example.com` |
| `QEMU_PROVISIONER_TOKEN` | `QEMU_AGENT_TOKEN` from `/etc/corbits-qemu/agent.env` |
| `BETTER_AUTH_BASE_URL` | the hub's public `https://` address, as already set |

Leave `HUB_SIDECAR_WEBSOCKET_URL` unset, as for [Docker on another machine](docker-remote.md#6-point-the-hub-at-it). On Railway: `railway variable set --service hub QEMU_PROVISIONER_URL=… QEMU_PROVISIONER_TOKEN=…`.

To rotate the token, change it in `agent.env`, restart `corbits-qemu`, then set the new value on the hub.

## 4. Check

Open Settings → Code review. **QEMU microVMs** says **Ready**, or **In use** when no place comes before it. If it says **Failing**, the reason under it, shown to admins, says what to fix: the URL is not `https://`, the hub's own address is not `wss://`, or the agent refused the token or did not answer. The hub also logs it as `qemu_sidecars_off`, and `qemu_sidecars_swept` says how many leftover VMs it stopped.

Turn on code review for a repository. Its VM's console, including the sidecar's log, shows in `journalctl -u corbits-qemu -f`.

## Not yet verified

The package's tests run the provisioner contract against the real agent with QEMU replaced by a recorder. No VM has been booted with this setup yet. Before relying on it, check on a KVM host:

- **Kernel without an initramfs.** The VM boots the host's kernel with no initramfs, so `virtio_mmio`, `virtio_blk`, `virtio_net`, `ext4` and `qemu_fw_cfg` (with its sysfs files) must be built in, not modules. Check with `grep -E 'CONFIG_(VIRTIO_MMIO|VIRTIO_BLK|VIRTIO_NET|EXT4_FS|FW_CFG_SYSFS)=' /boot/config-$(uname -r)`; each must be `=y`. If any is `=m`, install a kernel built for VMs (for example Ubuntu's `linux-kvm`) and copy that one.
- **DNS.** QEMU forwards each VM's DNS to the nameservers in the host's `/etc/resolv.conf` at install time, which the unit allows past its firewall. Rerun the install script if they change.
- **Boot time.** Booting the kernel and starting the sidecar from an 8 GiB root disk has not been measured. The hub waits for a sidecar to connect within its usual connection deadline.
