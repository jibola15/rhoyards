import { createHash, randomUUID } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { writeAudit, type RequestContext } from '../../lib/audit';
import { AppError, notFound } from '../../lib/errors';
import { getPrisma } from '../../lib/prisma';
import type { FileStorage } from '../../lib/storage';

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_DIMENSION = 1600;

export interface StoredFile {
  id: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
}

export const fileUrl = (id: string) => `/api/v1/files/${id}`;

/**
 * Accepts a JPEG/PNG/WebP image, verified by its magic bytes (not the client's filename or MIME type),
 * and stores a re-encoded WebP copy. Re-encoding strips metadata (e.g. GPS EXIF) and neutralises
 * polyglot files: the stored bytes are always produced by the server.
 */
export async function uploadImage(storage: FileStorage, buffer: Buffer, originalName: string, ctx: RequestContext): Promise<StoredFile> {
  const detected = await fileTypeFromBuffer(buffer);
  if (!detected || !ALLOWED_IMAGE_TYPES.has(detected.mime)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Only JPEG, PNG or WebP images can be uploaded', { field: 'file' });
  }

  let output: { data: Buffer; info: sharp.OutputInfo };
  try {
    output = await sharp(buffer, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'The image could not be processed', { field: 'file' });
  }

  const id = randomUUID();
  const storageKey = `${id}.webp`;
  await storage.put(storageKey, output.data);

  const safeName = originalName.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'image';
  const file = await getPrisma().file.create({
    data: {
      id,
      storageKey,
      originalName: safeName,
      mimeType: 'image/webp',
      sizeBytes: output.data.length,
      sha256: createHash('sha256').update(output.data).digest('hex'),
      width: output.info.width,
      height: output.info.height,
      visibility: 'PUBLIC',
      uploadedById: ctx.actorId!,
    },
  });
  await writeAudit(getPrisma(), ctx, {
    action: 'file.uploaded',
    entityType: 'file',
    entityId: file.id,
    after: { originalName: safeName, sizeBytes: file.sizeBytes },
  });
  return { id: file.id, url: fileUrl(file.id), mimeType: file.mimeType, sizeBytes: file.sizeBytes, width: file.width, height: file.height };
}

export async function readFile(storage: FileStorage, id: string) {
  const file = await getPrisma().file.findUnique({ where: { id } });
  if (!file) throw notFound('File');
  return { file, data: await storage.read(file.storageKey) };
}
