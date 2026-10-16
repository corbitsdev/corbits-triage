import { lookup } from "node:dns/promises";
import { BlockList, connect, createServer, type Socket } from "node:net";

// Sidecars sit on an internal network with no route out. This relay is their only way out:
// HUB_PORT to the hub, and an HTTPS CONNECT proxy to public addresses only, so the Docker host's
// other services and the private network stay out of reach.

export const RELAY_HUB_PORT = 8080;
export const RELAY_PROXY_PORT = 3128;

const NOT_PUBLIC = new BlockList();
const IPV4_RANGES = [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const;
const IPV6_RANGES = [["::", 127], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const;
for (const [network, prefix] of IPV4_RANGES) NOT_PUBLIC.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of IPV6_RANGES) NOT_PUBLIC.addSubnet(network, prefix, "ipv6");

const CONNECT_LINE = /^CONNECT (\[[0-9a-f:.]+\]|[^\s:[\]]+):(\d{1,5}) HTTP\/1\.[01]\r\n/i;

function join(left: Socket, right: Socket): void {
  function close(): void {
    left.destroy();
    right.destroy();
  }
  left.on("error", close).on("close", close);
  right.on("error", close).on("close", close);
  left.pipe(right).pipe(left);
}

function refuse(client: Socket, status: string): void {
  client.end(`HTTP/1.1 ${status}\r\nconnection: close\r\n\r\n`);
}

async function tunnel(client: Socket, head: Buffer): Promise<void> {
  const match = CONNECT_LINE.exec(head.toString("latin1"));
  if (match === null) return refuse(client, "405 Method Not Allowed");
  const host = match[1]!.replace(/^\[|\]$/g, "");
  const port = Number(match[2]);
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return refuse(client, "502 Bad Gateway");
  }
  const [first] = addresses;
  if (first === undefined || addresses.some(({ address, family }) => NOT_PUBLIC.check(address, family === 6 ? "ipv6" : "ipv4"))) {
    return refuse(client, "403 Forbidden");
  }
  // Connect to the address that was checked, not the name, so a second lookup cannot answer differently.
  const upstream = connect(port, first.address);
  upstream.once("error", function unreachable() {
    refuse(client, "502 Bad Gateway");
  });
  upstream.once("connect", function established() {
    upstream.removeAllListeners("error");
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    join(client, upstream);
  });
}

function onProxyClient(client: Socket): void {
  client.on("error", client.destroy.bind(client));
  client.once("data", function onRequest(head: Buffer) {
    void tunnel(client, head);
  });
}

function main(): void {
  const hub = process.env["RELAY_HUB_TARGET"];
  if (hub === undefined) throw new Error("RELAY_HUB_TARGET is required");
  const { hostname, port } = new URL(`tcp://${hub}`);
  createServer(function onHubClient(client: Socket) {
    join(client, connect(Number(port), hostname));
  }).listen(RELAY_HUB_PORT);
  createServer(onProxyClient).listen(RELAY_PROXY_PORT);
}

if (import.meta.main) main();
