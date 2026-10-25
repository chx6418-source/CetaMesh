import {parseInvitation,transcript,payloadHash,meshSigningString} from '../protocol/PairingProtocol';
import type {PairingPhase} from '../protocol/PairingProtocol';
import type {DeviceIdentity} from '../domain/identity/DeviceIdentity';
import {NodeDeviceCrypto} from './helpers/PairingPeer';

type Fixture<E={type:string;timestamp:string;payload:Record<string,unknown>}>={description:string;now?:string;expect:'accept'|'reject';envelope:E};
type Exchange={type:string;timestamp:string;payload:{token:string;nonce:string;device:DeviceIdentity;signature:string}};
type Proof={type:string;timestamp:string;payload:{nonce:string;signature:string;peer:{publicKey:string}}};
type Mesh={type:string;id:string;timestamp:string;from:string;to:string;nonce:string;payload:unknown;ph:string;signature:string};

const invitationV1=require('./fixtures/pairing/invitation-v1.json') as Fixture;
const invitationV11=require('./fixtures/pairing/invitation-v1.1.json') as Fixture;
const expired=require('./fixtures/pairing/expired.json') as Fixture;
const transcripts=require('./fixtures/pairing/transcripts-v1.1.json') as {device:{deviceId:string;publicKey:string};nonce:string;phases:Record<string,string>};
const exchange=require('./fixtures/pairing/exchange-v1.1.json') as Fixture<Exchange>;
const confirm=require('./fixtures/pairing/confirm-v1.1.json') as Fixture<Proof>;
const challenge=require('./fixtures/pairing/challenge-v1.1.json') as Fixture<Proof>;
const accepted=require('./fixtures/pairing/accepted-v1.1.json') as Fixture<Proof>;
const badSignature=require('./fixtures/pairing/bad-signature.json') as Fixture<Exchange>;
const meshPing=require('./fixtures/pairing/mesh-presence-ping-v1.1.json') as Fixture<Mesh>;
const keys=require('./fixtures/pairing/test-keys.json') as {desktop:{x963:string};mobile:{x963:string}};
const crypto=new NodeDeviceCrypto();
const off='A'.repeat(64);
const pinnedInvitation=()=>JSON.parse(JSON.stringify(invitationV11.envelope)) as {payload:{tlsPin?:unknown;peer:{keyAlgorithm?:unknown}}};

it('accepts pinned v1.1 invitations, keeps v1 invitations and rejects malformed new fields',()=>{
 const pinned=parseInvitation(JSON.stringify(invitationV11.envelope),Date.parse(invitationV11.now!));
 expect(pinned.tlsPin).toBe('40e4375dd1c37454aee2285c12b01d05c966a317e346554e1088a81e6bd30308');
 expect(pinned.peer.keyAlgorithm).toBe('p256');
 const unpinned=parseInvitation(JSON.stringify(invitationV1.envelope),Date.parse(invitationV1.now!));
 expect(unpinned).not.toHaveProperty('tlsPin');
 expect(unpinned.peer).not.toHaveProperty('keyAlgorithm');
 for(const tlsPin of [off,'a'.repeat(63),'g'.repeat(64),'a'.repeat(65),'0X'+'a'.repeat(62)]){
  const raw=pinnedInvitation();raw.payload.tlsPin=tlsPin;
  expect(()=>parseInvitation(JSON.stringify(raw),Date.parse(invitationV11.now!))).toThrow(expect.objectContaining({code:'invalid_protocol'}));
 }
 for(const keyAlgorithm of ['rsa','P-256','',0]){
  const raw=pinnedInvitation();raw.payload.peer.keyAlgorithm=keyAlgorithm;
  expect(()=>parseInvitation(JSON.stringify(raw),Date.parse(invitationV11.now!))).toThrow(expect.objectContaining({code:'invalid_protocol'}));
 }
 const raw=pinnedInvitation();delete raw.payload.tlsPin;delete raw.payload.peer.keyAlgorithm;
 expect(parseInvitation(JSON.stringify(raw),Date.parse(invitationV11.now!))).not.toHaveProperty('tlsPin');
});

it('keeps the v1 transcript a ten-element array when the invitation has no pin',()=>{
 const invitation=parseInvitation(JSON.stringify(invitationV1.envelope),Date.parse(invitationV1.now!));
 const device={deviceId:'mobile-1',publicKey:'B'+'A'.repeat(86)+'='};
 for(const phase of ['exchange','challenge','confirm','accepted'] as PairingPhase[]){
  const value=transcript(invitation,device,'A'.repeat(43)+'=',phase);
  expect(value).toBe(JSON.stringify(['cetamesh-pairing-v1',phase,invitation.invitationId,invitation.endpoint,invitation.peer.deviceId,invitation.peer.publicKey,device.deviceId,device.publicKey,'A'.repeat(43)+'=',invitation.expiresAt]));
  expect(JSON.parse(value)).toHaveLength(10);
 }
});

it('reproduces the frozen v1.1 transcripts byte-for-byte for every phase',()=>{
 const invitation=parseInvitation(JSON.stringify(invitationV11.envelope),Date.parse(invitationV11.now!));
 expect(Object.keys(transcripts.phases).sort()).toEqual(['accepted','challenge','confirm','exchange']);
 for(const [phase,expected] of Object.entries(transcripts.phases)){
  expect(transcript(invitation,transcripts.device,transcripts.nonce,phase as PairingPhase)).toBe(expected);
 }
});

it('verifies the frozen exchange, response and mesh vectors with the test keys',async()=>{
 const now=Date.parse(invitationV11.now!),invitation=parseInvitation(JSON.stringify(invitationV11.envelope),now);
 const e=exchange.envelope.payload;
 expect(await crypto.verify(keys.mobile.x963,transcript(invitation,e.device,e.nonce,'exchange'),e.signature)).toBe(true);
 expect(await crypto.verify(keys.mobile.x963,transcript(invitation,transcripts.device,transcripts.nonce,'confirm'),confirm.envelope.payload.signature)).toBe(true);
 expect(await crypto.verify(keys.desktop.x963,transcript(invitation,transcripts.device,transcripts.nonce,'challenge'),challenge.envelope.payload.signature)).toBe(true);
 expect(await crypto.verify(keys.desktop.x963,transcript(invitation,transcripts.device,transcripts.nonce,'accepted'),accepted.envelope.payload.signature)).toBe(true);
 const bad=badSignature.envelope.payload;
 expect(await crypto.verify(keys.mobile.x963,transcript(invitation,bad.device,bad.nonce,'exchange'),bad.signature)).toBe(false);
});

it('rejects the expired invitation at the fixture clock',()=>{
 expect(()=>parseInvitation(JSON.stringify(expired.envelope),Date.parse(expired.now!))).toThrow(expect.objectContaining({code:'invalid_protocol'}));
});

it('hashes the mesh payload and signs the exact mesh signing string',async()=>{
 const e=meshPing.envelope;
 expect(payloadHash(e.payload)).toBe(e.ph);
 expect(payloadHash({})).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
 expect(meshSigningString(e.type,e.id,e.from,e.to,e.timestamp,e.nonce,e.ph)).toBe(JSON.stringify(['cetamesh-mesh-v1',e.type,e.id,e.from,e.to,e.timestamp,e.nonce,e.ph]));
 expect(await crypto.verify(keys.mobile.x963,meshSigningString(e.type,e.id,e.from,e.to,e.timestamp,e.nonce,e.ph),e.signature)).toBe(true);
});
