import { rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPrisma } from '../../src/lib/prisma';
import { createStaff, resetDatabase, TEST_PASSWORD } from '../helpers/db';
import { makeProduct } from '../helpers/catalog';
import { API_DIR } from '../helpers/test-db-env';
import { buildTestApp, signIn } from '../helpers/test-app';

const uploadDir = path.join(API_DIR, 'storage', 'test-uploads');
const app = buildTestApp({ UPLOAD_DIR: uploadDir, MAX_UPLOAD_MB: '1' });
let officer: Awaited<ReturnType<typeof signIn>>;
let officerId: string;

beforeAll(async () => {
  await resetDatabase();
  const o = await createStaff('INVENTORY_OFFICER');
  officerId = o.user.id;
  officer = await signIn(app, o.email, TEST_PASSWORD);
});

afterAll(async () => {
  await rm(uploadDir, { recursive: true, force: true });
});

const png = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 40, b: 90 } } }).png().toBuffer();

const upload = (buffer: Buffer, filename: string) =>
  officer.agent.post('/api/v1/files/images').set('X-CSRF-Token', officer.csrf).attach('file', buffer, filename);

describe('image uploads', () => {
  it('stores a re-encoded, size-capped WebP and serves it publicly', async () => {
    const res = await upload(await png(3000, 2000), 'Lipstick photo.png');
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ mimeType: 'image/webp', width: 1600, height: 1067 });

    const served = await request(app).get(res.body.data.url);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/webp');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect((await sharp(served.body as Buffer).metadata()).format).toBe('webp');
  });

  it('rejects files that are not images, whatever their name says', async () => {
    const res = await upload(Buffer.from('<script>alert(1)</script>'), 'evil.png');
    expect(res.status).toBe(400);
    expect(res.body.error.details.field).toBe('file');
  });

  it('rejects oversized uploads', async () => {
    const big = await sharp({ create: { width: 2500, height: 2500, channels: 3, background: '#888' } })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(big.length).toBeGreaterThan(1024 * 1024);
    expect((await upload(big, 'big.png')).status).toBe(413);
  });

  it('requires catalog.manage to upload', async () => {
    const cashier = await signIn(app, (await createStaff('CASHIER')).email, TEST_PASSWORD);
    const res = await cashier.agent.post('/api/v1/files/images').set('X-CSRF-Token', cashier.csrf).attach('file', await png(10, 10), 'a.png');
    expect(res.status).toBe(403);
  });

  it('attaches an uploaded image to a product', async () => {
    const product = await makeProduct(officerId);
    const file = (await upload(await png(400, 400), 'p.png')).body.data;
    const res = await officer.agent.post(`/api/v1/products/${product.id}/images`).set('X-CSRF-Token', officer.csrf).send({ fileId: file.id, altText: 'Front' });
    expect(res.status).toBe(200);
    expect(res.body.data.images).toEqual([expect.objectContaining({ fileId: file.id, url: file.url, altText: 'Front' })]);
    expect(await getPrisma().productImage.count({ where: { productId: product.id } })).toBe(1);
  });
});
