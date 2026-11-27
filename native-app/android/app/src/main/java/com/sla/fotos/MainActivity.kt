package com.sla.fotos

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.discord.socialsdk.DiscordSocialSdkInit
import kotlinx.coroutines.*
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : AppCompatActivity() {
  companion object {
    init { System.loadLibrary("discord_auth") }
    const val REDIRECT = "discord-${BuildConfig.DISCORD_CLIENT_ID}:/authorize/callback"
    private val consumePath = Regex("^/api/auth/native/consume\\?ticket=[A-Za-z0-9_-]{43}$")
  }

  private external fun requestAuthorize(clientId: Long, callback: AuthCallback)
  private external fun runCallbacks()
  private external fun cancelAuthorize()
  interface AuthCallback {
    fun onCode(code: String, verifier: String, redirect: String)
    fun onError(message: String)
  }

  private lateinit var status: TextView
  private lateinit var login: Button
  private lateinit var cancel: Button
  private lateinit var browser: Button
  private val handler = Handler(Looper.getMainLooper())
  private var exchangeJob: Job? = null
  private var busy = false
  private val timeout = Runnable {
    cancelAuthorize()
    setState("A autorização expirou. Toque em Entrar para tentar novamente.", false)
  }
  private val pump = object : Runnable {
    override fun run() {
      runCallbacks()
      handler.postDelayed(this, 33)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    DiscordSocialSdkInit.setEngineActivity(this)
    setContentView(R.layout.activity_main)
    status = findViewById(R.id.status)
    login = findViewById(R.id.login)
    cancel = findViewById(R.id.cancel)
    browser = findViewById(R.id.browser)
    setState(if (savedInstanceState == null) "Pronto para entrar."
      else "Toque em Entrar para iniciar uma nova autorização.", false)
    login.setOnClickListener { signIn() }
    cancel.setOnClickListener {
      cancelAuthorize()
      exchangeJob?.cancel()
      handler.removeCallbacks(timeout)
      setState("Login cancelado. Você pode tentar novamente.", false)
    }
    browser.setOnClickListener { openBrowser("/api/auth/discord") }
    handler.post(pump)
  }

  private fun setState(message: String, loading: Boolean) {
    busy = loading
    status.text = message
    login.isEnabled = !loading
    browser.isEnabled = !loading
    cancel.visibility = if (loading) View.VISIBLE else View.GONE
  }

  private fun signIn() {
    if (busy) return
    setState("Abrindo o Discord… Autorize o acesso à sua identidade para continuar.", true)
    handler.postDelayed(timeout, 120_000)
    requestAuthorize(BuildConfig.DISCORD_CLIENT_ID.toLong(), object : AuthCallback {
      override fun onCode(code: String, verifier: String, redirect: String) {
        handler.removeCallbacks(timeout)
        if (redirect != REDIRECT) {
          setState("Retorno inválido. Inicie o login novamente.", false)
          return
        }
        setState("Autorizado. Concluindo o login no site…", true)
        exchangeJob = lifecycleScope.launch {
          try {
            val path = withContext(Dispatchers.IO) { exchange(code, verifier, redirect) }
            ensureActive()
            setState("Login concluído. Abrindo o site…", false)
            openBrowser(path)
          } catch (e: CancellationException) {
            throw e
          } catch (_: Exception) {
            setState("Não foi possível concluir. Verifique sua conexão e entre novamente.", false)
          }
        }
      }
      override fun onError(message: String) {
        handler.removeCallbacks(timeout)
        setState(message, false)
      }
    })
  }

  private fun exchange(code: String, verifier: String, redirect: String): String {
    val connection = URL("${BuildConfig.SITE_URL}/api/auth/native/exchange")
      .openConnection() as HttpURLConnection
    try {
      connection.connectTimeout = 15_000
      connection.readTimeout = 30_000
      connection.instanceFollowRedirects = false
      connection.requestMethod = "POST"
      connection.setRequestProperty("Content-Type", "application/json")
      connection.doOutput = true
      val body = JSONObject().put("code", code).put("codeVerifier", verifier)
        .put("redirectUri", redirect).toString()
      connection.outputStream.bufferedWriter(Charsets.UTF_8).use { it.write(body) }
      check(connection.responseCode == 200)
      val response = connection.inputStream.bufferedReader().use { it.readText() }
      val path = JSONObject(response).getString("url")
      check(consumePath.matches(path))
      return path
    } finally {
      connection.disconnect()
    }
  }

  private fun openBrowser(path: String) {
    try {
      startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(BuildConfig.SITE_URL + path))
        .addCategory(Intent.CATEGORY_BROWSABLE))
    } catch (_: Exception) {
      setState("Não foi possível abrir o navegador. Configure um navegador e tente novamente.", false)
    }
  }

  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    cancelAuthorize()
    super.onDestroy()
  }
}
