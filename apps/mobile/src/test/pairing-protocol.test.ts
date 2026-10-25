import {parseInvitation, validateEnvelope, transcript, endpointOrigin} from '../protocol/PairingProtocol';
// React Native's internal URL fixture is shipped as Flow, without TS declarations.
// eslint-disable-next-line @react-native/no-deep-imports -- Exercise the actual RN polyfill; no public URL export exists.
const {URL:ReactNativeURL}=require('react-native/Libraries/Blob/URL') as {URL:typeof URL};
const now=Date.parse('2026-09-30T00:00:00.000Z');
const key='B'+'A'.repeat(86)+'=';
const qr=()=>({protocol:'cetamesh',version:1,id:'event-1',type:'pairing.invitation',timestamp:new Date(now).toISOString(),payload:{invitationId:'invite-1',endpoint:'https://desktop.example',token:'A'.repeat(43)+'=',expiresAt:new Date(now+60000).toISOString(),peer:{deviceId:'desktop-1',deviceName:'Desktop',publicKey:key}}});
it('projects known fields without binding UI or accepting arbitrary message types',()=>{
  const v=qr(); const parsed=parseInvitation(JSON.stringify({...v,extra:1}),now);
  expect(parsed.peer.deviceId).toBe('desktop-1'); expect(parsed).not.toHaveProperty('extra');
  expect(()=>validateEnvelope({...v,type:'shell.execute'},now)).toThrow(expect.objectContaining({code:'invalid_protocol'}));
  expect(()=>validateEnvelope({...v,version:2},now)).toThrow();
});
it('rejects expired, excessively long and malformed invitations',()=>{
  for(const expiresAt of [new Date(now).toISOString(),new Date(now+300001).toISOString(),'2026']){
    const v=qr();v.payload.expiresAt=expiresAt;expect(()=>parseInvitation(JSON.stringify(v),now)).toThrow();
  }
  const v=qr();v.payload.token='secret';expect(()=>parseInvitation(JSON.stringify(v),now)).toThrow();
  expect(()=>parseInvitation(' '.repeat(8193),now)).toThrow();
  expect(()=>parseInvitation('{',now)).toThrow(expect.objectContaining({message:'Invalid CetaMesh protocol'}));
});
it('rejects unsafe endpoints and accepts HTTPS LAN endpoints',()=>{
  for(const endpoint of ['http://host','https://u:p@host','https://host/path','https://host?token=x','https://localhost','https://127.0.0.1','https://host/#x']){
    const v=qr();v.payload.endpoint=endpoint;expect(()=>parseInvitation(JSON.stringify(v),now)).toThrow();
  }
  const v=qr();v.payload.endpoint='https://192.168.1.2:8443';expect(parseInvitation(JSON.stringify(v),now).endpoint).toBe(v.payload.endpoint);
});
it('schema checks every known payload and timestamps',()=>{
  const v=qr(); expect(()=>validateEnvelope({...v,type:'pairing.challenge',payload:{}},now)).toThrow();
  expect(()=>validateEnvelope({...v,timestamp:'2026-02-30T00:00:00.000Z'},now)).toThrow();
  expect(()=>validateEnvelope({...v,timestamp:new Date(now+60000).toISOString()},now)).toThrow();
});
it('binds both keys, endpoint, nonce, expiry and protocol phase',()=>{
  const invitation=parseInvitation(JSON.stringify(qr()),now); const device={deviceId:'mobile-1',publicKey:key};
  const base=transcript(invitation,device,'A'.repeat(43)+'=','exchange');
  expect(transcript(invitation,device,'A'.repeat(43)+'=','confirm')).not.toBe(base);
  expect(transcript({...invitation,endpoint:'https://other.example'},device,'A'.repeat(43)+'=','exchange')).not.toBe(base);
  expect(transcript(invitation,{...device,deviceId:'mobile-2'},'A'.repeat(43)+'=','exchange')).not.toBe(base);
});
it('rejects ambiguous hosts and invalid ports with both Node and the actual RN URL implementation',()=>{
 const original=global.URL;
 try {
  for(const implementation of [original,ReactNativeURL]){
   global.URL=implementation as typeof URL;
   for(const value of ['https://host:65536','https://host:0','https://host:0443','https://LOCALHOST','https://localhost.','https://a.localhost.','https://[::1]','https://[0:0:0:0:0:0:0:1]','https://2130706433','https://0x7f000001','https://0177.0.0.1','https://127.1','https://127.0.0.2','https://host\\evil','https://host:443']){
    expect(()=>endpointOrigin(value)).toThrow(expect.objectContaining({code:'invalid_protocol'}));
   }
   expect(endpointOrigin('https://peer.example:65535')).toBe('https://peer.example:65535');
   expect(endpointOrigin('https://192.168.1.2:8443')).toBe('https://192.168.1.2:8443');
  }
 }finally{global.URL=original;}
});
