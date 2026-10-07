export const LEGACY_BRIDGE_TEST_OPT_IN = 'WHALEBRIDGE_TEST_LEGACY_BRIDGE';

export function isLegacyBridgeTestOptedIn(env = process.env) {
  return env[LEGACY_BRIDGE_TEST_OPT_IN] === '1';
}
