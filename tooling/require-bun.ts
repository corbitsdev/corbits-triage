const required = "1.4.3";

if (Bun.semver.order(Bun.version, required) < 0) {
  console.error(`bun check needs Bun ${required} or newer, this is Bun ${Bun.version}: run \`bun upgrade\``);
  process.exit(1);
}
