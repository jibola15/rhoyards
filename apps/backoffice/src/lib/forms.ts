import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { ApiError } from '@rhoyards/shared';

/**
 * Maps a server error onto form fields where possible (Zod `details[].path` or `details.field`)
 * and returns a message for anything that could not be attached to a field.
 */
export function applyServerErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  fields: readonly string[],
): string | null {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : 'Something went wrong';
  const details = error.details as { path?: string; message?: string }[] | { field?: string } | undefined;
  let attached = false;
  if (Array.isArray(details)) {
    for (const d of details) {
      const name = d.path?.split('.')[0];
      if (name && fields.includes(name)) {
        setError(name as Path<T>, { message: d.message ?? error.message });
        attached = true;
      }
    }
  } else if (details?.field && fields.includes(details.field)) {
    setError(details.field as Path<T>, { message: error.message });
    attached = true;
  }
  return attached ? null : error.message;
}
