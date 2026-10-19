/** Data the E2E API seeds and the browser tests use. */
export const E2E = {
  owner: {
    email: 'e2e.owner@rhoyards.test',
    username: 'e2e.owner',
    password: 'e2e-owner-password-123',
    /** Authenticator secret seeded for the owner (test database only). */
    totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    /** Seeded backup codes, each usable once. */
    backupCodes: ['e2eaa-bbbb2', 'e2eaa-bbbb3', 'e2eaa-bbbb4', 'e2eaa-bbbb5'],
  },
  product: { name: 'Shea Butter Cream', sku: 'E2E-SHEA-250', price: '2500.00' },
  urls: { backoffice: 'http://localhost:5273', storefront: 'http://localhost:5274', api: 'http://localhost:4100' },
} as const;
