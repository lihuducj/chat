import Foundation
import Combine
import UIKit
import AudioToolbox
import UserNotifications

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
    @Published private(set) var inbox = InboxState()
    @Published private(set) var inboxError: String?

    private let serverKey = "nativeServerURL"
    private let foregroundSoundKey = "nativeForegroundSoundEnabled"
    private let autoTranslateKey = "nativeAutoTranslateEnabled"
    private var eventTask: Task<Void, Never>?
    private var presenceTask: Task<Void, Never>?
    private var inboxPollTask: Task<Void, Never>?
    private var inboxRefreshTask: Task<Void, Never>?
    private var inboxRefreshID: UUID?
    private var inboxRefreshAgain = false
    private var hasInboxBaseline = false
    private var badgeTask: Task<Void, Never>?
    private var lastBadgeCount: Int?
    private var appIsForeground = false
    private var lastNativeEventID: Int64?
    private var notifiedMessageKeys = Set<String>()
    private var notifiedMessageKeyOrder: [String] = []

    init() {
        foregroundSoundEnabled = (UserDefaults.standard.object(forKey: foregroundSoundKey) as? Bool) ?? true
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

    func requireClient() throws -> APIClient {
        guard token != nil, let client else { throw AppClientError.unauthorized }
        return client
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
        let previousClient = client
        clearToken()
        if let client = previousClient {
            try? await client.reportNativePresence(active: false)
            try? await client.logout()
        }
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
            lastBadgeCount = nil
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
            stopInboxUpdates()
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
        guard appIsForeground, let client, token != nil else { return }
        startInboxUpdatesIfNeeded()
        isRealtimeConnected = false

        eventTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    for try await event in client.eventStream(after: lastNativeEventID) {
                        guard !Task.isCancelled else { return }
                        if let eventID = event.eventId {
                            if event.type == "connected" {
                                lastNativeEventID = eventID
                            } else if eventID > (lastNativeEventID ?? 0) {
                                lastNativeEventID = eventID
                            } else {
                                continue
                            }
                        }
                        if event.type == "connected" || event.type == "heartbeat" {
                            isRealtimeConnected = true
                            sessionMessage = nil
                            // Presence uses its own task; a slow POST must never block
                            // delivery of the next SSE message on this stream.
                            if event.type == "connected" {
                                restartPresenceReportingIfNeeded()
                                requestInboxRefresh()
                            }
                        } else {
                            let changed = inbox.apply(event)
                            if changed { syncAppBadge() }
                            if ["new_message", "conversation_updated", "conversation_deleted", "message_recalled"].contains(event.type),
                               event.conversation == nil {
                                requestInboxRefresh()
                            }
                            lastEvent = event
                            if changed, appIsForeground,
                               event.type == "new_message",
                               let message = event.message,
                               message.sender == "visitor" {
                                notifyForegroundVisitorMessage(message)
                            }
                        }
                    }
                } catch {
                    guard !Task.isCancelled else { return }
                    isRealtimeConnected = false
                    restartPresenceReportingIfNeeded()
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
        stopInboxUpdates()
        eventTask?.cancel()
        eventTask = nil
        presenceTask?.cancel()
        presenceTask = nil
        isRealtimeConnected = false
        lastEvent = nil
        pendingConversationID = nil
        lastNativeEventID = nil
        notifiedMessageKeys.removeAll()
        notifiedMessageKeyOrder.removeAll()
        inbox = InboxState()
        inboxError = nil
        hasInboxBaseline = false
        token = nil
        KeychainStore.deleteToken()
        syncAppBadge()
    }

    func refreshInbox() async {
        requestInboxRefresh()
        await inboxRefreshTask?.value
    }

    // Coalesce new work behind the current request. Never cancel a useful response
    // just because another receipt or message event arrived.
    func requestInboxRefresh() {
        guard appIsForeground, token != nil, let client else { return }
        if inboxRefreshTask != nil {
            inboxRefreshAgain = true
            return
        }
        let requestID = UUID()
        inboxRefreshID = requestID
        inboxRefreshTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if inboxRefreshID == requestID {
                    inboxRefreshTask = nil
                    inboxRefreshID = nil
                }
            }
            repeat {
                inboxRefreshAgain = false
                let revision = inbox.revision
                do {
                    let result = try await client.inboxSnapshot()
                    guard !Task.isCancelled, inboxRefreshID == requestID else { return }
                    let previous = Dictionary(inbox.conversations.map { ($0.id, $0.lastMessageAt) },
                                              uniquingKeysWith: { _, new in new })
                    inbox.merge(result, startedAt: revision)
                    if hasInboxBaseline {
                        for row in inbox.conversations where row.lastMessageAt > (previous[row.id] ?? 0) {
                            notifyForegroundConversationChange(row)
                        }
                    }
                    hasInboxBaseline = true
                    inboxError = nil
                    syncAppBadge()
                } catch {
                    guard !Task.isCancelled, inboxRefreshID == requestID else { return }
                    handleUnauthorized(error)
                    if token == nil { return }
                    inboxError = error.localizedDescription
                }
            } while inboxRefreshAgain && !Task.isCancelled
        }
    }

    func removeConversationFromInbox(_ id: String) {
        inbox.remove(id)
        syncAppBadge()
        requestInboxRefresh()
    }

    private func startInboxUpdatesIfNeeded() {
        guard inboxPollTask == nil else { return }
        inboxPollTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                await refreshInbox()
                try? await Task.sleep(nanoseconds: 4_000_000_000)
            }
        }
    }

    private func stopInboxUpdates() {
        inboxPollTask?.cancel()
        inboxPollTask = nil
        inboxRefreshID = nil
        inboxRefreshTask?.cancel()
        inboxRefreshTask = nil
        inboxRefreshAgain = false
    }

    private func syncAppBadge() {
        guard badgeTask == nil, lastBadgeCount != inbox.unreadCount else { return }
        badgeTask = Task { [weak self] in
            guard let self else { return }
            defer { badgeTask = nil }
            let center = UNUserNotificationCenter.current()
            var settings = await center.notificationSettings()
            if settings.authorizationStatus == .notDetermined, token != nil {
                _ = try? await center.requestAuthorization(options: [.badge])
                settings = await center.notificationSettings()
            }
            guard settings.badgeSetting == .enabled else {
                lastBadgeCount = inbox.unreadCount
                return
            }
            repeat {
                let count = inbox.unreadCount
                do {
                    try await center.setBadgeCount(count)
                    lastBadgeCount = count
                } catch { return }
            } while lastBadgeCount != inbox.unreadCount
        }
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
