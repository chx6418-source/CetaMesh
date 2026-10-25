#import "RCTCetaNotificationSend.h"
#import "CetaMeshMobile-Swift.h"

@implementation RCTCetaNotificationSend {
  CetaNotificationSend *_sender;
}

+ (NSString *)moduleName { return @"CetaNotificationSend"; }
+ (BOOL)requiresMainQueueSetup { return YES; }

- (instancetype)init {
  if ((self = [super init])) _sender = [CetaNotificationSend new];
  return self;
}

- (void)send:(NSString *)payload resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_sender send:payload completion:^(NSString *raw, NSString *code) {
    if (code) reject(code, @"Notification delivery was unavailable", nil);
    else resolve(nil);
  }];
}

- (void)cancel { [_sender cancel]; }
- (void)invalidate { [_sender cancel]; }

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeCetaNotificationSendSpecJSI>(params);
}
@end
