import SwiftUI
import WebKit

struct TaskWebView: UIViewRepresentable {
    @Binding var isLoading: Bool

    // Live site URL — always load from here so the app stays in sync
    private let liveURL = URL(string: "https://t.rbarvani.workers.dev/")!

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()

        // Enable localStorage persistence
        let prefs = WKWebpagePreferences()
        prefs.allowsContentJavaScript = true
        config.defaultWebpagePreferences = prefs

        // Use a persistent data store so localStorage survives app restarts
        let dataStore = WKWebsiteDataStore.default()
        config.websiteDataStore = dataStore

        // Enable inline media playback
        config.allowsInlineMediaPlayback = true

        // Add message handler for native bridge (export/import support)
        let userController = WKUserContentController()
        userController.add(context.coordinator, name: "nativeBridge")

        // Inject JS to handle file input taps and viewport scaling
        let viewportScript = WKUserScript(
            source: """
            // Ensure proper viewport on iOS
            var meta = document.querySelector('meta[name="viewport"]');
            if (meta) {
                meta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover');
            }

            // Add safe area padding for notch devices
            document.body.style.paddingBottom = 'env(safe-area-inset-bottom)';
            """,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )
        userController.addUserScript(viewportScript)
        config.userContentController = userController

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.scrollView.bounces = true
        webView.scrollView.contentInsetAdjustmentBehavior = .automatic
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground

        // Allow back/forward swipe gestures
        webView.allowsBackForwardNavigationGestures = false

        // Load the live remote site (falls back to bundled copy if offline)
        let request = URLRequest(url: liveURL, cachePolicy: .reloadRevalidatingCacheData, timeoutInterval: 8)
        webView.load(request)

        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var parent: TaskWebView
        private var didFallback = false

        init(_ parent: TaskWebView) {
            self.parent = parent
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            DispatchQueue.main.async {
                self.parent.isLoading = false
            }
        }

        // If the remote load fails (offline / timeout), fall back to the bundled index.html
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            if !didFallback {
                didFallback = true
                if let htmlURL = Bundle.main.url(forResource: "index", withExtension: "html") {
                    webView.loadFileURL(htmlURL, allowingReadAccessTo: htmlURL.deletingLastPathComponent())
                    return
                }
            }
            DispatchQueue.main.async {
                self.parent.isLoading = false
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            if !didFallback {
                didFallback = true
                if let htmlURL = Bundle.main.url(forResource: "index", withExtension: "html") {
                    webView.loadFileURL(htmlURL, allowingReadAccessTo: htmlURL.deletingLastPathComponent())
                    return
                }
            }
            DispatchQueue.main.async {
                self.parent.isLoading = false
            }
        }

        // Handle messages from JavaScript
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any],
                  let action = body["action"] as? String else { return }

            switch action {
            case "shareData":
                if let jsonString = body["data"] as? String {
                    shareText(jsonString, from: message.webView)
                }
            default:
                break
            }
        }

        private func shareText(_ text: String, from webView: WKWebView?) {
            guard let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
                  let rootVC = windowScene.windows.first?.rootViewController else { return }

            let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent("task-tracker-export.json")
            try? text.write(to: tempURL, atomically: true, encoding: .utf8)

            let activityVC = UIActivityViewController(activityItems: [tempURL], applicationActivities: nil)
            if let popover = activityVC.popoverPresentationController {
                popover.sourceView = rootVC.view
                popover.sourceRect = CGRect(x: rootVC.view.bounds.midX, y: 60, width: 0, height: 0)
            }
            rootVC.present(activityVC, animated: true)
        }
    }
}
