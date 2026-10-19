#!/bin/sh
# Run as root from the repository root, at the hub's commit: sh packages/provisioner-qemu/host/install.sh
# Builds the microVM root disk, then installs and starts the agent on /run/corbits-qemu/agent.sock. Rerun after every hub deploy.
set -eu
REPO=$(pwd)
LIB=/var/lib/corbits-qemu
ETC=/etc/corbits-qemu
BUN=$(command -v bun)
NAMESERVERS=$(awk '/^nameserver/ { printf "%s ", $2 }' /etc/resolv.conf)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

id corbits-qemu >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin --groups kvm corbits-qemu
# Caddy reaches the agent's socket through the group.
usermod -aG corbits-qemu caddy
runuser -u corbits-qemu -- "$BUN" --version >/dev/null || { echo "corbits-qemu cannot run $BUN; install Bun where every user can run it, such as /usr/local/bin" >&2; exit 1; }
install -d -o corbits-qemu -g corbits-qemu -m 0700 "$LIB" "$LIB/state"
install -d -m 0700 "$ETC"

docker build --target sidecar-vm -t corbits-triage-sidecar-vm .
container=$(docker create corbits-triage-sidecar-vm)
docker export -o "$WORK/rootfs.tar" "$container"
docker rm "$container" >/dev/null
mkdir "$WORK/rootfs"
tar -x -C "$WORK/rootfs" -f "$WORK/rootfs.tar"
truncate -s 8G "$LIB/rootfs.new"
mkfs.ext4 -q -F -d "$WORK/rootfs" "$LIB/rootfs.new"
install -o corbits-qemu -g corbits-qemu -m 0400 "/boot/vmlinuz-$(uname -r)" "$LIB/vmlinuz"
chown corbits-qemu:corbits-qemu "$LIB/rootfs.new"
chmod 0600 "$LIB/rootfs.new"
mv "$LIB/rootfs.new" "$LIB/rootfs.ext4"

if [ ! -f "$ETC/agent.env" ]; then
  umask 077
  printf 'QEMU_AGENT_TOKEN=%s\nQEMU_AGENT_KERNEL=%s\nQEMU_AGENT_ROOTFS=%s\nQEMU_AGENT_STATE_DIR=%s\n' \
    "$(openssl rand -hex 32)" "$LIB/vmlinuz" "$LIB/rootfs.ext4" /run/corbits-qemu > "$ETC/agent.env"
fi

cat > /etc/systemd/system/corbits-qemu.service <<UNIT
[Unit]
Description=Corbits Triage QEMU sidecar agent
After=network-online.target

[Service]
User=corbits-qemu
EnvironmentFile=$ETC/agent.env
# QEMU keeps each VM's throwaway disk writes here; a killed VM can leave its file behind.
Environment=TMPDIR=$LIB/state
ExecStartPre=/usr/bin/find $LIB/state -mindepth 1 -delete
# Each VM's env file and the agent's socket; gone when the agent stops.
RuntimeDirectory=corbits-qemu
RuntimeDirectoryMode=0750
UMask=0007
WorkingDirectory=$REPO
ExecStart=$BUN packages/provisioner-qemu/src/main.ts
KillMode=control-group
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$LIB/state
# VMs' user-mode networking opens its sockets in this service, so this keeps them off the machine's own services
# (10.0.2.2 is its loopback), cloud metadata and private networks. QEMU forwards their DNS to the nameservers.
IPAddressDeny=localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 fc00::/7
IPAddressAllow=$NAMESERVERS

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable corbits-qemu
systemctl restart corbits-qemu
echo "QEMU_PROVISIONER_TOKEN is in $ETC/agent.env"
