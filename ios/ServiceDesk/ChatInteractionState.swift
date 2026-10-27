import Foundation

// One foreground inbox backs the list, the chat back button and the app badge.
// A response captured before an SSE event must never overwrite that event.
struct InboxState {
    private(set) var conversations: [Conversation] = []
    private(set) var revision: UInt64 = 0
    private var snapshotEventID: Int64?
    private var changes: [String: (revision: UInt64, eventID: Int64?)] = [:]
    private var seenMessageIDs = Set<String>()
    private var messageOrder: [String] = []

    var unreadCount: Int { conversations.reduce(0) { $0 + max(0, $1.unreadCount) } }

    func unreadCount(excluding id: String) -> Int {
        conversations.filter { $0.id != id }.reduce(0) { $0 + max(0, $1.unreadCount) }
    }

    @discardableResult
    mutating func apply(_ event: NativeEvent) -> Bool {
        guard let id = event.conversationId else { return false }
        if let eventID = event.eventId, let cursor = snapshotEventID, eventID <= cursor {
            return false
        }
        switch event.type {
        case "conversation_deleted":
            conversations.removeAll { $0.id == id }
        case "new_message":
            guard let message = event.message, seenMessageIDs.insert(message.id).inserted else { return false }
            messageOrder.append(message.id)
            if messageOrder.count > 500 { seenMessageIDs.remove(messageOrder.removeFirst()) }
            if let updated = event.conversation {
                upsert(updated)
            } else {
                // Compatibility with servers that send only the message.
                var row = conversations.first { $0.id == id } ?? Conversation(
                    id: id, visitorId: "", status: "open", createdAt: message.createdAt,
                    lastMessageAt: 0, unreadCount: 0, notes: nil, tags: nil,
                    visitorDeliveredAt: nil, visitorReadAt: nil, visitorName: nil,
                    visitorEmail: nil, visitorIP: nil, lastUrl: nil,
                    lastMessage: nil, lastType: nil, lastSender: nil
                )
                guard message.createdAt > row.lastMessageAt else { return false }
                row.lastMessageAt = message.createdAt
                row.lastMessage = message.content
                row.lastType = message.type
                row.lastSender = message.sender
                if message.sender == "visitor" {
                    row.status = "open"
                    row.unreadCount += 1
                }
                upsert(row)
            }
        case "conversation_updated", "message_recalled":
            guard let updated = event.conversation else { return false }
            upsert(updated)
        default:
            return false
        }
        revision += 1
        changes[id] = (revision, event.eventId)
        return true
    }

    mutating func merge(_ snapshot: InboxSnapshot, startedAt start: UInt64) {
        if let cursor = snapshot.eventID, let current = snapshotEventID, cursor < current { return }
        let previous = Dictionary(conversations.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
        func preserve(_ id: String) -> Bool {
            guard let change = changes[id] else { return false }
            if let cursor = snapshot.eventID, let eventID = change.eventID { return eventID > cursor }
            return change.revision > start
        }
        var result: [Conversation] = []
        var included = Set<String>()
        for row in snapshot.conversations where included.insert(row.id).inserted {
            if preserve(row.id) {
                if let local = previous[row.id] { result.append(local) }
                // A deletion received after the request is a tombstone.
            } else {
                result.append(row)
            }
        }
        for row in conversations where !included.contains(row.id) && preserve(row.id) {
            result.append(row)
        }
        let pendingChanges = changes.filter { preserve($0.key) }
        conversations = result
        changes = pendingChanges
        if let cursor = snapshot.eventID { snapshotEventID = cursor }
    }

    mutating func remove(_ id: String) {
        conversations.removeAll { $0.id == id }
        revision += 1
        changes[id] = (revision, nil)
    }

    private mutating func upsert(_ conversation: Conversation) {
        if let index = conversations.firstIndex(where: { $0.id == conversation.id }) {
            conversations[index] = conversation
        } else {
            conversations.append(conversation)
        }
    }
}

// Layout changes must not be confused with the user's decision to read history.
struct ChatScrollState {
    private(set) var followsLatest = true
    private(set) var isDragging = false
    private(set) var bottomIsVisible = false
    private(set) var hasPositioned = false
    private(set) var pendingMessageIDs = Set<String>()

    var shouldFollowLatest: Bool { followsLatest && !isDragging }
    var pendingMessageCount: Int { pendingMessageIDs.count }

    func canMarkRead(isReadable: Bool, hasLoadedMessages: Bool, layoutIsCurrent: Bool) -> Bool {
        isReadable && hasLoadedMessages && layoutIsCurrent && hasPositioned
            && shouldFollowLatest && bottomIsVisible
    }

    mutating func updateGeometry(contentBottom: Double, viewportHeight: Double) {
        bottomIsVisible = viewportHeight > 0 && contentBottom > 0
            && contentBottom <= viewportHeight + 2
        if bottomIsVisible && !isDragging {
            followsLatest = true
            pendingMessageIDs.removeAll()
        }
    }

    mutating func beginDragging() {
        isDragging = true
        followsLatest = false
    }

    mutating func endDragging() {
        isDragging = false
        if bottomIsVisible { requestLatest() }
    }

    mutating func requestLatest() {
        followsLatest = true
        isDragging = false
        if bottomIsVisible { pendingMessageIDs.removeAll() }
    }

    mutating func didPosition() { hasPositioned = true }

    mutating func receivedVisitorMessages(_ ids: [String]) {
        if !followsLatest { pendingMessageIDs.formUnion(ids) }
    }
}

enum ChatMessageReconciliation {
    // Match by idempotency ID, not content: repeated text is still a new message.
    static func localID(for serverID: String) -> String { "local-\(serverID)" }

    static func merge(server: [ChatMessage], local: [ChatMessage]) -> [ChatMessage] {
        let confirmedLocalIDs = Set(server.map { localID(for: $0.id) })
        let pending = local.filter { $0.isPending && !confirmedLocalIDs.contains($0.id) }
        return deduplicate(server + pending)
    }

    static func deduplicate(_ source: [ChatMessage]) -> [ChatMessage] {
        var seen = Set<String>()
        return source.sorted {
            $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt < $1.createdAt
        }.filter { seen.insert($0.id).inserted }
    }
}
