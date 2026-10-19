// Vercel function: the whole API (every /api/* request is rewritten here, see vercel.json).
// The bundle is built by scripts/vercel-build.mjs before Vercel packages this function.
export { default } from '../apps/api/dist/vercel.js';
