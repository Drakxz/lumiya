import UIKit

class ViewController: UIViewController {
  private let clientId = Bundle.main.object(forInfoDictionaryKey: "DiscordClientId") as? String ?? ""
  private let site = Bundle.main.object(forInfoDictionaryKey: "SiteURL") as? String ?? ""
  private let status = UILabel()
  private let login = UIButton(type: .system)
  private let browser = UIButton(type: .system)
  private let cancel = UIButton(type: .system)
  private var task: URLSessionDataTask?
  private var attempt = 0
  private var busy = false

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    status.font = .preferredFont(forTextStyle: .body)
    status.adjustsFontForContentSizeCategory = true
    status.numberOfLines = 0
    status.textAlignment = .center
    for button in [login, browser, cancel] {
      button.titleLabel?.font = .preferredFont(forTextStyle: .headline)
      button.titleLabel?.adjustsFontForContentSizeCategory = true
      button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    }
    login.setTitle("Entrar com Discord", for: .normal)
    browser.setTitle("Entrar pelo navegador", for: .normal)
    cancel.setTitle("Cancelar login", for: .normal)
    login.addTarget(self, action: #selector(signIn), for: .touchUpInside)
    browser.addTarget(self, action: #selector(browserSignIn), for: .touchUpInside)
    cancel.addTarget(self, action: #selector(cancelSignIn), for: .touchUpInside)
    let stack = UIStackView(arrangedSubviews: [status, login, cancel, browser])
    stack.axis = .vertical
    stack.spacing = 16
    stack.translatesAutoresizingMaskIntoConstraints = false
    let scroll = UIScrollView()
    scroll.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(scroll)
    scroll.addSubview(stack)
    NSLayoutConstraint.activate([
      scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
      scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      scroll.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
      stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -24),
      stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48),
      stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 40),
      stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -40)
    ])
    setState("Autorize o acesso à sua identidade no Discord para entrar no site.", loading: false)
  }

  private func setState(_ message: String, loading: Bool) {
    busy = loading
    status.text = message
    login.isEnabled = !loading
    browser.isEnabled = !loading
    cancel.isHidden = !loading
    UIAccessibility.post(notification: .announcement, argument: message)
  }

  @objc private func signIn() {
    guard !busy, clientId.range(of: #"^\d{17,20}$"#, options: .regularExpression) != nil,
          let origin = URL(string: site), origin.scheme == "https", origin.host != nil else {
      setState("Configuração inválida. Entre em contato com o responsável pelo aplicativo.", loading: false)
      return
    }
    attempt += 1
    let current = attempt
    setState("Abrindo o Discord… Autorize o acesso para continuar.", loading: true)
    DiscordAuthBridge.shared().authorize(clientId: clientId) { [weak self] code, verifier, redirect, error in
      guard let self = self, self.attempt == current else { return }
      if let error = error {
        self.setState(error, loading: false)
        return
      }
      guard let code = code, !code.isEmpty, let verifier = verifier,
            let redirect = redirect, redirect == "discord-\(self.clientId):/authorize/callback" else {
        self.setState("Retorno inválido. Inicie o login novamente.", loading: false)
        return
      }
      self.setState("Autorizado. Concluindo o login no site…", loading: true)
      self.exchange(code: code, verifier: verifier, redirect: redirect, attempt: current)
    }
  }

  @objc private func cancelSignIn() {
    attempt += 1 // Ignore both late SDK callbacks and in-flight HTTP responses.
    DiscordAuthBridge.shared().cancel()
    task?.cancel()
    task = nil
    setState("Login cancelado. Você pode tentar novamente.", loading: false)
  }

  @objc private func browserSignIn() { openBrowser(path: "/api/auth/discord") }

  private func openBrowser(path: String) {
    guard let url = URL(string: site + path), url.scheme == "https" else { return }
    UIApplication.shared.open(url, options: [:]) { [weak self] opened in
      if !opened {
        self?.setState("Não foi possível abrir o navegador. Tente entrar novamente.", loading: false)
      }
    }
  }

  private func exchange(code: String, verifier: String, redirect: String, attempt: Int) {
    guard let url = URL(string: site + "/api/auth/native/exchange") else { return }
    var request = URLRequest(url: url)
    request.timeoutInterval = 30
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: [
      "code": code, "codeVerifier": verifier, "redirectUri": redirect
    ])
    // An ephemeral session never retains provider/session credentials.
    let session = URLSession(configuration: .ephemeral, delegate: NoRedirects(), delegateQueue: nil)
    task = session.dataTask(with: request) { [weak self] data, response, error in
      session.finishTasksAndInvalidate()
      let path: String?
      if error == nil, (response as? HTTPURLResponse)?.statusCode == 200, let data = data,
         let json = try? JSONSerialization.jsonObject(with: data) as? [String: String],
         let value = json["url"],
         value.range(of: #"^/api/auth/native/consume\?ticket=[A-Za-z0-9_-]{43}$"#,
                     options: .regularExpression) != nil {
        path = value
      } else { path = nil }
      DispatchQueue.main.async {
        guard let self = self, self.attempt == attempt else { return }
        self.task = nil
        guard let path = path else {
          self.setState("Não foi possível concluir. Verifique sua conexão e entre novamente.", loading: false)
          return
        }
        self.setState("Login concluído. Abrindo o site…", loading: false)
        self.openBrowser(path: path)
      }
    }
    task?.resume()
  }
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask,
                  willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}
