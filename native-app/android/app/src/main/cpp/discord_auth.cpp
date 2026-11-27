#define DISCORDPP_IMPLEMENTATION
#include "discordpp.h"
#include <jni.h>
#include <memory>
#include <string>

// All entry points and RunCallbacks execute on the Activity's main thread.
namespace {
JavaVM *vm = nullptr;
std::unique_ptr<discordpp::Client> client;
jobject pending = nullptr;
uint64_t generation = 0;

JNIEnv *environment() {
  JNIEnv *env = nullptr;
  return vm && vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) == JNI_OK
      ? env : nullptr;
}

void finish(const std::string &code, const std::string &verifier,
            const std::string &redirect, const char *error) {
  auto *env = environment();
  if (!env || !pending) return;
  jobject callback = pending;
  pending = nullptr;
  jclass cls = env->GetObjectClass(callback);
  if (error) {
    auto method = env->GetMethodID(cls, "onError", "(Ljava/lang/String;)V");
    jstring message = env->NewStringUTF(error);
    if (method) env->CallVoidMethod(callback, method, message);
    env->DeleteLocalRef(message);
  } else {
    auto method = env->GetMethodID(cls, "onCode",
        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V");
    jstring c = env->NewStringUTF(code.c_str());
    jstring v = env->NewStringUTF(verifier.c_str());
    jstring r = env->NewStringUTF(redirect.c_str());
    if (method) env->CallVoidMethod(callback, method, c, v, r);
    env->DeleteLocalRef(c);
    env->DeleteLocalRef(v);
    env->DeleteLocalRef(r);
  }
  env->DeleteLocalRef(cls);
  env->DeleteGlobalRef(callback);
}
}

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *javaVm, void *) {
  vm = javaVm;
  return JNI_VERSION_1_6;
}

extern "C" JNIEXPORT void JNICALL
Java_com_sla_fotos_MainActivity_requestAuthorize(
    JNIEnv *env, jobject, jlong clientId, jobject callback) {
  if (pending) return; // UI also prevents overlapping login attempts.
  pending = env->NewGlobalRef(callback);
  const auto attempt = ++generation;
  try {
    if (!client) client = std::make_unique<discordpp::Client>();
    auto verifier = client->CreateAuthorizationCodeVerifier();
    discordpp::AuthorizationArgs args{};
    args.SetClientId(static_cast<uint64_t>(clientId));
    args.SetScopes("identify");
    args.SetCodeChallenge(verifier.Challenge());
    // The SDK owns state validation and the mobile callback Activity.
    const std::string expected = "discord-" + std::to_string(clientId) + ":/authorize/callback";
    client->Authorize(args, [attempt, verifier, expected](auto result, auto code, auto redirect) {
      if (attempt != generation || !pending) return;
      if (!result.Successful() || code.empty() || redirect != expected) {
        finish({}, {}, {}, "Login não concluído. Tente novamente ou entre pelo navegador.");
        return;
      }
      finish(code, verifier.Verifier(), redirect, nullptr);
    });
  } catch (...) {
    finish({}, {}, {}, "Não foi possível iniciar o Discord. Tente novamente.");
  }
}

extern "C" JNIEXPORT void JNICALL
Java_com_sla_fotos_MainActivity_runCallbacks(JNIEnv *, jobject) {
  discordpp::RunCallbacks();
}

extern "C" JNIEXPORT void JNICALL
Java_com_sla_fotos_MainActivity_cancelAuthorize(JNIEnv *env, jobject) {
  ++generation;
  if (pending) {
    env->DeleteGlobalRef(pending);
    pending = nullptr;
  }
  if (client) client->AbortAuthorize();
}
