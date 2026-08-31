import Foundation
import Combine
import UIKit
import AudioToolbox

@MainActor
final class AppState: ObservableObject {
    @Published private(set) var serverURL: URL?
    @Published private(set) var token: String?
    @Published var isCheckingSession = true
    @Published var sessionMessage: String?
    @Published private(set) var lastEvent: NativeEvent?
    @Published private(set) var isRealtimeConnected = false
    @Published private(set) var pendingConversationID: String?
    @Published private(set) var foregroundSoundEnabled: Bool
    @Published private(set) var autoTranslateEnabled: Bool

    private let serverKey = "nativeServerURL"
    private let foregroundSoundKey = "nativeForegroundSoundEnabled"
    private let autoTranslateKey = "nativeAutoTranslateEnabled"
    private var eventTask: Task<Void, Never>?
    private var presenceTask: Task<Void, Never>?
    private var appIsForeground = false
    private var lastNativeEventID: Int64?
    private var notifiedMessageKeys = Set<String>()
    private var notifiedMessageKeyOrder: [String] = []

    init() {
        foregroundSoundEnabled = UserDefaults.standard.object(forKey: foregroundSoundKey) as? Bool ?? true
        autoTranslateEnabled = UserDefaults.standard.bool(forKey: autoTranslateKey)
        if let value = UserDefaults.standard.string(forKey: serverKey) {
            serverURL = URL(string: value)
        }
        token = KeychainStore.loadToken()
    }

    var client: APIClient? {
        guard let serverURL else { return nil }
        return APIClient(baseURL: serverURL, token: token)
    }

    func bootstrap() async {
        defer { isCheckingSession = false }
        guard serverURL != nil, token != nil, let client else { return }
        do {
            try await client.checkSession()
            sessionMessage = nil
            startEventStream()
            restartPresenceReportingIfNeeded()
        } catch {
            if case AppClientError.unauthorized = error {
                clearToken()
                sessionMessage = error.localizedDescription
            } else {
                // 临时断网不能把有效登录清掉。保留 token，进入会话页后自动重连。
                sessionMessage = "暂时无法连接服务器，网络恢复后会自动重试"
                startEventStream()
                restartPresenceReportingIfNeeded()
            }
        }
    }

    func configureServer(_ input: String) async throws {
        let normalized = try Self.normalizeServer(input)
        let probeClient = APIClient(baseURL: normalized, token: nil)
        try await probeClient.probe()
        serverURL = normalized
        UserDefaults.standard.set(normalized.absoluteString, forKey: serverKey)
        clearToken()
        sessionMessage = nil
    }

    func login(username: String, password: String) async throws {
        guard let serverURL else { throw AppClientError.invalidServer }
        let response = try await APIClient(baseURL: serverURL, token: nil)
            .login(username: username, password: password)
        token = response.token
        KeychainStore.saveToken(response.token)
        sessionMessage = nil
        startEventStream()
        restartPresenceReportingIfNeeded()
    }

    func logout() async {
        if let client {
            try? await client.reportNativePresence(active: false)
            try? await client.logout()
        }
        clearToken()
    }

    func forgetServer() {
        clearToken()
        serverURL = nil
        sessionMessage = nil
        UserDefaults.standard.removeObject(forKey: serverKey)
    }

    func handleUnauthorized(_ error: Error) {
        if case AppClientError.unauthorized = error {
            clearToken()
            sessionMessage = error.localizedDescription
        }
    }

    func handleDeepLink(_ url: URL) {
        guard url.scheme?.lowercased() == "servicedesk",
              url.host?.lowercased() == "conversation" else { return }
        let conversationID = url.path
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            .removingPercentEncoding ?? ""
        guard !conversationID.isEmpty else { return }
        pendingConversationID = conversationID
    }

    func consumeConversationDeepLink(_ conversationID: String) {
        guard pendingConversationID == conversationID else { return }
        pendingConversationID = nil
    }

    func setForegroundSoundEnabled(_ enabled: Bool) {
        foregroundSoundEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: foregroundSoundKey)
    }

    func setAutoTranslateEnabled(_ enabled: Bool) {
        autoTranslateEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: autoTranslateKey)
    }

    func setAppForeground(_ isForeground: Bool) {
        guard appIsForeground != isForeground else { return }
        appIsForeground = isForeground
        presenceTask?.cancel()
        presenceTask = nil

        guard let client, token != nil else { return }
        if isForeground {
            // iOS 从后台恢复时原来的 HTTP 长连接可能看似存活、实际已经不再收数据。
            // 每次回到前台主动重建，并通过 lastNativeEventID 补收断线期间的事件。
            startEventStream()
            presenceTask = Task {
                while !Task.isCancelled {
                    try? await client.reportNativePresence(active: isRealtimeConnected)
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                }
            }
        } else {
            eventTask?.cancel()
            eventTask = nil
            isRealtimeConnected = false
            Task { try? await client.reportNativePresence(active: false) }
        }
    }

    private func restartPresenceReportingIfNeeded() {
        guard appIsForeground else { return }
        presenceTask?.cancel()
        presenceTask = nil
        guard let client, token != nil else { return }
        presenceTask = Task {
            while !Task.isCancelled {
                try? await client.reportNativePresence(active: isRealtimeConnected)
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }

    private func startEventStream() {
        eventTask?.cancel()
        guard let client, token != nil else { return }
        isRealtimeConnected = false

        eventTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    for try await event in client.eventStream(after: lastNativeEventID) {
                        guard let self, !Task.isCancelled else { return }
                        if let eventID = event.eventId {
                            if event.type == "connected" {
                                lastNativeEventID = eventID
                            } else if eventID > (lastNativeEventID ?? 0) {
                                lastNativeEventID = eventID
                            }
                        }
                        if event.type == "connected" || event.type == "heartbeat" {
                            isRealtimeConnected = true
                            sessionMessage = nil
                            if appIsForeground {
                                try? await client.reportNativePresence(active: true)
                            }
                        } else {
                            lastEvent = event
                            if appIsForeground,
                               event.type == "new_message",
                               let message = event.message,
                               message.sender == "visitor" {
                                notifyForegroundVisitorMessage(message)
                            }
                        }
                    }
                } catch {
                    guard let self, !Task.isCancelled else { return }
                    isRealtimeConnected = false
                    if appIsForeground {
                        try? await client.reportNativePresence(active: false)
                    }
                    if case AppClientError.unauthorized = error {
                        clearToken()
                        sessionMessage = error.localizedDescription
                        return
                    }
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                }
            }
        }
    }

    private func clearToken() {
        eventTask?.cancel()
        eventTask = nil
        presenceTask?.cancel()
        presenceTask = nil
        isRealtimeConnected = false
        lastEvent = nil
        lastNativeEventID = nil
        notifiedMessageKeys.removeAll()
        notifiedMessageKeyOrder.removeAll()
        token = nil
        KeychainStore.deleteToken()
    }

    func notifyForegroundVisitorMessage(_ message: ChatMessage) {
        notifyForegroundVisitorMessage(
            conversationID: message.conversationId,
            messageID: message.id,
            createdAt: message.createdAt
        )
    }

    func notifyForegroundConversationChange(_ conversation: Conversation) {
        guard conversation.unreadCount > 0, conversation.lastSender == "visitor" else { return }
        notifyForegroundVisitorMessage(
            conversationID: conversation.id,
            messageID: nil,
            createdAt: conversation.lastMessageAt
        )
    }

    private func notifyForegroundVisitorMessage(
        conversationID: String,
        messageID: String?,
        createdAt: Int64
    ) {
        guard appIsForeground else { return }
        let timeKey = "conversation:\(conversationID):\(createdAt)"
        let idKey = messageID.map { "message:\($0)" }
        if notifiedMessageKeys.contains(timeKey) || idKey.map(notifiedMessageKeys.contains) == true {
            return
        }
        rememberNotificationKey(timeKey)
        if let idKey { rememberNotificationKey(idKey) }
        if foregroundSoundEnabled {
            AudioServicesPlaySystemSound(1007)
        }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    private func rememberNotificationKey(_ key: String) {
        guard notifiedMessageKeys.insert(key).inserted else { return }
        notifiedMessageKeyOrder.append(key)
        while notifiedMessageKeyOrder.count > 300 {
            notifiedMessageKeys.remove(notifiedMessageKeyOrder.removeFirst())
        }
    }

    static func normalizeServer(_ input: String) throws -> URL {
        var value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if !value.lowercased().hasPrefix("https://") {
            value = "https://" + value
        }
        guard var components = URLComponents(string: value),
              components.scheme?.lowercased() == "https",
              components.host != nil else {
            throw AppClientError.invalidServer
        }
        components.path = ""
        components.query = nil
        components.fragment = nil
        guard let url = components.url else { throw AppClientError.invalidServer }
        return url
    }
}
