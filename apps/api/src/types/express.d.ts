import type { AuthContext } from '../modules/auth/auth.types';
import type { CustomerContext } from '../modules/store/customer-auth';

declare global {
  namespace Express {
    interface Request {
      /** Present when the request carries a valid staff session. */
      auth?: AuthContext;
      /** Present on /store routes when the request carries a valid customer (storefront) session. */
      customer?: CustomerContext;
      /** The unparsed body, kept for verifying webhook signatures. */
      rawBody?: Buffer;
    }
  }
}

export {};
