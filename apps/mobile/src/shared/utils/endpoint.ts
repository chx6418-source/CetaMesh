import { CetaError } from '../errors/CetaError';
export function validateEndpoint(endpoint: string): string {
  if (
    !/^https:\/\/[a-zA-Z0-9.-]+(?::\d{1,5})?(?:\/[a-zA-Z0-9_./~-]*)?$/.test(
      endpoint,
    )
  ) {
    throw new CetaError(
      'invalid_protocol',
      'Use an HTTPS base URL without credentials, query or fragment',
    );
  }
  return endpoint.replace(/\/+$/, '');
}
