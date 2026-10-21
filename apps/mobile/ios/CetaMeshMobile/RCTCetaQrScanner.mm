#import "RCTCetaQrScanner.h"
#import "CetaMeshMobile-Swift.h"
@implementation RCTCetaQrScanner {CetaQrScanner *_scanner;}
+ (NSString *)moduleName {return @"CetaQrScanner";}
+ (BOOL)requiresMainQueueSetup {return YES;}
- (instancetype)init {if ((self=[super init])) _scanner=[CetaQrScanner new];return self;}
- (void)scan:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_scanner scanWithCompletion:^(NSString *raw,NSString *code) {
    if(code) reject(code,@"QR scanning is unavailable",nil);else resolve(raw);
  }];
}
- (void)cancel {[_scanner cancel];}
- (void)invalidate {[_scanner cancel];}
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeCetaQrScannerSpecJSI>(params);
}
@end
