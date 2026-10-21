#import "RCTCetaMicrophoneRecord.h"
#import "CetaMeshMobile-Swift.h"

@implementation RCTCetaMicrophoneRecord {
  CetaMicrophoneRecord *_recorder;
}

+ (NSString *)moduleName { return @"CetaMicrophoneRecord"; }
+ (BOOL)requiresMainQueueSetup { return YES; }

- (instancetype)init {
  if ((self = [super init])) _recorder = [CetaMicrophoneRecord new];
  return self;
}

- (void)record:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_recorder recordWithCompletion:^(NSString *raw, NSString *code) {
    if (code) reject(code, @"Microphone recording is unavailable", nil);
    else resolve(raw);
  }];
}

- (void)cancel { [_recorder cancel]; }
- (void)invalidate { [_recorder cancel]; }

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeCetaMicrophoneRecordSpecJSI>(params);
}
@end
