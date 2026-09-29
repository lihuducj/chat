import Foundation

var checks = 0
func expect(_ condition: @autoclosure () -> Bool, _ description: String) {
    precondition(condition(), description)
    checks += 1
}

func canRead(_ state: ChatScrollState, visible: Bool = true, loaded: Bool = true, current: Bool = true) -> Bool {
    state.canMarkRead(isReadable: visible, hasLoadedMessages: loaded, layoutIsCurrent: current)
}

// First entry: even if a lazy row was built, it is not necessarily visible.
var scroll = ChatScrollState()
scroll.updateGeometry(contentBottom: 1800, viewportHeight: 600)
expect(scroll.shouldFollowLatest, "First entry follows the latest message")
expect(!canRead(scroll), "Offscreen messages cannot be marked read")
scroll.didPosition()
expect(!canRead(scroll), "A scroll command alone is not proof of visibility")
scroll.updateGeometry(contentBottom: 600, viewportHeight: 600)
expect(canRead(scroll), "Read only after the bottom is actually visible")

// A new message, a decoded image or keyboard reduces the visible area.
scroll.updateGeometry(contentBottom: 730, viewportHeight: 600)
expect(scroll.shouldFollowLatest, "Incoming content keeps following intent")
expect(!canRead(scroll), "New content below the composer is unread")
scroll.updateGeometry(contentBottom: 600, viewportHeight: 350)
expect(scroll.shouldFollowLatest, "Keyboard resizing is not a history gesture")
expect(!canRead(scroll), "Keyboard-obscured content remains unread")
scroll.updateGeometry(contentBottom: 350, viewportHeight: 350)
expect(canRead(scroll), "Read after keyboard layout settles")

// Looking at history: new events, polling and image resizing must not jump down.
scroll.beginDragging()
scroll.updateGeometry(contentBottom: 950, viewportHeight: 350)
scroll.endDragging()
scroll.receivedVisitorMessages(["visitor-1", "visitor-2"])
scroll.receivedVisitorMessages(["visitor-1"])
expect(!scroll.shouldFollowLatest, "Reading history is never interrupted")
expect(scroll.pendingMessageCount == 2, "SSE and polling do not double-count unread")
scroll.updateGeometry(contentBottom: 1100, viewportHeight: 350)
expect(!scroll.shouldFollowLatest, "Image expansion preserves history position")
expect(!canRead(scroll), "History mode does not clear unread")
scroll.requestLatest()
expect(scroll.shouldFollowLatest, "Latest button resumes follow mode")
expect(scroll.pendingMessageCount == 2, "Do not clear pending before the jump finishes")
scroll.updateGeometry(contentBottom: 350, viewportHeight: 350)
expect(scroll.pendingMessageCount == 0, "Clear pending when bottom is visible")
expect(canRead(scroll), "Latest button eventually permits read")

// A native drag back to the end also resumes following.
scroll.beginDragging()
scroll.updateGeometry(contentBottom: 800, viewportHeight: 350)
scroll.endDragging()
scroll.updateGeometry(contentBottom: 350, viewportHeight: 350)
expect(scroll.shouldFollowLatest, "Manual scrolling to bottom resumes follow")
expect(!canRead(scroll, visible: false), "Details, image preview and background preserve unread")
expect(!canRead(scroll, loaded: false), "Initial partial SSE data is not a full snapshot")
expect(!canRead(scroll, current: false), "Old layout must not acknowledge a newer message")
scroll.beginDragging()
expect(!canRead(scroll), "Dragging cancels delayed read")
scroll.updateGeometry(contentBottom: 350, viewportHeight: 350)
expect(!scroll.shouldFollowLatest, "Geometry never steals an active drag")
scroll.endDragging()
expect(scroll.shouldFollowLatest, "Ending at bottom resumes follow")

var emptyLayout = ChatScrollState()
emptyLayout.didPosition()
emptyLayout.updateGeometry(contentBottom: 0, viewportHeight: 0)
expect(!canRead(emptyLayout), "An unmeasured layout is not visible")

func message(_ id: String, _ content: String = "hello", at time: Int64 = 1) -> ChatMessage {
    ChatMessage(id: id, conversationId: "test", sender: "agent", type: "text",
                content: content, fileName: nil, fileSize: nil, createdAt: time, recalled: 0)
}

let old = message("ios-old")
let pending = message(ChatMessageReconciliation.localID(for: "ios-next"), at: 2)
let repeatedText = ChatMessageReconciliation.merge(server: [old], local: [old, pending])
expect(repeatedText.count == 2, "An older identical reply must not remove the pending reply")
expect(repeatedText.contains(where: { $0.id == pending.id }), "Keep pending until its exact ID is acknowledged")
let confirmed = message("ios-next", at: 3)
let acknowledged = ChatMessageReconciliation.merge(server: [old, confirmed], local: [old, pending])
expect(acknowledged.map(\.id) == ["ios-old", "ios-next"], "Exact acknowledgement replaces optimistic row")
let replay = ChatMessageReconciliation.deduplicate([confirmed, old, confirmed])
expect(replay.count == 2, "SSE replay and POST response appear once")
expect(replay.first?.id == old.id, "Order is stable after deduplication")
let recalled = ChatMessage(id: "ios-next", conversationId: "test", sender: "agent",
                           type: "text", content: "", fileName: nil, fileSize: nil,
                           createdAt: 3, recalled: 1)
let snapshot = ChatMessageReconciliation.merge(server: [old, recalled], local: [old, confirmed])
expect(snapshot.last?.isRecalled == true, "Authoritative recall replaces the old body")
let pendingImage = ChatMessage(id: "local-ios-photo", conversationId: "test", sender: "agent",
                              type: "image", content: "/uploads/photo.jpg", fileName: nil,
                              fileSize: nil, createdAt: 4, recalled: 0)
expect(ChatMessageReconciliation.merge(server: [old], local: [pendingImage]).count == 2,
       "Keep unacknowledged attachments through snapshot refresh")

print("Passed \(checks) chat interaction regression checks.")
