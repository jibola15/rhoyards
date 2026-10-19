import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requestContext } from '../../lib/audit';
import { AppError, forbidden, unauthenticated } from '../../lib/errors';
import type { FileStorage } from '../../lib/storage';
import { parse } from '../../lib/validation';
import { registry } from '../../openapi/registry';
import { requireAnyPermission, requirePermission } from '../auth/auth.middleware';
import { readFile, uploadDocument, uploadImage } from './files.service';

const DOCUMENT_READERS = ['expenses.view', 'expenses.create', 'expenses.approve'] as const;

registry.registerPath({
  method: 'post',
  path: '/files/images',
  tags: ['Files'],
  summary: 'Upload a product image (multipart field "file"; JPEG/PNG/WebP; re-encoded to WebP) (catalog.manage)',
  responses: { 201: { description: 'Stored image' }, 400: { description: 'Not an allowed image' }, 413: { description: 'Too large' } },
});
registry.registerPath({
  method: 'post',
  path: '/files/documents',
  tags: ['Files'],
  summary: 'Upload a private document such as an expense receipt (JPEG/PNG/WebP re-encoded, or PDF) (expenses.*)',
  responses: { 201: { description: 'Stored document' }, 400: { description: 'Not an allowed file' }, 413: { description: 'Too large' } },
});
registry.registerPath({
  method: 'get',
  path: '/files/{id}',
  tags: ['Files'],
  summary: 'Download a file. Public files (product images) need no session.',
  request: { params: z.object({ id: z.uuid() }) },
  responses: { 200: { description: 'File bytes' }, 404: { description: 'Not found' } },
});

export function filesRouter(storage: FileStorage, maxUploadMb: number) {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxUploadMb * 1024 * 1024, files: 1, fields: 5 },
  });

  /** Multipart upload of one file in the "file" field, handed to `store`. */
  const handleUpload =
    (what: string, store: (buffer: Buffer, name: string, ctx: ReturnType<typeof requestContext>) => Promise<unknown>): RequestHandler =>
    (req, res, next) => {
      upload.single('file')(req, res, (err: unknown) => {
        if (err instanceof multer.MulterError) {
          next(
            err.code === 'LIMIT_FILE_SIZE'
              ? new AppError(413, 'PAYLOAD_TOO_LARGE', `${what} must be at most ${maxUploadMb} MB`)
              : new AppError(400, 'VALIDATION_ERROR', err.message, { field: 'file' }),
          );
          return;
        }
        if (err) {
          next(err);
          return;
        }
        if (!req.file) {
          next(new AppError(400, 'VALIDATION_ERROR', 'Attach a file in the "file" field', { field: 'file' }));
          return;
        }
        store(req.file.buffer, req.file.originalname, requestContext(req))
          .then((stored) => res.status(201).json({ data: stored }))
          .catch(next);
      });
    };

  router.post('/files/images', ...requirePermission('catalog.manage'), handleUpload('Images', (b, n, c) => uploadImage(storage, b, n, c)));
  router.post('/files/documents', ...requireAnyPermission(...DOCUMENT_READERS), handleUpload('Documents', (b, n, c) => uploadDocument(storage, b, n, c)));

  router.get('/files/:id', async (req, res) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const { file, data } = await readFile(storage, id);
    if (file.visibility === 'PRIVATE') {
      // Private files today are expense receipts.
      if (!req.auth) throw unauthenticated();
      if (!DOCUMENT_READERS.some((p) => req.auth!.permissions.has(p))) throw forbidden();
    }
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', String(data.length));
    // PDFs are downloaded rather than rendered on our origin.
    res.setHeader('Content-Disposition', file.mimeType === 'application/pdf' ? `attachment; filename="${file.originalName.replace(/"/g, '')}"` : 'inline');
    res.setHeader('Cache-Control', file.visibility === 'PUBLIC' ? 'public, max-age=31536000, immutable' : 'private, no-store');
    res.send(data);
  });

  return router;
}
