import Foundation

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
