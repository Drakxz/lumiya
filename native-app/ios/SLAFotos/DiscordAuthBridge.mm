#import "DiscordAuthBridge.h"
#define DISCORDPP_IMPLEMENTATION
#include "discordpp.h"
#include <memory>
#include <string>

typedef void (^AuthCompletion)(NSString *, NSString *, NSString *, NSString *);

@implementation DiscordAuthBridge {
  std::unique_ptr<discordpp::Client> _client;
  NSTimer *_pump;
  NSTimer *_timeout;
  AuthCompletion _completion;
  uint64_t _generation;
}

+ (instancetype)shared {
  static DiscordAuthBridge *shared;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ shared = [DiscordAuthBridge new]; });
  return shared;
}

- (void)finishCode:(NSString *)code verifier:(NSString *)verifier
          redirect:(NSString *)redirect error:(NSString *)error {
  NSAssert(NSThread.isMainThread, @"SDK callbacks must run on the main thread");
  [_timeout invalidate];
  _timeout = nil;
  [_pump invalidate];
  _pump = nil;
  AuthCompletion completion = _completion;
  _completion = nil;
  if (completion) completion(code, verifier, redirect, error);
}

- (void)authorizeWithClientId:(NSString *)clientId completion:(AuthCompletion)completion {
  NSAssert(NSThread.isMainThread, @"Start authorization on the main thread");
  if (_completion) {
    completion(nil, nil, nil, @"Já existe um login em andamento.");
    return;
  }
  _completion = [completion copy];
  const auto attempt = ++_generation;
  try {
    const auto applicationId = std::stoull(clientId.UTF8String);
    if (!_client) _client = std::make_unique<discordpp::Client>();
    auto verifier = _client->CreateAuthorizationCodeVerifier();
    discordpp::AuthorizationArgs args{};
    args.SetClientId(applicationId);
    args.SetScopes("identify");
    args.SetCodeChallenge(verifier.Challenge());
    const std::string expected = "discord-" + std::to_string(applicationId) + ":/authorize/callback";
    __weak DiscordAuthBridge *weakSelf = self;
    _pump = [NSTimer timerWithTimeInterval:1.0 / 30 repeats:YES block:^(NSTimer *) {
      discordpp::RunCallbacks();
    }];
    [NSRunLoop.mainRunLoop addTimer:_pump forMode:NSRunLoopCommonModes];
    _timeout = [NSTimer scheduledTimerWithTimeInterval:120 repeats:NO block:^(NSTimer *) {
      DiscordAuthBridge *strongSelf = weakSelf;
      if (!strongSelf || strongSelf->_generation != attempt) return;
      [strongSelf cancel];
    }];
    _client->Authorize(args, [weakSelf, attempt, verifier, expected](auto result, auto code, auto redirect) {
      DiscordAuthBridge *strongSelf = weakSelf;
      if (!strongSelf || strongSelf->_generation != attempt || !strongSelf->_completion) return;
      if (!result.Successful() || code.empty() || redirect != expected) {
        [strongSelf finishCode:nil verifier:nil redirect:nil
                        error:@"Login não concluído. Tente novamente ou entre pelo navegador."];
        return;
      }
      [strongSelf finishCode:[NSString stringWithUTF8String:code.c_str()]
                    verifier:[NSString stringWithUTF8String:verifier.Verifier().c_str()]
                    redirect:[NSString stringWithUTF8String:redirect.c_str()] error:nil];
    });
  } catch (...) {
    [self finishCode:nil verifier:nil redirect:nil
              error:@"Não foi possível iniciar o Discord. Verifique a configuração do aplicativo."];
  }
}

- (void)cancel {
  NSAssert(NSThread.isMainThread, @"Cancel authorization on the main thread");
  ++_generation;
  if (_client) _client->AbortAuthorize();
  [self finishCode:nil verifier:nil redirect:nil
            error:@"Login cancelado ou expirado. Toque em Entrar para tentar novamente."];
}
@end
