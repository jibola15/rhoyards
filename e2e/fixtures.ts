/** Data the E2E API seeds and the browser tests use. */
export const E2E = {
  owner: { email: 'e2e.owner@rhoyards.test', password: 'e2e-owner-password-123' },
  product: { name: 'Shea Butter Cream', sku: 'E2E-SHEA-250', price: '2500.00' },
  urls: { backoffice: 'http://localhost:5273', storefront: 'http://localhost:5274', api: 'http://localhost:4100' },
} as const;
