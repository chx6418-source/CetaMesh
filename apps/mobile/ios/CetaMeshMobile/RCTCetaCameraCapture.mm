#import "RCTCetaCameraCapture.h"
#import "CetaMeshMobile-Swift.h"

@implementation RCTCetaCameraCapture {
  CetaCameraCapture *_capture;
}

+ (NSString *)moduleName { return @"CetaCameraCapture"; }
+ (BOOL)requiresMainQueueSetup { return YES; }

- (instancetype)init {
  if ((self = [super init])) _capture = [CetaCameraCapture new];
  return self;
}

- (void)capture:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_capture captureWithCompletion:^(NSString *raw, NSString *code) {
    if (code) reject(code, @"Camera capture is unavailable", nil);
    else resolve(raw);
  }];
}

- (void)cancel { [_capture cancel]; }
- (void)invalidate { [_capture cancel]; }

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeCetaCameraCaptureSpecJSI>(params);
}
@end
