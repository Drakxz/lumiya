#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface DiscordAuthBridge : NSObject
+ (instancetype)shared NS_SWIFT_NAME(shared());
- (void)authorizeWithClientId:(NSString *)clientId
                  completion:(void (^)(NSString *_Nullable code, NSString *_Nullable verifier,
                                      NSString *_Nullable redirectUri, NSString *_Nullable error))completion
    NS_SWIFT_NAME(authorize(clientId:completion:));
- (void)cancel;
@end

NS_ASSUME_NONNULL_END
