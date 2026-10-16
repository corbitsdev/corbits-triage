import { mkdir, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { extract } from "tar";

/**
 * Replaces dir's contents with a gzipped tarball's, dropping its first `strip` path segments, so files from an earlier
 * checkout never linger; tar refuses entries that would land outside dir.
 */
export async function unpackArchive(body: ReadableStream<Uint8Array>, dir: string, strip: number): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await pipeline(Readable.fromWeb(body as NodeReadableStream<Uint8Array>), extract({ cwd: dir, strip }));
}
