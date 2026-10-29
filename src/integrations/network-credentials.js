import { integrationError } from './types.js';

/** Resolve only dedicated plugin credentials, bound to their saved HTTPS endpoint.
 * Model-provider credentials are never implicitly made available to a plugin.
 */
export function createNetworkCredentialResolver(secrets) {
  return (reference, target, {transport}={}) => {
    if (typeof reference !== 'string' || !/^plugin-[a-z0-9][a-z0-9._-]{0,55}$/.test(reference)) throw integrationError('NETWORK_CREDENTIAL_DENIED', 'A dedicated plugin credential reference is required');
    const entry = secrets.raw(reference);
    let base, url;
    try { base = new URL(entry.baseUrl); url = new URL(target); } catch { throw integrationError('NETWORK_CREDENTIAL_DENIED', 'Credential endpoint binding is missing'); }
    const prefix = base.pathname.replace(/\/+$/, '');
    const webhook=transport==='webhook'&&base.protocol==='http:'&&base.hostname==='127.0.0.1';
    if ((!webhook && base.protocol !== 'https:') || base.username || base.password || base.search || base.hash || url.origin !== base.origin || (prefix && url.pathname !== prefix && !url.pathname.startsWith(prefix + '/'))) throw integrationError('NETWORK_CREDENTIAL_DENIED', 'Credential is not authorized for this endpoint');
    return entry.apiKey;
  };
}
