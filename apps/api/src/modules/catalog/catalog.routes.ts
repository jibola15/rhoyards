import { Router } from 'express';
import { z } from 'zod';
import {
  brandInputSchema,
  brandUpdateSchema,
  categoryInputSchema,
  categoryUpdateSchema,
  productInputSchema,
  productListQuerySchema,
  productUpdateSchema,
  unitInputSchema,
  unitUpdateSchema,
  variantInputSchema,
  variantSearchQuerySchema,
  variantUpdateSchema,
} from '@rhoyards/shared';
import { requestContext } from '../../lib/audit';
import { listEnvelope } from '../../lib/pagination';
import { parse } from '../../lib/validation';
import { registry } from '../../openapi/registry';
import { requirePermission } from '../auth/auth.middleware';
import {
  addProductImage,
  addVariant,
  createProduct,
  findVariantByCode,
  getProduct,
  listProducts,
  removeProductImage,
  searchVariants,
  setProductArchived,
  setVariantArchived,
  updateProduct,
  updateVariant,
} from './products.service';
import {
  createBrand,
  createCategory,
  createUnit,
  listBrands,
  listCategories,
  listUnits,
  updateBrand,
  updateCategory,
  updateUnit,
} from './taxonomy.service';

const idParams = z.object({ id: z.uuid() });
const imageParams = z.object({ id: z.uuid(), imageId: z.uuid() });
const imageInput = z.object({ fileId: z.uuid(), altText: z.string().trim().max(200).optional(), variantId: z.uuid().nullable().optional() });
const json = <T extends z.ZodType>(schema: T) => ({ body: { content: { 'application/json': { schema } } } });

for (const [path, name, create, update] of [
  ['/brands', 'Brands', brandInputSchema, brandUpdateSchema],
  ['/categories', 'Categories', categoryInputSchema, categoryUpdateSchema],
  ['/units', 'Units', unitInputSchema, unitUpdateSchema],
] as const) {
  registry.registerPath({ method: 'get', path, tags: ['Catalogue'], summary: `List ${name.toLowerCase()} (catalog.view)`, responses: { 200: { description: name } } });
  registry.registerPath({ method: 'post', path, tags: ['Catalogue'], summary: `Create (catalog.manage)`, request: json(create), responses: { 201: { description: 'Created' } } });
  registry.registerPath({
    method: 'patch',
    path: `${path}/{id}`,
    tags: ['Catalogue'],
    summary: 'Update or deactivate (catalog.manage)',
    request: { params: idParams, ...json(update) },
    responses: { 200: { description: 'Updated' } },
  });
}
registry.registerPath({ method: 'get', path: '/products', tags: ['Catalogue'], summary: 'Search/list products (catalog.view)', request: { query: productListQuerySchema }, responses: { 200: { description: 'Products' } } });
registry.registerPath({ method: 'post', path: '/products', tags: ['Catalogue'], summary: 'Create a product with its variants (catalog.manage)', request: json(productInputSchema), responses: { 201: { description: 'Created' }, 409: { description: 'SKU or barcode in use' } } });
registry.registerPath({ method: 'get', path: '/products/{id}', tags: ['Catalogue'], summary: 'Product with variants and images', request: { params: idParams }, responses: { 200: { description: 'Product' } } });
registry.registerPath({ method: 'patch', path: '/products/{id}', tags: ['Catalogue'], summary: 'Update product fields (catalog.manage)', request: { params: idParams, ...json(productUpdateSchema) }, responses: { 200: { description: 'Updated' } } });
registry.registerPath({ method: 'post', path: '/products/{id}/archive', tags: ['Catalogue'], summary: 'Archive (requires zero stock) (catalog.manage)', request: { params: idParams }, responses: { 200: { description: 'Archived' } } });
registry.registerPath({ method: 'post', path: '/products/{id}/restore', tags: ['Catalogue'], summary: 'Restore an archived product (catalog.manage)', request: { params: idParams }, responses: { 200: { description: 'Restored' } } });
registry.registerPath({ method: 'post', path: '/products/{id}/variants', tags: ['Catalogue'], summary: 'Add a variant (catalog.manage)', request: { params: idParams, ...json(variantInputSchema) }, responses: { 201: { description: 'Product with new variant' } } });
registry.registerPath({ method: 'patch', path: '/variants/{id}', tags: ['Catalogue'], summary: 'Update a variant: SKU, prices, barcodes, attributes (catalog.manage)', request: { params: idParams, ...json(variantUpdateSchema) }, responses: { 200: { description: 'Product' } } });
registry.registerPath({ method: 'post', path: '/variants/{id}/archive', tags: ['Catalogue'], summary: 'Archive a variant (zero stock) (catalog.manage)', request: { params: idParams }, responses: { 200: { description: 'Product' } } });
registry.registerPath({ method: 'get', path: '/variants', tags: ['Catalogue'], summary: 'Search sellable variants with stock at a location', request: { query: variantSearchQuerySchema }, responses: { 200: { description: 'Variants' } } });
registry.registerPath({ method: 'get', path: '/variants/by-code/{code}', tags: ['Catalogue'], summary: 'Exact barcode/SKU lookup (scanner)', responses: { 200: { description: 'Variant' }, 404: { description: 'Unknown code' } } });
registry.registerPath({ method: 'post', path: '/products/{id}/images', tags: ['Catalogue'], summary: 'Attach an uploaded image (catalog.manage)', request: { params: idParams, ...json(imageInput) }, responses: { 200: { description: 'Product' } } });
registry.registerPath({ method: 'delete', path: '/products/{id}/images/{imageId}', tags: ['Catalogue'], summary: 'Detach an image (catalog.manage)', request: { params: imageParams }, responses: { 200: { description: 'Product' } } });

export const catalogRouter = Router();
const view = requirePermission('catalog.view');
const manage = requirePermission('catalog.manage');

// Brands, categories, units
catalogRouter.get('/brands', ...view, async (_req, res) => res.json({ data: await listBrands() }));
catalogRouter.post('/brands', ...manage, async (req, res) => {
  res.status(201).json({ data: await createBrand(parse(brandInputSchema, req.body), requestContext(req)) });
});
catalogRouter.patch('/brands/:id', ...manage, async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ data: await updateBrand(id, parse(brandUpdateSchema, req.body), requestContext(req)) });
});
catalogRouter.get('/categories', ...view, async (_req, res) => res.json({ data: await listCategories() }));
catalogRouter.post('/categories', ...manage, async (req, res) => {
  res.status(201).json({ data: await createCategory(parse(categoryInputSchema, req.body), requestContext(req)) });
});
catalogRouter.patch('/categories/:id', ...manage, async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ data: await updateCategory(id, parse(categoryUpdateSchema, req.body), requestContext(req)) });
});
catalogRouter.get('/units', ...view, async (_req, res) => res.json({ data: await listUnits() }));
catalogRouter.post('/units', ...manage, async (req, res) => {
  res.status(201).json({ data: await createUnit(parse(unitInputSchema, req.body), requestContext(req)) });
});
catalogRouter.patch('/units/:id', ...manage, async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ data: await updateUnit(id, parse(unitUpdateSchema, req.body), requestContext(req)) });
});

// Products
catalogRouter.get('/products', ...view, async (req, res) => {
  const query = parse(productListQuerySchema, req.query);
  const { data, total } = await listProducts(query);
  res.json(listEnvelope(data, total, query));
});
catalogRouter.post('/products', ...manage, async (req, res) => {
  res.status(201).json({ data: await createProduct(parse(productInputSchema, req.body), requestContext(req)) });
});
catalogRouter.get('/products/:id', ...view, async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ data: await getProduct(id) });
});
catalogRouter.patch('/products/:id', ...manage, async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ data: await updateProduct(id, parse(productUpdateSchema, req.body), requestContext(req)) });
});
catalogRouter.post('/products/:id/archive', ...manage, async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ data: await setProductArchived(id, true, requestContext(req)) });
});
catalogRouter.post('/products/:id/restore', ...manage, async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ data: await setProductArchived(id, false, requestContext(req)) });
});
catalogRouter.post('/products/:id/variants', ...manage, async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.status(201).json({ data: await addVariant(id, parse(variantInputSchema, req.body), requestContext(req)) });
});
catalogRouter.post('/products/:id/images', ...manage, async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ data: await addProductImage(id, parse(imageInput, req.body), requestContext(req)) });
});
catalogRouter.delete('/products/:id/images/:imageId', ...manage, async (req, res) => {
  const { id, imageId } = parse(imageParams, req.params);
  res.json({ data: await removeProductImage(id, imageId, requestContext(req)) });
});

// Variants
catalogRouter.get('/variants', ...view, async (req, res) => {
  const query = parse(variantSearchQuerySchema, req.query);
  const { data, total } = await searchVariants(query);
  res.json(listEnvelope(data, total, query));
});
catalogRouter.get('/variants/by-code/:code', ...view, async (req, res) => {
  const { code } = parse(z.object({ code: z.string().trim().min(1).max(64) }), req.params);
  const { locationId } = parse(z.object({ locationId: z.uuid().optional() }), req.query);
  res.json({ data: await findVariantByCode(code, locationId) });
});
catalogRouter.patch('/variants/:id', ...manage, async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ data: await updateVariant(id, parse(variantUpdateSchema, req.body), requestContext(req)) });
});
catalogRouter.post('/variants/:id/archive', ...manage, async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ data: await setVariantArchived(id, true, requestContext(req)) });
});
catalogRouter.post('/variants/:id/restore', ...manage, async (req, res) => {
  const { id } = parse(idParams, req.params);
  res.json({ data: await setVariantArchived(id, false, requestContext(req)) });
});
