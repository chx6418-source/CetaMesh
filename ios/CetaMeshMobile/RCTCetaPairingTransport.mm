#import "RCTCetaPairingTransport.h"
#import "CetaMeshMobile-Swift.h"
@implementation RCTCetaPairingTransport {CetaPairingTransport *_transport;}
+ (NSString *)moduleName {return @"CetaPairingTransport";}
+ (BOOL)requiresMainQueueSetup {return NO;}
- (instancetype)init {if ((self=[super init])) _transport=[CetaPairingTransport new];return self;}
- (void)post:(NSString *)url body:(NSString *)body requestId:(NSString *)requestId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_transport post:url body:body requestId:requestId completion:^(NSString *raw,NSString *code){if(code) reject(code,@"Pairing request failed",nil);else resolve(raw);}];
}
- (void)cancel:(NSString *)requestId {[_transport cancel:requestId];}
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeCetaPairingTransportSpecJSI>(params);
}
@end
