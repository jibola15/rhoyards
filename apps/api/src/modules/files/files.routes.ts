import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requestContext } from '../../lib/audit';
import { AppError, unauthenticated } from '../../lib/errors';
import type { FileStorage } from '../../lib/storage';
import { parse } from '../../lib/validation';
import { registry } from '../../openapi/registry';
import { requirePermission } from '../auth/auth.middleware';
import { readFile, uploadImage } from './files.service';

registry.registerPath({
  method: 'post',
  path: '/files/images',
  tags: ['Files'],
  summary: 'Upload a product image (multipart field "file"; JPEG/PNG/WebP; re-encoded to WebP) (catalog.manage)',
  responses: { 201: { description: 'Stored image' }, 400: { description: 'Not an allowed image' }, 413: { description: 'Too large' } },
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

  router.post('/files/images', ...requirePermission('catalog.manage'), (req, res, next) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        next(
          err.code === 'LIMIT_FILE_SIZE'
            ? new AppError(413, 'PAYLOAD_TOO_LARGE', `Images must be at most ${maxUploadMb} MB`)
            : new AppError(400, 'VALIDATION_ERROR', err.message, { field: 'file' }),
        );
        return;
      }
      if (err) {
        next(err);
        return;
      }
      if (!req.file) {
        next(new AppError(400, 'VALIDATION_ERROR', 'Attach an image in the "file" field', { field: 'file' }));
        return;
      }
      uploadImage(storage, req.file.buffer, req.file.originalname, requestContext(req))
        .then((stored) => res.status(201).json({ data: stored }))
        .catch(next);
    });
  });

  router.get('/files/:id', async (req, res) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const { file, data } = await readFile(storage, id);
    if (file.visibility === 'PRIVATE' && !req.auth) throw unauthenticated();
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', String(data.length));
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', file.visibility === 'PUBLIC' ? 'public, max-age=31536000, immutable' : 'private, no-store');
    res.send(data);
  });

  return router;
}
