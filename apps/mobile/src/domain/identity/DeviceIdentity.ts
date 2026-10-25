import { CetaError } from '../../shared/errors/CetaError';
export type DeviceIdentity = {deviceId: string; deviceName: string; platform: 'android'|'ios'; publicKey: string; createdAt: string};
export interface IdentityProvider { getIdentity(): Promise<string>; }
export interface DeviceCrypto extends IdentityProvider {
  sign(data: string): Promise<string>;
  verify(publicKey: string, data: string, signature: string): Promise<boolean>;
  randomNonce(): Promise<string>;
  fingerprint(token:string):Promise<string>;
}
export function validateIdentity(value: unknown): DeviceIdentity {
  if (!value || typeof value !== 'object') {throw new CetaError('storage_error','Invalid device identity');}
  const v = value as Record<string, unknown>;
  if (typeof v.deviceId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(v.deviceId) ||
      typeof v.deviceName !== 'string' || !v.deviceName.trim() || v.deviceName.length>100 || Array.from(v.deviceName).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127) ||
      (v.platform !== 'android' && v.platform !== 'ios') ||
      typeof v.publicKey !== 'string' || !/^B[A-Za-z0-9+/]{86}=$/.test(v.publicKey) ||
      typeof v.createdAt !== 'string' || !Number.isFinite(Date.parse(v.createdAt)) || new Date(v.createdAt).toISOString() !== v.createdAt) {
    throw new CetaError('storage_error','Invalid device identity');
  }
  return {deviceId:v.deviceId,deviceName:v.deviceName,platform:v.platform,publicKey:v.publicKey,createdAt:v.createdAt};
}
