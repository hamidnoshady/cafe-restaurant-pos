import { promises as fs } from "node:fs";
import path from "node:path";

const ZERO_CHUNK = Buffer.alloc(1024 * 1024);

/**
 * Best-effort overwrite + fsync + unlink for plaintext database artifacts.
 * Modern SSDs/copy-on-write filesystems cannot promise physical erasure, but
 * this prevents an ordinary undelete of the named file and, unlike rm(), also
 * removes bytes from conventional filesystems. Persistent backup artifacts are
 * never passed here.
 */
export async function secureUnlink(file: string): Promise<void> {
  let info;
  try {
    info = await fs.lstat(file);
  } catch {
    return;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    await fs.unlink(file).catch(() => {});
    return;
  }
  try {
    const handle = await fs.open(file, "r+");
    try {
      let remaining = info.size;
      let position = 0;
      while (remaining > 0) {
        const length = Math.min(remaining, ZERO_CHUNK.length);
        await handle.write(ZERO_CHUNK, 0, length, position);
        remaining -= length;
        position += length;
      }
      await handle.sync();
      await handle.truncate(0);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Permission races and filesystem limitations must not prevent unlink.
  }
  await fs.unlink(file).catch(() => {});
}

/** Remove a private temp tree without following symlinks. */
export async function secureRemoveDirectory(directory: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await secureRemoveDirectory(absolute);
    else await secureUnlink(absolute);
  }
  await fs.rmdir(directory).catch(async () => {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  });
}
