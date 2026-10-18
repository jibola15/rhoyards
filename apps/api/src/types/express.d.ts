import type { AuthContext } from '../modules/auth/auth.types';

declare global {
  namespace Express {
    interface Request {
      /** Present when the request carries a valid staff session. */
      auth?: AuthContext;
    }
  }
}

export {};
