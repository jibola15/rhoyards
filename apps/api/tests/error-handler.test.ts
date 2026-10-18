import express from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError, businessRule } from '../src/lib/errors';
import { parse } from '../src/lib/validation';
import { errorHandler } from '../src/middleware/error-handler';

function appThrowing(fn: () => unknown) {
  const logger = pino({ level: 'silent' });
  const errorSpy = vi.spyOn(logger, 'error');
  const app = express();
  app.use(express.json());
  app.post('/t', () => {
    fn();
  });
  app.use(errorHandler(logger));
  return { app, errorSpy };
}

describe('central error handler', () => {
  it('maps AppError to its status, code and details', async () => {
    const { app } = appThrowing(() => {
      throw businessRule('Refund exceeds refundable amount', { refundable: '500.00' });
    });
    const res = await request(app).post('/t');
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({
      code: 'BUSINESS_RULE',
      message: 'Refund exceeds refundable amount',
      details: { refundable: '500.00' },
    });
  });

  it('maps Zod validation failures to 400 with field paths', async () => {
    const schema = z.object({ sku: z.string().min(1), price: z.string() });
    const { app } = appThrowing(() => parse(schema, { sku: '' }));
    const res = await request(app).post('/t');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const paths = (res.body.error.details as { path: string }[]).map((d) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['sku', 'price']));
  });

  it('hides internal details of unexpected errors and logs them', async () => {
    const { app, errorSpy } = appThrowing(() => {
      throw new Error('connection string postgres://secret@host leaked');
    });
    const res = await request(app).post('/t');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it('keeps AppError instances distinguishable', () => {
    const err = new AppError(409, 'CONFLICT', 'Duplicate SKU');
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(409);
  });
});
