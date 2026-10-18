import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Where file bytes live. Local disk now; an S3-compatible driver can implement the same interface later. */
export interface FileStorage {
  put(key: string, data: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
}

/** Keys are generated server-side; this pattern also rules out any path traversal. */
const SAFE_KEY = /^[a-f0-9-]{36}\.[a-z0-9]{2,5}$/;

export class LocalDiskStorage implements FileStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private pathFor(key: string): string {
    if (!SAFE_KEY.test(key)) throw new Error(`Invalid storage key: ${key}`);
    return path.join(this.root, key);
  }

  async put(key: string, data: Buffer): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeFile(this.pathFor(key), data, { flag: 'wx' });
  }

  read(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }
}
