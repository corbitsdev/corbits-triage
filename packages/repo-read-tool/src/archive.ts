import type { Stats } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { extract, type ReadEntry } from "tar";

/** The most a checkout may download, and the most its files may add up to once unpacked. */
const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;

function tooLarge(what: string): Error {
  return new Error(`the repository's ${what} is larger than ${MAX_ARCHIVE_BYTES} bytes`);
}

function downloadCap(): Transform {
  let downloaded = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
      downloaded += chunk.length;
      done(downloaded > MAX_ARCHIVE_BYTES ? tooLarge("archive") : undefined, chunk);
    },
  });
}

/**
 * Replaces dir's contents with a gzipped tarball's, dropping its first `strip` path segments, so files from an earlier
 * checkout never linger; tar refuses entries that would land outside dir. An archive over MAX_ARCHIVE_BYTES, packed or
 * unpacked, fails the checkout.
 */
export async function unpackArchive(body: ReadableStream<Uint8Array>, dir: string, strip: number): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  let unpacked = 0;
  let overflow: Error | undefined;
  function withinCap(_path: string, entry: Stats | ReadEntry): boolean {
    unpacked += entry.size;
    if (unpacked > MAX_ARCHIVE_BYTES) overflow ??= tooLarge("unpacked files");
    return overflow === undefined;
  }
  await pipeline(Readable.fromWeb(body as NodeReadableStream<Uint8Array>), downloadCap(), extract({ cwd: dir, strip, filter: withinCap }));
  if (overflow) throw overflow;
}
