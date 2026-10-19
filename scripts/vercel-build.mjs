/**
 * Vercel build: the API bundle (with Prisma Client for the build machine's Linux), the shop at / and the back office
 * at /admin, assembled into one static output directory. See docs/DEPLOYMENT.md, "Vercel".
 */
import { execSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';

const run = (cmd, env = {}) => execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });

run('npm run build -w @rhoyards/api');
run('npm run build -w @rhoyards/storefront');
run('npm run build -w @rhoyards/backoffice', { BACKOFFICE_BASE: '/admin/' });

const out = 'vercel-dist';
rmSync(out, { recursive: true, force: true });
cpSync('apps/storefront/dist', out, { recursive: true });
cpSync('apps/backoffice/dist', `${out}/admin`, { recursive: true });
console.log(`Static output assembled in ${out}/ (shop at /, back office at /admin/)`);
