#import "RCTCetaDeviceIdentity.h"
#import "CetaMeshMobile-Swift.h"

static void CetaReject(RCTPromiseRejectBlock reject, NSString *code) {
  NSString *message = @"Device identity is unavailable";
  if ([code isEqualToString:@"invalid_protocol"]) message = @"Invalid identity input";
  if ([code isEqualToString:@"unsupported"]) message = @"Secure device identity is unsupported";
  // Do not attach Security.framework errors or private native diagnostics.
  reject(code, message, nil);
}

@implementation RCTCetaDeviceIdentity {
  CetaDeviceIdentity *_identity;
}

+ (NSString *)moduleName { return @"CetaDeviceIdentity"; }
+ (BOOL)requiresMainQueueSetup { return NO; }

- (instancetype)init {
  if ((self = [super init])) {
    _identity = [CetaDeviceIdentity new];
  }
  return self;
}

- (void)getIdentity:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_identity getIdentityWithCompletion:^(NSString *result, NSString *code) {
    if (code) CetaReject(reject, code); else resolve(result);
  }];
}

- (void)sign:(NSString *)data resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_identity sign:data completion:^(NSString *result, NSString *code) {
    if (code) CetaReject(reject, code); else resolve(result);
  }];
}

- (void)verify:(NSString *)publicKey data:(NSString *)data signature:(NSString *)signature
       resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_identity verify:publicKey data:data signature:signature completion:^(BOOL valid, NSString *code) {
    if (code) CetaReject(reject, code); else resolve(@(valid));
  }];
}

- (void)fingerprint:(NSString *)token resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_identity fingerprint:token completion:^(NSString *value,NSString *code) {
    if (code) CetaReject(reject,code); else resolve(value);
  }];
}

- (void)randomNonce:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_identity randomNonceWithCompletion:^(NSString *result, NSString *code) {
    if (code) CetaReject(reject, code); else resolve(result);
  }];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeCetaDeviceIdentitySpecJSI>(params);
}
@end
