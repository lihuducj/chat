import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import UIKit
import Combine
import UserNotifications
import ImageIO
import VisionKit
#if canImport(Translation)
import Translation
#endif

struct ContentView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        Group {
            if appState.isCheckingSession {
                ProgressView("正在连接客服服务器…")
            } else if appState.serverURL == nil {
                ServerSetupView()
            } else if appState.token == nil {
                LoginView()
            } else {
                ConversationListView()
            }
        }
        .task { await appState.bootstrap() }
    }
}

private struct ServerSetupView: View {
    @EnvironmentObject private var appState: AppState
    @State private var address = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Spacer()
                Image(systemName: "bubble.left.and.bubble.right.fill")
                    .font(.system(size: 64))
                    .foregroundStyle(.blue)
                VStack(spacing: 8) {
                    Text("连接客服服务器")
                        .font(.title2.bold())
                    Text("第一次打开只需要填写一次服务器域名")
                        .foregroundStyle(.secondary)
                }

                VStack(alignment: .leading, spacing: 8) {
                    TextField("chat.example.com", text: $address)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .textFieldStyle(.roundedBorder)
                        .submitLabel(.go)
                        .onSubmit { connect() }
                    Text("只填域名即可，App 会自动使用 HTTPS 和原生接口。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }

                Button(action: connect) {
                    HStack {
                        if isSaving { ProgressView().tint(.white) }
                        Text(isSaving ? "正在验证…" : "连接服务器")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
                Spacer()
            }
            .padding(28)
            .navigationTitle("客服台")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func connect() {
        guard !isSaving else { return }
        isSaving = true
        errorMessage = nil
        Task {
            do {
                try await appState.configureServer(address)
            } catch {
                errorMessage = error.localizedDescription
            }
            isSaving = false
        }
    }
}

private struct LoginView: View {
    @EnvironmentObject private var appState: AppState
    @State private var username = ""
    @State private var password = ""
    @State private var isLoggingIn = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 22) {
                Spacer()
                Image(systemName: "person.crop.circle.badge.checkmark")
                    .font(.system(size: 62))
                    .foregroundStyle(.blue)
                Text("管理员登录")
                    .font(.title2.bold())

                VStack(spacing: 12) {
                    TextField("管理员账号", text: $username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.username)
                        .textFieldStyle(.roundedBorder)
                    SecureField("密码", text: $password)
                        .textContentType(.password)
                        .textFieldStyle(.roundedBorder)
                        .submitLabel(.go)
                        .onSubmit { signIn() }
                }

                if let message = errorMessage ?? appState.sessionMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.red)
                }

                Button(action: signIn) {
                    HStack {
                        if isLoggingIn { ProgressView().tint(.white) }
                        Text(isLoggingIn ? "登录中…" : "登录")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(username.isEmpty || password.isEmpty || isLoggingIn)

                Button("更换服务器") { appState.forgetServer() }
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .padding(28)
            .navigationTitle(appState.serverURL?.host ?? "客服台")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func signIn() {
        guard !isLoggingIn else { return }
        isLoggingIn = true
        errorMessage = nil
        Task {
            do {
                try await appState.login(username: username, password: password)
            } catch {
                errorMessage = error.localizedDescription
            }
            isLoggingIn = false
        }
    }
}

private enum InboxFilter: String, CaseIterable, Identifiable {
    case active = "处理中"
    case unread = "未读"
    case closed = "已结束"
    case all = "全部"

    var id: String { rawValue }
}

private struct ConversationListView: View {
    @EnvironmentObject private var appState: AppState
    @State private var conversations: [Conversation] = []
    @State private var search = ""
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var showSettings = false
    @State private var filter: InboxFilter = .active
    @State private var pendingDelete: Conversation?
    @State private var eventRefreshTask: Task<Void, Never>?
    @State private var loadSequence = 0
    @State private var navigationPath: [Conversation] = []

    private var displayedConversations: [Conversation] {
        conversations
            .filter { conversation in
                switch filter {
                case .active: return conversation.status != "closed"
                case .unread: return conversation.unreadCount > 0
                case .closed: return conversation.status == "closed"
                case .all: return true
                }
            }
            .sorted { lhs, rhs in
                let leftPriority = lhs.status == "closed" ? 2 : (lhs.unreadCount > 0 ? 0 : 1)
                let rightPriority = rhs.status == "closed" ? 2 : (rhs.unreadCount > 0 ? 0 : 1)
                if leftPriority != rightPriority { return leftPriority < rightPriority }
                return lhs.lastMessageAt > rhs.lastMessageAt
            }
    }

    var body: some View {
        NavigationStack(path: $navigationPath) {
            Group {
                if isLoading && conversations.isEmpty {
                    ProgressView("加载会话…")
                } else if displayedConversations.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "bubble.left.and.bubble.right")
                            .font(.system(size: 42))
                            .foregroundStyle(.secondary)
                        Text(search.isEmpty ? "当前分类没有会话" : "没有匹配的会话")
                            .foregroundStyle(.secondary)
                    }
                } else {
                    List {
                        ForEach(displayedConversations) { conversation in
                            NavigationLink(value: conversation) {
                                ConversationRow(conversation: conversation)
                            }
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button(role: .destructive) {
                                    pendingDelete = conversation
                                } label: {
                                    Label("删除", systemImage: "trash")
                                }
                            }
                            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                                Button {
                                    setStatus(conversation, status: conversation.status == "closed" ? "open" : "closed")
                                } label: {
                                    Label(conversation.status == "closed" ? "重新打开" : "结束", systemImage: conversation.status == "closed" ? "arrow.uturn.backward" : "checkmark")
                                }
                                .tint(conversation.status == "closed" ? .orange : .green)
                            }
                        }
                    }
                    .listStyle(.plain)
                    .refreshable { await load(showSpinner: false) }
                }
            }
            .overlay(alignment: .bottom) {
                if let errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(.regularMaterial, in: Capsule())
                        .padding()
                }
            }
            .navigationTitle("客服台")
            .navigationDestination(for: Conversation.self) { conversation in
                ChatView(conversation: conversation)
            }
            .searchable(text: $search, prompt: "搜索邮箱、标签、备注、消息")
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Menu {
                        Picker("会话分类", selection: $filter) {
                            ForEach(InboxFilter.allCases) { item in
                                Text(item.rawValue).tag(item)
                            }
                        }
                    } label: {
                        Label(filter.rawValue, systemImage: "line.3.horizontal.decrease.circle")
                    }
                }
                ToolbarItem(placement: .principal) {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(appState.isRealtimeConnected ? Color.green : Color.orange)
                            .frame(width: 8, height: 8)
                        Text("客服台").font(.headline)
                    }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { showSettings = true } label: {
                        Image(systemName: "gearshape")
                    }
                }
            }
            .sheet(isPresented: $showSettings) {
                NativeSettingsView()
            }
            .confirmationDialog(
                "确定永久删除这段会话？",
                isPresented: Binding(
                    get: { pendingDelete != nil },
                    set: { if !$0 { pendingDelete = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("删除会话", role: .destructive) {
                    if let conversation = pendingDelete { delete(conversation) }
                    pendingDelete = nil
                }
                Button("取消", role: .cancel) { pendingDelete = nil }
            } message: {
                Text("聊天记录删除后无法恢复。日常处理完成建议使用“结束”，不要删除。")
            }
            .onReceive(appState.$lastEvent.compactMap { $0 }) { event in
                guard ["new_message", "conversation_updated", "conversation_deleted", "message_recalled"].contains(event.type) else { return }
                scheduleEventRefresh()
            }
            .task(id: search) {
                if !search.isEmpty {
                    try? await Task.sleep(nanoseconds: 300_000_000)
                }
                guard !Task.isCancelled else { return }
                await load(showSpinner: conversations.isEmpty)
                while !Task.isCancelled {
                    let delay: UInt64 = appState.isRealtimeConnected ? 60_000_000_000 : 8_000_000_000
                    try? await Task.sleep(nanoseconds: delay)
                    guard !Task.isCancelled else { break }
                    await load(showSpinner: false)
                }
            }
            .task(id: appState.pendingConversationID) {
                guard let conversationID = appState.pendingConversationID else { return }
                await openConversationFromDeepLink(conversationID)
            }
        }
    }

    private func openConversationFromDeepLink(_ conversationID: String) async {
        guard let client = appState.client else { return }
        do {
            let conversation = try await client.conversation(id: conversationID)
            if navigationPath.last?.id != conversation.id {
                navigationPath = [conversation]
            }
            appState.consumeConversationDeepLink(conversationID)
            errorMessage = nil
        } catch {
            appState.consumeConversationDeepLink(conversationID)
            appState.handleUnauthorized(error)
            errorMessage = "无法打开推送对应的会话：\(error.localizedDescription)"
        }
    }

    private func load(showSpinner: Bool) async {
        guard let client = appState.client else { return }
        loadSequence += 1
        let sequence = loadSequence
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        if showSpinner { isLoading = true }
        do {
            let result = try await client.conversations(search: query)
            guard sequence == loadSequence else { return }
            conversations = result
            if query.isEmpty {
                syncAppBadge(result.reduce(0) { $0 + $1.unreadCount })
            }
            errorMessage = nil
        } catch {
            guard sequence == loadSequence else { return }
            appState.handleUnauthorized(error)
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func syncAppBadge(_ unreadCount: Int) {
        let center = UNUserNotificationCenter.current()
        let applyBadge = {
            center.setBadgeCount(max(0, unreadCount)) { _ in }
        }

        center.getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .notDetermined:
                center.requestAuthorization(options: [.badge]) { granted, _ in
                    if granted { applyBadge() }
                }
            case .authorized, .provisional, .ephemeral:
                if settings.badgeSetting == .enabled { applyBadge() }
            default:
                break
            }
        }
    }

    private func delete(_ conversation: Conversation) {
        Task {
            guard let client = appState.client else { return }
            do {
                try await client.deleteConversation(id: conversation.id)
                conversations.removeAll { $0.id == conversation.id }
            } catch {
                appState.handleUnauthorized(error)
                errorMessage = error.localizedDescription
            }
        }
    }

    private func setStatus(_ conversation: Conversation, status: String) {
        Task {
            guard let client = appState.client else { return }
            do {
                try await client.updateConversation(id: conversation.id, status: status)
                await load(showSpinner: false)
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            } catch {
                appState.handleUnauthorized(error)
                errorMessage = error.localizedDescription
            }
        }
    }

    private func scheduleEventRefresh() {
        eventRefreshTask?.cancel()
        eventRefreshTask = Task {
            try? await Task.sleep(nanoseconds: 120_000_000)
            guard !Task.isCancelled else { return }
            await load(showSpinner: false)
        }
    }
}

private struct ConversationRow: View {
    let conversation: Conversation

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle().fill(Color.blue.opacity(0.12))
                Image(systemName: "person.fill")
                    .foregroundStyle(.blue)
            }
            .frame(width: 42, height: 42)

            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text(conversation.displayName)
                        .font(.headline)
                        .lineLimit(1)
                    Spacer()
                    Text(DisplayFormatters.listDate.string(from: DisplayFormatters.date(milliseconds: conversation.lastMessageAt)))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                HStack {
                    Text(conversation.preview)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer()
                    if conversation.unreadCount > 0 {
                        Text("\(conversation.unreadCount)")
                            .font(.caption2.bold())
                            .foregroundStyle(.white)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(.red, in: Capsule())
                    }
                }
                if conversation.status == "closed" || !(conversation.tags ?? "").isEmpty {
                    HStack(spacing: 5) {
                        if conversation.status == "closed" {
                            Text("已结束")
                                .foregroundStyle(.green)
                        }
                        if let firstTag = conversation.tags?.split(separator: ",").first, !firstTag.isEmpty {
                            Text(String(firstTag))
                                .foregroundStyle(.blue)
                                .lineLimit(1)
                        }
                    }
                    .font(.caption2)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

private enum ComposerPanel: Equatable {
    case emoji
    case tools
}

private struct InteractivePopGestureEnabler: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> EnablerViewController {
        EnablerViewController()
    }

    func updateUIViewController(_ uiViewController: EnablerViewController, context: Context) {
        uiViewController.enableInteractivePop()
    }

    final class EnablerViewController: UIViewController {
        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            enableInteractivePop()
        }

        func enableInteractivePop() {
            navigationController?.interactivePopGestureRecognizer?.delegate = nil
            navigationController?.interactivePopGestureRecognizer?.isEnabled = true
        }
    }
}

private struct ChatView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    let conversation: Conversation

    @State private var liveConversation: Conversation
    @State private var messages: [ChatMessage] = []
    @State private var draft = ""
    @State private var isLoading = true
    @State private var isSending = false
    @State private var errorMessage: String?
    @State private var photoItem: PhotosPickerItem?
    @State private var showPhotoPicker = false
    @State private var showCamera = false
    @State private var showFileImporter = false
    @State private var composerPanel: ComposerPanel?
    @State private var showDetails = false
    @State private var visitorIsTyping = false
    @State private var pendingRecall: ChatMessage?
    @State private var quotedText: String?
    @State private var selectableText: SelectableTextContext?
    @State private var copyConfirmation: String?
    @State private var previewImageURL: URL?
    @State private var typingTask: Task<Void, Never>?
    @State private var typingHideTask: Task<Void, Never>?
    @State private var unreadRefreshTask: Task<Void, Never>?
    @State private var otherUnreadCount = 0
    @State private var messageLoadSequence = 0
    @State private var isReviewingMessageHistory = false
    @FocusState private var composerFocused: Bool

    private let chatBottomID = "chat-bottom-anchor"

    init(conversation: Conversation) {
        self.conversation = conversation
        _liveConversation = State(initialValue: conversation)
    }

    var body: some View {
        VStack(spacing: 0) {
            if isLoading && messages.isEmpty {
                Spacer()
                ProgressView("加载消息…")
                Spacer()
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 10) {
                            ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                                if shouldShowDateSeparator(at: index) {
                                    ChatDateSeparator(
                                        title: DisplayFormatters.chatDayLabel(milliseconds: message.createdAt)
                                    )
                                }
                                MessageBubble(
                                    message: message,
                                    client: appState.client,
                                    receipt: receiptState(for: message),
                                    autoTranslate: appState.autoTranslateEnabled && !message.isAgent,
                                    onImageTap: { previewImageURL = $0 },
                                    onImageLoaded: {
                                        keepChatAtBottom(using: proxy)
                                    },
                                    onQuote: {
                                        quotedText = message.content
                                        composerFocused = true
                                    },
                                    onSelectText: {
                                        selectableText = SelectableTextContext(text: message.content)
                                    },
                                    onRecall: { pendingRecall = message }
                                )
                                .id(message.id)
                            }

                            Color.clear
                                .frame(height: 1)
                                .id(chatBottomID)
                                .onAppear {
                                    isReviewingMessageHistory = false
                                }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 14)
                    }
                    .background(Color(uiColor: .systemGroupedBackground))
                    .simultaneousGesture(
                        DragGesture(minimumDistance: 8)
                            .onChanged { value in
                                if value.translation.height > 8 {
                                    isReviewingMessageHistory = true
                                }
                            }
                    )
                    .onChange(of: messages.last?.id) { _ in
                        keepChatAtBottom(using: proxy, animated: true)
                    }
                    .onAppear {
                        isReviewingMessageHistory = false
                        keepChatAtBottom(using: proxy)
                    }
                }
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal)
                    .padding(.top, 5)
            }

            if let quotedText {
                HStack(spacing: 8) {
                    Rectangle()
                        .fill(Color.blue)
                        .frame(width: 3, height: 34)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("引用回复").font(.caption.bold()).foregroundStyle(.blue)
                        Text(quotedText.replacingOccurrences(of: "\n", with: " "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer()
                    Button { self.quotedText = nil } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .background(Color(uiColor: .secondarySystemBackground))
            }

            HStack(alignment: .bottom, spacing: 5) {
                Button { toggleComposerPanel(.tools) } label: {
                    Image(systemName: composerPanel == .tools ? "xmark.circle.fill" : "plus.circle.fill")
                        .font(.system(size: 21))
                        .frame(width: 24, height: 30)
                }
                .accessibilityLabel(composerPanel == .tools ? "收起功能面板" : "更多功能")

                TextField("输入消息", text: $draft, axis: .vertical)
                    .focused($composerFocused)
                    .lineLimit(1...5)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
                    .onChange(of: draft) { value in
                        if value.isEmpty {
                            UserDefaults.standard.removeObject(forKey: draftStorageKey)
                        } else {
                            UserDefaults.standard.set(value, forKey: draftStorageKey)
                        }
                        if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            scheduleTypingSignal()
                        }
                    }

                Button { toggleComposerPanel(.emoji) } label: {
                    Image(systemName: composerPanel == .emoji ? "keyboard" : "face.smiling")
                        .font(.system(size: 19))
                        .frame(width: 24, height: 30)
                }
                .accessibilityLabel(composerPanel == .emoji ? "收起表情面板" : "表情")

                if isSending {
                    ProgressView()
                        .frame(width: 30, height: 30)
                } else {
                    Button(action: sendText) {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 27))
                            .frame(width: 28, height: 30)
                    }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
            .background(.bar)

            if let composerPanel {
                Group {
                    switch composerPanel {
                    case .emoji:
                        EmojiAccessoryPanel(text: $draft) {
                            closeComposerPanel()
                        }
                    case .tools:
                        ToolsAccessoryPanel(
                            cameraAvailable: UIImagePickerController.isSourceTypeAvailable(.camera),
                            onCamera: {
                                closeComposerPanel()
                                showCamera = true
                            },
                            onPhotos: {
                                closeComposerPanel()
                                showPhotoPicker = true
                            },
                            onFile: {
                                closeComposerPanel()
                                showFileImporter = true
                            },
                            onQuickReply: { content in
                                draft = content
                            },
                            onClose: closeComposerPanel
                        )
                    }
                }
                .frame(height: 220)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: composerPanel)
        .navigationTitle(liveConversation.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .background(InteractivePopGestureEnabler().frame(width: 0, height: 0))
        .overlay(alignment: .top) {
            if let copyConfirmation {
                Label(copyConfirmation, systemImage: "checkmark.circle.fill")
                    .font(.caption.bold())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color.green, in: Capsule())
                    .padding(.top, 6)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                Button { dismiss() } label: {
                    HStack(spacing: 3) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 17, weight: .semibold))
                        if otherUnreadCount > 0 {
                            Text(otherUnreadCount > 99 ? "99+" : "\(otherUnreadCount)")
                                .font(.caption2.bold())
                                .foregroundStyle(.white)
                                .padding(.horizontal, 6)
                                .frame(minWidth: 20, minHeight: 20)
                                .background(Color.red, in: Capsule())
                                .accessibilityLabel("其他会话有 \(otherUnreadCount) 条未读消息")
                        }
                    }
                }
                .accessibilityLabel(otherUnreadCount > 0 ? "返回，其他会话有 \(otherUnreadCount) 条未读消息" : "返回")
            }
            ToolbarItem(placement: .principal) {
                if let email = liveConversation.visitorEmail, !email.isEmpty {
                    Button { copyEmail(email) } label: {
                        VStack(spacing: 1) {
                            HStack(spacing: 5) {
                                Text(email).lineLimit(1)
                                Image(systemName: "doc.on.doc").font(.caption2)
                            }
                            .font(.headline)
                            if visitorIsTyping {
                                Text("对方正在输入…")
                                    .font(.caption2)
                                    .foregroundStyle(.blue)
                                    .transition(.opacity)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("点按复制邮箱")
                } else {
                    VStack(spacing: 1) {
                        Text(liveConversation.displayName).font(.headline).lineLimit(1)
                        if visitorIsTyping {
                            Text("对方正在输入…")
                                .font(.caption2)
                                .foregroundStyle(.blue)
                        }
                    }
                }
            }
            ToolbarItemGroup(placement: .navigationBarTrailing) {
                Button { toggleConversationStatus() } label: {
                    Image(systemName: liveConversation.status == "closed" ? "arrow.uturn.backward.circle" : "checkmark.circle")
                }
                .accessibilityLabel(liveConversation.status == "closed" ? "重新打开会话" : "结束会话")
                Button { showDetails = true } label: {
                    Image(systemName: "person.text.rectangle")
                }
            }
        }
        .sheet(isPresented: $showDetails) {
            ConversationDetailsView(conversation: liveConversation)
        }
        .sheet(item: $selectableText) { context in
            PartialTextSelectionView(text: context.text)
        }
        .sheet(
            isPresented: Binding(
                get: { previewImageURL != nil },
                set: { if !$0 { previewImageURL = nil } }
            )
        ) {
            if let url = previewImageURL {
                ImagePreviewView(url: url)
            }
        }
        .photosPicker(isPresented: $showPhotoPicker, selection: $photoItem, matching: .images)
        .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.item]) { result in
            guard case let .success(url) = result else { return }
            uploadFile(url)
        }
        .fullScreenCover(isPresented: $showCamera) {
            NativeCameraPicker { image in
                showCamera = false
                uploadCameraImage(image)
            } onCancel: {
                showCamera = false
            }
            .ignoresSafeArea()
        }
        .onChange(of: photoItem) { item in
            guard let item else { return }
            uploadPhoto(item)
        }
        .onChange(of: composerFocused) { isFocused in
            if isFocused, composerPanel != nil {
                withAnimation(.easeInOut(duration: 0.2)) {
                    composerPanel = nil
                }
            }
        }
        .confirmationDialog(
            "撤回这条消息？",
            isPresented: Binding(
                get: { pendingRecall != nil },
                set: { if !$0 { pendingRecall = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("撤回", role: .destructive) {
                if let message = pendingRecall { recall(message) }
                pendingRecall = nil
            }
            Button("取消", role: .cancel) { pendingRecall = nil }
        } message: {
            Text("撤回后访客端将不再显示这条消息。")
        }
        .onReceive(appState.$lastEvent.compactMap { $0 }) { event in
            handleRealtimeEvent(event)
        }
        .onDisappear {
            typingTask?.cancel()
            typingTask = nil
            typingHideTask?.cancel()
            unreadRefreshTask?.cancel()
        }
        .onAppear {
            if draft.isEmpty {
                draft = UserDefaults.standard.string(forKey: draftStorageKey) ?? ""
            }
        }
        .task {
            await loadMessages()
            await refreshOtherUnreadCount()
            while !Task.isCancelled {
                let delay: UInt64 = appState.isRealtimeConnected ? 60_000_000_000 : 8_000_000_000
                try? await Task.sleep(nanoseconds: delay)
                guard !Task.isCancelled else { break }
                await loadMessages(showError: false)
                await refreshOtherUnreadCount()
            }
        }
    }

    private func toggleComposerPanel(_ panel: ComposerPanel) {
        composerFocused = false
        withAnimation(.easeInOut(duration: 0.2)) {
            composerPanel = composerPanel == panel ? nil : panel
        }
    }

    private func closeComposerPanel() {
        withAnimation(.easeInOut(duration: 0.2)) {
            composerPanel = nil
        }
    }

    private func keepChatAtBottom(using proxy: ScrollViewProxy, animated: Bool = false) {
        guard !isReviewingMessageHistory else { return }

        DispatchQueue.main.async {
            guard !isReviewingMessageHistory else { return }
            if animated {
                withAnimation(.easeOut(duration: 0.18)) {
                    proxy.scrollTo(chatBottomID, anchor: .bottom)
                }
            } else {
                proxy.scrollTo(chatBottomID, anchor: .bottom)
            }

            // 长文本换行和图片成功态都可能比第一轮布局晚一帧完成。
            // 第二次只做紧邻的布局校准，不使用定时轮询，也不会在用户查看历史时抢滚动位置。
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) {
                guard !isReviewingMessageHistory else { return }
                proxy.scrollTo(chatBottomID, anchor: .bottom)
            }
        }
    }

    private func loadMessages(showError: Bool = true) async {
        guard let client = appState.client else { return }
        messageLoadSequence += 1
        let sequence = messageLoadSequence
        do {
            let serverMessages = try await client.messages(conversationId: conversation.id)
            guard sequence == messageLoadSequence else { return }
            let pending = messages.filter(\.isPending)
            messages = (serverMessages + pending).sorted { $0.createdAt < $1.createdAt }
            liveConversation = try await client.conversation(id: conversation.id)
            try? await client.markRead(conversationId: conversation.id)
            if showError { errorMessage = nil }
        } catch {
            guard sequence == messageLoadSequence else { return }
            appState.handleUnauthorized(error)
            if showError { errorMessage = error.localizedDescription }
        }
        isLoading = false
    }

    private func sendText() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let client = appState.client else { return }
        let quote = quotedText
        let outgoingText = quote.map { "「\($0)」\n\(text)" } ?? text
        let localId = "local-\(UUID().uuidString)"
        let pending = ChatMessage(
            id: localId,
            conversationId: conversation.id,
            sender: "agent",
            type: "text",
            content: outgoingText,
            fileName: nil,
            fileSize: nil,
            createdAt: Int64(Date().timeIntervalSince1970 * 1000),
            recalled: 0
        )
        draft = ""
        quotedText = nil
        isReviewingMessageHistory = false
        messages.append(pending)
        isSending = true
        Task {
            defer { isSending = false }
            do {
                let message = try await client.sendMessage(
                    conversationId: conversation.id,
                    type: "text",
                    content: outgoingText
                )
                messages.removeAll { $0.id == localId }
                if !messages.contains(where: { $0.id == message.id }) {
                    messages.append(message)
                }
                messages.sort { $0.createdAt < $1.createdAt }
                errorMessage = nil
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            } catch {
                messages.removeAll { $0.id == localId }
                draft = text
                quotedText = quote
                appState.handleUnauthorized(error)
                errorMessage = error.localizedDescription
            }
        }
    }

    private func uploadPhoto(_ item: PhotosPickerItem) {
        isSending = true
        Task {
            defer {
                isSending = false
                photoItem = nil
            }
            do {
                guard let raw = try await item.loadTransferable(type: Data.self),
                      let image = UIImage(data: raw),
                      let jpeg = image.jpegData(compressionQuality: 0.88) else {
                    throw AppClientError.invalidResponse
                }
                try await uploadAndSend(data: jpeg, fileName: "photo-\(Int(Date().timeIntervalSince1970)).jpg", mimeType: "image/jpeg")
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func uploadCameraImage(_ image: UIImage) {
        isSending = true
        Task {
            defer { isSending = false }
            do {
                guard let jpeg = image.jpegData(compressionQuality: 0.88) else {
                    throw AppClientError.invalidResponse
                }
                try await uploadAndSend(data: jpeg, fileName: "camera-\(Int(Date().timeIntervalSince1970)).jpg", mimeType: "image/jpeg")
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func uploadFile(_ url: URL) {
        isSending = true
        Task {
            defer { isSending = false }
            let accessing = url.startAccessingSecurityScopedResource()
            defer { if accessing { url.stopAccessingSecurityScopedResource() } }
            do {
                let payload = try await Task.detached(priority: .userInitiated) {
                    let values = try url.resourceValues(forKeys: [.fileSizeKey])
                    if let size = values.fileSize, size > 20 * 1024 * 1024 {
                        throw AppClientError.server(400, "文件不能超过 20MB")
                    }
                    let data = try Data(contentsOf: url)
                    let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                    return (data, url.lastPathComponent, mime)
                }.value
                try await uploadAndSend(data: payload.0, fileName: payload.1, mimeType: payload.2)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func uploadAndSend(data: Data, fileName: String, mimeType: String) async throws {
        guard data.count <= 20 * 1024 * 1024 else {
            throw AppClientError.server(400, "文件不能超过 20MB")
        }
        guard let client = appState.client else { throw AppClientError.invalidServer }
        let upload = try await client.upload(data: data, fileName: fileName, mimeType: mimeType)
        let message = try await client.sendMessage(
            conversationId: conversation.id,
            type: upload.type,
            content: upload.url,
            fileName: upload.name,
            fileSize: upload.size
        )
        if !messages.contains(where: { $0.id == message.id }) {
            isReviewingMessageHistory = false
            messages.append(message)
        }
        messages.sort { $0.createdAt < $1.createdAt }
        errorMessage = nil
    }

    private func recall(_ message: ChatMessage) {
        Task {
            guard let client = appState.client else { return }
            do {
                try await client.recall(conversationId: conversation.id, messageId: message.id)
                await loadMessages()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func toggleConversationStatus() {
        let next = liveConversation.status == "closed" ? "open" : "closed"
        Task {
            guard let client = appState.client else { return }
            do {
                try await client.updateConversation(id: conversation.id, status: next)
                liveConversation = try await client.conversation(id: conversation.id)
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func scheduleTypingSignal() {
        guard typingTask == nil else { return }
        typingTask = Task {
            if let client = appState.client {
                try? await client.sendTyping(conversationId: conversation.id)
            }
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            typingTask = nil
        }
    }

    private func copyEmail(_ email: String) {
        UIPasteboard.general.string = email
        withAnimation { copyConfirmation = "邮箱已复制" }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            withAnimation { copyConfirmation = nil }
        }
    }

    private func handleRealtimeEvent(_ event: NativeEvent) {
        if ["new_message", "conversation_updated", "conversation_deleted"].contains(event.type) {
            scheduleOtherUnreadRefresh()
        }
        guard event.conversationId == conversation.id else { return }
        switch event.type {
        case "visitor_typing":
            visitorIsTyping = true
            typingHideTask?.cancel()
            typingHideTask = Task {
                try? await Task.sleep(nanoseconds: 2_200_000_000)
                guard !Task.isCancelled else { return }
                visitorIsTyping = false
            }
        case "new_message":
            let needsInitialReload = isLoading && messages.isEmpty
            messageLoadSequence += 1
            if let message = event.message {
                if message.sender == "agent",
                   let pendingIndex = messages.firstIndex(where: {
                       $0.isPending && $0.type == message.type && $0.content == message.content
                   }) {
                    messages.remove(at: pendingIndex)
                }
                if !messages.contains(where: { $0.id == message.id }) {
                    messages.append(message)
                }
                messages.sort { $0.createdAt < $1.createdAt }
            }
            Task {
                guard let client = appState.client else { return }
                if needsInitialReload {
                    await loadMessages(showError: false)
                }
                try? await client.markRead(conversationId: conversation.id)
                if let updated = try? await client.conversation(id: conversation.id) {
                    liveConversation = updated
                }
            }
        case "message_recalled":
            messageLoadSequence += 1
            Task { await loadMessages(showError: false) }
        case "conversation_updated":
            Task {
                guard let client = appState.client,
                      let updated = try? await client.conversation(id: conversation.id) else { return }
                liveConversation = updated
            }
        case "conversation_deleted":
            dismiss()
        default:
            break
        }
    }

    private func scheduleOtherUnreadRefresh() {
        unreadRefreshTask?.cancel()
        unreadRefreshTask = Task {
            try? await Task.sleep(nanoseconds: 220_000_000)
            guard !Task.isCancelled else { return }
            await refreshOtherUnreadCount()
        }
    }

    private func refreshOtherUnreadCount() async {
        guard let client = appState.client,
              let allConversations = try? await client.conversations() else { return }
        otherUnreadCount = allConversations
            .filter { $0.id != conversation.id }
            .reduce(0) { $0 + max(0, $1.unreadCount) }
    }

    private func receiptState(for message: ChatMessage) -> MessageReceipt? {
        guard message.isAgent, message.id == messages.last(where: { $0.isAgent })?.id else { return nil }
        if message.isPending { return .sending }
        if (liveConversation.visitorReadAt ?? 0) >= message.createdAt { return .read }
        if (liveConversation.visitorDeliveredAt ?? 0) >= message.createdAt { return .delivered }
        return .sent
    }

    private func shouldShowDateSeparator(at index: Int) -> Bool {
        guard messages.indices.contains(index) else { return false }
        guard index > 0 else { return true }
        let calendar = Calendar.autoupdatingCurrent
        return !calendar.isDate(
            DisplayFormatters.date(milliseconds: messages[index - 1].createdAt),
            inSameDayAs: DisplayFormatters.date(milliseconds: messages[index].createdAt)
        )
    }

    private var draftStorageKey: String {
        "conversation-draft-\(conversation.id)"
    }
}

private struct NativeCameraPicker: UIViewControllerRepresentable {
    let onImage: (UIImage) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onImage: onImage, onCancel: onCancel)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        let onImage: (UIImage) -> Void
        let onCancel: () -> Void

        init(onImage: @escaping (UIImage) -> Void, onCancel: @escaping () -> Void) {
            self.onImage = onImage
            self.onCancel = onCancel
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            if let image = info[.originalImage] as? UIImage { onImage(image) }
            else { onCancel() }
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onCancel()
        }
    }
}

private enum MessageReceipt: Equatable {
    case sending
    case sent
    case delivered
    case read

    var symbol: String {
        switch self {
        case .sending: return "◷"
        case .sent: return "✓"
        case .delivered, .read: return "✓✓"
        }
    }

    var accessibilityText: String {
        switch self {
        case .sending: return "发送中"
        case .sent: return "已发送"
        case .delivered: return "已送达"
        case .read: return "已读"
        }
    }

    var isRead: Bool { self == .read }
    var isDoubleCheck: Bool { self == .delivered || self == .read }
}

@MainActor
private final class PersistentImageLoader: ObservableObject {
    @Published private(set) var image: UIImage?
    @Published private(set) var failed = false
    @Published private(set) var isLoading = false

    private let url: URL
    private let maxPixelSize: Int

    private static let cache = URLCache(
        memoryCapacity: 32 * 1024 * 1024,
        diskCapacity: 256 * 1024 * 1024,
        diskPath: "ServiceDeskImageCache"
    )

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.urlCache = cache
        configuration.requestCachePolicy = .returnCacheDataElseLoad
        configuration.waitsForConnectivity = true
        configuration.httpMaximumConnectionsPerHost = 6
        configuration.httpShouldUsePipelining = true
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 90
        return URLSession(configuration: configuration)
    }()

    init(url: URL, maxPixelSize: Int) {
        self.url = url
        self.maxPixelSize = maxPixelSize
    }

    func load(forceRefresh: Bool = false) async {
        guard !isLoading else { return }
        if image != nil, !forceRefresh { return }
        isLoading = true
        failed = false
        defer { isLoading = false }

        var request = URLRequest(url: url, timeoutInterval: 30)
        request.cachePolicy = forceRefresh ? .reloadRevalidatingCacheData : .returnCacheDataElseLoad
        request.setValue("image/*", forHTTPHeaderField: "Accept")

        if !forceRefresh,
           let cached = Self.cache.cachedResponse(for: request),
           let decoded = await Self.decode(cached.data, maxPixelSize: maxPixelSize) {
            image = decoded
            return
        }

        var lastError: Error?
        for attempt in 0..<3 {
            do {
                let (data, response) = try await Self.session.data(for: request)
                guard let http = response as? HTTPURLResponse,
                      (200..<300).contains(http.statusCode),
                      let decoded = await Self.decode(data, maxPixelSize: maxPixelSize) else {
                    throw URLError(.cannotDecodeContentData)
                }
                Self.cache.storeCachedResponse(CachedURLResponse(response: response, data: data), for: request)
                image = decoded
                return
            } catch {
                lastError = error
                if attempt < 2 {
                    try? await Task.sleep(nanoseconds: UInt64(400 + attempt * 600) * 1_000_000)
                }
            }
        }

        if lastError != nil { failed = true }
    }

    nonisolated private static func decode(_ data: Data, maxPixelSize: Int) async -> UIImage? {
        await Task.detached(priority: .userInitiated) {
            guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
                return UIImage(data: data)
            }
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
                kCGImageSourceShouldCacheImmediately: true
            ]
            guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
                return UIImage(data: data)
            }
            return UIImage(cgImage: cgImage)
        }.value
    }
}

private struct CachedMessageImage: View {
    let onTap: () -> Void
    let onLoaded: () -> Void
    @StateObject private var loader: PersistentImageLoader
    @State private var didNotifyLoaded = false

    init(url: URL, onTap: @escaping () -> Void, onLoaded: @escaping () -> Void) {
        self.onTap = onTap
        self.onLoaded = onLoaded
        _loader = StateObject(wrappedValue: PersistentImageLoader(url: url, maxPixelSize: 960))
    }

    var body: some View {
        Group {
            if let image = loader.image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .onTapGesture(perform: onTap)
                    .onAppear {
                        guard !didNotifyLoaded else { return }
                        didNotifyLoaded = true
                        DispatchQueue.main.async { onLoaded() }
                    }
            } else if loader.failed {
                Button {
                    Task { await loader.load(forceRefresh: true) }
                } label: {
                    Label("图片加载失败，点按重试", systemImage: "arrow.clockwise")
                        .font(.caption)
                        .frame(height: 100)
                }
                .buttonStyle(.plain)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .frame(height: 100)
            }
        }
        .task { await loader.load() }
    }
}

private struct ChatDateSeparator: View {
    let title: String

    var body: some View {
        HStack(spacing: 10) {
            Rectangle().fill(Color.secondary.opacity(0.18)).frame(height: 1)
            Text(title)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 9)
                .padding(.vertical, 4)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: Capsule())
            Rectangle().fill(Color.secondary.opacity(0.18)).frame(height: 1)
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("聊天日期：\(title)")
    }
}

private struct QuotedMessageParts {
    let quote: String
    let body: String

    static func parse(_ content: String) -> QuotedMessageParts? {
        guard content.first == "「",
              let delimiter = content.range(of: "」\n", options: .backwards),
              delimiter.lowerBound > content.startIndex,
              delimiter.upperBound < content.endIndex else { return nil }
        let quoteStart = content.index(after: content.startIndex)
        return QuotedMessageParts(
            quote: String(content[quoteStart..<delimiter.lowerBound]),
            body: String(content[delimiter.upperBound...])
        )
    }
}

private struct QuotedMessageBlock: View {
    let text: String
    let isAgentMessage: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            RoundedRectangle(cornerRadius: 2)
                .fill(isAgentMessage ? Color.white : Color.blue)
                .frame(width: 4)
            VStack(alignment: .leading, spacing: 3) {
                Label("引用消息", systemImage: "arrowshape.turn.up.left.fill")
                    .font(.caption2.bold())
                    .foregroundStyle(isAgentMessage ? Color.white : Color.blue)
                Text(text)
                    .font(.caption)
                    .foregroundStyle(isAgentMessage ? Color.white.opacity(0.9) : Color.primary.opacity(0.82))
                    .lineLimit(4)
                    .multilineTextAlignment(.leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(8)
        .background(
            isAgentMessage ? Color.white.opacity(0.16) : Color.blue.opacity(0.1),
            in: RoundedRectangle(cornerRadius: 9)
        )
    }
}

private struct MessageTextContent: View {
    let content: String
    let isAgentMessage: Bool
    let autoTranslate: Bool
    let isPreview: Bool

    private var parts: QuotedMessageParts? { QuotedMessageParts.parse(content) }
    private var bodyText: String { parts?.body ?? content }

    var body: some View {
        VStack(alignment: .leading, spacing: parts == nil ? 0 : 8) {
            if let parts {
                QuotedMessageBlock(text: parts.quote, isAgentMessage: isAgentMessage)
            }
            if isPreview {
                Text(bodyText)
                    .font(.body)
                    .multilineTextAlignment(.leading)
                    .lineLimit(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                #if canImport(Translation)
                if #available(iOS 18.0, *), autoTranslate {
                    AutoTranslatedMessageText(text: bodyText, isAgentMessage: isAgentMessage)
                } else {
                    LinkifiedSelectableText(text: bodyText, isAgentMessage: isAgentMessage)
                }
                #else
                LinkifiedSelectableText(text: bodyText, isAgentMessage: isAgentMessage)
                #endif
            }
        }
    }
}

private struct MessageBubble: View {
    let message: ChatMessage
    let client: APIClient?
    let receipt: MessageReceipt?
    let autoTranslate: Bool
    let onImageTap: (URL) -> Void
    let onImageLoaded: () -> Void
    let onQuote: () -> Void
    let onSelectText: () -> Void
    let onRecall: () -> Void
    @State private var showFullText = false

    private var isLongText: Bool {
        guard message.type == "text", !message.isRecalled else { return false }
        return message.content.count > 360 || message.content.components(separatedBy: "\n").count > 8
    }

    var body: some View {
        HStack {
            if message.isAgent { Spacer(minLength: 48) }
            VStack(alignment: message.isAgent ? .trailing : .leading, spacing: 4) {
                Group {
                    if message.isRecalled {
                        Text("消息已撤回")
                            .italic()
                            .foregroundStyle(.secondary)
                    } else if message.type == "image", let url = client?.absoluteURL(for: message.content) {
                        CachedMessageImage(
                            url: url,
                            onTap: { onImageTap(url) },
                            onLoaded: onImageLoaded
                        )
                        .frame(maxWidth: 240, maxHeight: 300)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    } else if message.type == "file", let url = client?.absoluteURL(for: message.content) {
                        Link(destination: url) {
                            HStack {
                                Image(systemName: "doc.fill")
                                VStack(alignment: .leading) {
                                    Text(message.fileName ?? "附件").lineLimit(2)
                                    Text(DisplayFormatters.fileSize(message.fileSize))
                                        .font(.caption2)
                                }
                            }
                        }
                    } else if isLongText {
                        Button {
                            showFullText = true
                        } label: {
                            VStack(alignment: .leading, spacing: 7) {
                                MessageTextContent(
                                    content: message.content,
                                    isAgentMessage: message.isAgent,
                                    autoTranslate: false,
                                    isPreview: true
                                )
                                HStack(spacing: 4) {
                                    Spacer()
                                    Text("查看全文")
                                    Image(systemName: "chevron.up.chevron.down")
                                }
                                .font(.caption.bold())
                                .foregroundStyle(message.isAgent ? Color.white.opacity(0.88) : Color.blue)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("点按查看完整消息")
                    } else {
                        MessageTextContent(
                            content: message.content,
                            isAgentMessage: message.isAgent,
                            autoTranslate: autoTranslate,
                            isPreview: false
                        )
                    }
                }
                .padding(message.type == "image" && !message.isRecalled ? 0 : 10)
                .background(
                    message.isAgent ? Color.blue : Color(uiColor: .secondarySystemBackground),
                    in: RoundedRectangle(cornerRadius: 14)
                )
                .foregroundColor(message.isAgent && message.type == "text" && !message.isRecalled ? .white : .primary)

                HStack(spacing: 4) {
                    Text(DisplayFormatters.time.string(from: DisplayFormatters.date(milliseconds: message.createdAt)))
                    if let receipt {
                        Text(receipt.symbol)
                            .fontWeight(.bold)
                            .tracking(receipt.isDoubleCheck ? -3 : 0)
                            .foregroundStyle(receipt.isRead ? Color.blue : Color.secondary)
                            .accessibilityLabel(receipt.accessibilityText)
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            .contextMenu {
                if message.type == "text" && !message.isRecalled {
                    Button(action: onQuote) {
                        Label("引用回复", systemImage: "arrowshape.turn.up.left")
                    }
                    Button {
                        UIPasteboard.general.string = message.content
                    } label: {
                        Label("复制全文", systemImage: "doc.on.doc")
                    }
                    Button(action: onSelectText) {
                        Label("选择部分文字", systemImage: "text.cursor")
                    }
                }
                if message.isAgent && !message.isRecalled {
                    Button(role: .destructive, action: onRecall) {
                        Label("撤回消息", systemImage: "arrow.uturn.backward")
                    }
                }
            }
            .sheet(isPresented: $showFullText) {
                ExpandedMessageTextView(
                    message: message,
                    onQuote: onQuote,
                    onSelectText: onSelectText,
                    onRecall: onRecall
                )
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
            }
            .opacity(message.isPending ? 0.65 : 1)
            if !message.isAgent { Spacer(minLength: 48) }
        }
    }
}

private struct ExpandedMessageTextView: View {
    @Environment(\.dismiss) private var dismiss
    let message: ChatMessage
    let onQuote: () -> Void
    let onSelectText: () -> Void
    let onRecall: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                MessageTextContent(
                    content: message.content,
                    isAgentMessage: false,
                    autoTranslate: false,
                    isPreview: false
                )
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contextMenu { messageActions }
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("完整消息")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
                ToolbarItemGroup(placement: .confirmationAction) {
                    Button(action: quoteAndClose) {
                        Image(systemName: "arrowshape.turn.up.left")
                    }
                    .accessibilityLabel("引用回复")
                    Button {
                        UIPasteboard.general.string = message.content
                        UINotificationFeedbackGenerator().notificationOccurred(.success)
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    .accessibilityLabel("复制全文")
                }
            }
        }
    }

    @ViewBuilder
    private var messageActions: some View {
        Button(action: quoteAndClose) {
            Label("引用回复", systemImage: "arrowshape.turn.up.left")
        }
        Button {
            UIPasteboard.general.string = message.content
        } label: {
            Label("复制全文", systemImage: "doc.on.doc")
        }
        Button(action: selectAndClose) {
            Label("选择部分文字", systemImage: "text.cursor")
        }
        if message.isAgent && !message.isRecalled {
            Button(role: .destructive, action: recallAndClose) {
                Label("撤回消息", systemImage: "arrow.uturn.backward")
            }
        }
    }

    private func quoteAndClose() {
        dismissThen(onQuote)
    }

    private func selectAndClose() {
        dismissThen(onSelectText)
    }

    private func recallAndClose() {
        dismissThen(onRecall)
    }

    private func dismissThen(_ action: @escaping () -> Void) {
        dismiss()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: action)
    }
}

private struct SelectableTextContext: Identifiable {
    let id = UUID()
    let text: String
}

private struct PartialTextSelectionView: View {
    @Environment(\.dismiss) private var dismiss
    let text: String

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 10) {
                Text("长按文字，拖动蓝色选择点选中需要的部分，再点“复制”。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal)
                SelectableUITextView(text: text)
                    .padding(.horizontal, 8)
            }
            .padding(.top, 10)
            .navigationTitle("选择文字")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("复制全文") {
                        UIPasteboard.general.string = text
                        UINotificationFeedbackGenerator().notificationOccurred(.success)
                    }
                }
            }
        }
    }
}

private struct SelectableUITextView: UIViewRepresentable {
    let text: String

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.backgroundColor = .clear
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.textContainerInset = UIEdgeInsets(top: 10, left: 8, bottom: 20, right: 8)
        return view
    }

    func updateUIView(_ uiView: UITextView, context: Context) {
        if uiView.text != text { uiView.text = text }
    }
}

/// A native, selectable message body that recognizes web links without using a WebView.
/// UITextView's data detector also recognizes common bare domains such as example.com.
private struct LinkifiedSelectableText: UIViewRepresentable {
    let text: String
    let isAgentMessage: Bool

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.dataDetectorTypes = [.link]
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.adjustsFontForContentSizeCategory = true
        view.setContentCompressionResistancePriority(.required, for: .vertical)
        view.setContentHuggingPriority(.required, for: .vertical)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        let textColor: UIColor = isAgentMessage ? .white : .label
        let linkColor: UIColor = isAgentMessage ? .white : .systemBlue
        let font = UIFont.preferredFont(forTextStyle: .body)

        if view.text != text {
            view.text = text
        }
        view.font = font
        view.textColor = textColor
        view.tintColor = linkColor
        view.linkTextAttributes = [
            .foregroundColor: linkColor,
            .underlineStyle: NSUnderlineStyle.single.rawValue
        ]
        view.accessibilityLabel = text
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: UITextView,
        context: Context
    ) -> CGSize? {
        let font = uiView.font ?? UIFont.preferredFont(forTextStyle: .body)
        let availableWidth = max(1, proposal.width ?? UIScreen.main.bounds.width * 0.72)
        let bounds = (text as NSString).boundingRect(
            with: CGSize(width: availableWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font],
            context: nil
        )
        let width = min(availableWidth, max(1, ceil(bounds.width) + 1))
        let fitted = uiView.sizeThatFits(
            CGSize(width: width, height: .greatestFiniteMagnitude)
        )
        return CGSize(width: width, height: max(1, ceil(fitted.height)))
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        func textView(
            _ textView: UITextView,
            shouldInteractWith url: URL,
            in characterRange: NSRange,
            interaction: UITextItemInteraction
        ) -> Bool {
            guard let scheme = url.scheme?.lowercased(),
                  scheme == "http" || scheme == "https" else {
                return true
            }
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
            return false
        }
    }
}

#if canImport(Translation)
@available(iOS 18.0, *)
private struct AutoTranslatedMessageText: View {
    let text: String
    let isAgentMessage: Bool
    @State private var translatedText: String?
    @State private var configuration: TranslationSession.Configuration?

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            LinkifiedSelectableText(text: text, isAgentMessage: isAgentMessage)
            if let translatedText, translatedText != text {
                Divider()
                HStack(alignment: .top, spacing: 5) {
                    Image(systemName: "translate")
                        .font(.caption)
                        .foregroundStyle(.blue)
                    LinkifiedSelectableText(
                        text: translatedText,
                        isAgentMessage: isAgentMessage
                    )
                }
            }
        }
        .task {
            if configuration == nil {
                configuration = TranslationSession.Configuration(
                    source: nil,
                    target: Locale.Language(identifier: "zh-Hans")
                )
            }
        }
        .translationTask(configuration) { session in
            do {
                let response = try await session.translate(text)
                translatedText = response.targetText
            } catch {
                translatedText = nil
            }
        }
    }
}
#endif

private struct ImagePreviewView: View {
    @Environment(\.dismiss) private var dismiss
    let url: URL
    @StateObject private var loader: PersistentImageLoader

    init(url: URL) {
        self.url = url
        _loader = StateObject(wrappedValue: PersistentImageLoader(url: url, maxPixelSize: 3000))
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                if let uiImage = loader.image {
                    LiveTextImageView(image: uiImage)
                    .ignoresSafeArea(edges: .horizontal)
                } else if loader.failed {
                    Button {
                        Task { await loader.load(forceRefresh: true) }
                    } label: {
                        Label("图片加载失败，点按重试", systemImage: "arrow.clockwise")
                            .foregroundStyle(.white)
                    }
                } else {
                    ProgressView().tint(.white)
                }
            }
            .task { await loader.load() }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                        .foregroundStyle(.white)
                }
            }
            .toolbarBackground(.black, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
    }
}

private struct LiveTextImageView: UIViewRepresentable {
    let image: UIImage

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> UIScrollView {
        let scrollView = UIScrollView()
        scrollView.delegate = context.coordinator
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 5
        scrollView.bouncesZoom = true
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.backgroundColor = .black

        let imageView = context.coordinator.imageView
        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageView.contentMode = .scaleAspectFit
        imageView.clipsToBounds = true
        imageView.isUserInteractionEnabled = true
        scrollView.addSubview(imageView)
        NSLayoutConstraint.activate([
            imageView.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            imageView.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            imageView.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            imageView.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor),
            imageView.heightAnchor.constraint(equalTo: scrollView.frameLayoutGuide.heightAnchor)
        ])

        imageView.addInteraction(context.coordinator.interaction)
        let doubleTap = UITapGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleDoubleTap(_:))
        )
        doubleTap.numberOfTapsRequired = 2
        imageView.addGestureRecognizer(doubleTap)
        context.coordinator.scrollView = scrollView
        context.coordinator.set(image: image)
        return scrollView
    }

    func updateUIView(_ scrollView: UIScrollView, context: Context) {
        context.coordinator.set(image: image)
    }

    static func dismantleUIView(_ uiView: UIScrollView, coordinator: Coordinator) {
        coordinator.analysisTask?.cancel()
    }

    @MainActor
    final class Coordinator: NSObject, UIScrollViewDelegate {
        let imageView = UIImageView()
        let interaction = ImageAnalysisInteraction()
        let analyzer = ImageAnalyzer()
        weak var scrollView: UIScrollView?
        var analysisTask: Task<Void, Never>?

        private var currentImage: UIImage?

        override init() {
            super.init()
            interaction.allowLongPressForDataDetectorsInTextMode = true
            interaction.isSupplementaryInterfaceHidden = false
            interaction.supplementaryInterfaceContentInsets = UIEdgeInsets(
                top: 12,
                left: 12,
                bottom: 16,
                right: 12
            )
        }

        func set(image: UIImage) {
            let isNewImage = currentImage !== image
            if isNewImage {
                currentImage = image
                imageView.image = image
                scrollView?.setZoomScale(1, animated: false)
                analyze(image)
            }
        }

        private func analyze(_ image: UIImage) {
            analysisTask?.cancel()
            interaction.preferredInteractionTypes = []
            interaction.analysis = nil

            guard ImageAnalyzer.isSupported else {
                return
            }

            analysisTask = Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    let configuration = ImageAnalyzer.Configuration([.text])
                    let analysis = try await analyzer.analyze(image, configuration: configuration)
                    guard !Task.isCancelled,
                          let currentImage,
                          currentImage === image else { return }
                    interaction.analysis = analysis
                    interaction.preferredInteractionTypes = .automaticTextOnly
                    interaction.isSupplementaryInterfaceHidden = false
                } catch is CancellationError {
                    return
                } catch {
                    return
                }
            }
        }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? {
            imageView
        }

        @objc func handleDoubleTap(_ recognizer: UITapGestureRecognizer) {
            guard let scrollView else { return }
            if scrollView.zoomScale > 1 {
                scrollView.setZoomScale(1, animated: true)
            } else {
                scrollView.setZoomScale(min(2, scrollView.maximumZoomScale), animated: true)
            }
        }
    }
}


private struct AccessoryPanelHeader: View {
    let title: String
    let trailingSystemImage: String?
    let trailingAction: (() -> Void)?
    let onClose: () -> Void

    var body: some View {
        ZStack {
            Capsule()
                .fill(Color.secondary.opacity(0.35))
                .frame(width: 36, height: 5)

            HStack {
                Text(title)
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)
                Spacer()
                if let trailingSystemImage, let trailingAction {
                    Button(action: trailingAction) {
                        Image(systemName: trailingSystemImage)
                            .font(.system(size: 16, weight: .semibold))
                            .frame(width: 30, height: 28)
                    }
                    .buttonStyle(.plain)
                }
                Button(action: onClose) {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 15, weight: .semibold))
                        .frame(width: 30, height: 28)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("收起面板")
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 32)
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 12)
                .onEnded { value in
                    if value.translation.height > 35 {
                        onClose()
                    }
                }
        )
    }
}

private struct EmojiAccessoryPanel: View {
    @Binding var text: String
    let onClose: () -> Void

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 5), count: 8)
    private let emojis = [
        "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣",
        "😊", "😇", "🙂", "🙃", "😉", "😌", "😍", "🥰",
        "😘", "😗", "😙", "😚", "😋", "😛", "😝", "😜",
        "🤪", "🤨", "🧐", "🤓", "😎", "🤩", "🥳", "😏",
        "😒", "😞", "😔", "😟", "😕", "🙁", "☹️", "😣",
        "😖", "😫", "😩", "🥺", "😢", "😭", "😤", "😠",
        "😡", "🤬", "🤯", "😳", "🥵", "🥶", "😱", "😨",
        "😰", "😥", "😓", "🤗", "🤔", "🫡", "🤭", "🤫",
        "🤥", "😶", "😐", "😑", "😬", "🙄", "😯", "😦",
        "😧", "😮", "😲", "🥱", "😴", "🤤", "😪", "😵",
        "👍", "👎", "👌", "✌️", "🤞", "🤟", "🤘", "🤙",
        "👏", "🙌", "🫶", "🙏", "💪", "👋", "🤝", "💯",
        "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍",
        "🔥", "✨", "🎉", "🎁", "🌟", "⭐️", "💫", "💬"
    ]

    var body: some View {
        VStack(spacing: 0) {
            AccessoryPanelHeader(
                title: "表情",
                trailingSystemImage: "delete.left",
                trailingAction: {
                    if !text.isEmpty { text.removeLast() }
                },
                onClose: onClose
            )

            ScrollView(.vertical, showsIndicators: true) {
                LazyVGrid(columns: columns, spacing: 6) {
                    ForEach(Array(emojis.enumerated()), id: \.offset) { item in
                        Button {
                            text.append(item.element)
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        } label: {
                            Text(item.element)
                                .font(.system(size: 27))
                                .frame(maxWidth: .infinity, minHeight: 36)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(item.element)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.bottom, 12)
            }
        }
        .background(Color(uiColor: .secondarySystemBackground))
    }
}

private struct ToolsAccessoryPanel: View {
    @EnvironmentObject private var appState: AppState
    let cameraAvailable: Bool
    let onCamera: () -> Void
    let onPhotos: () -> Void
    let onFile: () -> Void
    let onQuickReply: (String) -> Void
    let onClose: () -> Void

    @State private var replies: [CannedReply] = []
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            AccessoryPanelHeader(
                title: "更多",
                trailingSystemImage: nil,
                trailingAction: nil,
                onClose: onClose
            )

            ScrollView(.vertical, showsIndicators: true) {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 12) {
                        AccessoryToolButton(title: "拍照", systemImage: "camera.fill", action: onCamera)
                            .disabled(!cameraAvailable)
                            .opacity(cameraAvailable ? 1 : 0.4)
                        AccessoryToolButton(title: "相册", systemImage: "photo.fill", action: onPhotos)
                        AccessoryToolButton(title: "文件", systemImage: "doc.fill", action: onFile)
                    }

                    Divider()

                    Text("常用语")
                        .font(.caption.bold())
                        .foregroundStyle(.secondary)

                    if replies.isEmpty {
                        Text(errorMessage ?? "暂无常用语")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, minHeight: 48, alignment: .center)
                    } else {
                        LazyVStack(spacing: 7) {
                            ForEach(replies) { reply in
                                Button {
                                    onQuickReply(reply.content)
                                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                } label: {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(reply.title)
                                            .font(.subheadline.bold())
                                            .foregroundStyle(.primary)
                                        Text(reply.content)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(2)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 8)
                                    .background(Color(uiColor: .tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 14)
            }
        }
        .background(Color(uiColor: .secondarySystemBackground))
        .task {
            do {
                replies = try await appState.client?.cannedReplies() ?? []
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

private struct AccessoryToolButton: View {
    let title: String
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 5) {
                Image(systemName: systemImage)
                    .font(.system(size: 22, weight: .medium))
                    .frame(height: 28)
                Text(title)
                    .font(.caption)
            }
            .foregroundStyle(.primary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background(Color(uiColor: .tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
    }
}

private struct EmojiPickerView: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var text: String

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 6), count: 8)
    private let emojis = [
        "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣",
        "😊", "😇", "🙂", "🙃", "😉", "😌", "😍", "🥰",
        "😘", "😗", "😙", "😚", "😋", "😛", "😝", "😜",
        "🤪", "🤨", "🧐", "🤓", "😎", "🥳", "🤩", "😏",
        "😒", "😞", "😔", "😟", "😕", "🙁", "☹️", "😣",
        "😖", "😫", "😩", "🥺", "😢", "😭", "😤", "😠",
        "😡", "🤬", "🤯", "😳", "🥵", "🥶", "😱", "😨",
        "😰", "😥", "😓", "🤗", "🤔", "🫡", "🤭", "🤫",
        "🤥", "😶", "😐", "😑", "😬", "🙄", "😯", "😦",
        "😧", "😮", "😲", "🥱", "😴", "🤤", "😪", "😵",
        "👍", "👎", "👌", "✌️", "🤞", "🤟", "🤘", "🤙",
        "👏", "🙌", "🫶", "🙏", "💪", "👋", "🤝", "💯",
        "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍",
        "💔", "❣️", "💕", "💞", "💓", "💗", "💖", "💘",
        "🔥", "✨", "🎉", "🎊", "🎁", "⭐️", "🌟", "💡",
        "✅", "❌", "⚠️", "❓", "❗️", "📌", "📎", "📷"
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 9) {
                    ForEach(emojis, id: \.self) { emoji in
                        Button {
                            text.append(emoji)
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        } label: {
                            Text(emoji)
                                .font(.system(size: 28))
                                .frame(maxWidth: .infinity, minHeight: 38)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(emoji)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 16)
            }
            .navigationTitle("表情")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        if !text.isEmpty { text.removeLast() }
                    } label: {
                        Image(systemName: "delete.left")
                    }
                    .accessibilityLabel("删除一个字符")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
    }
}

private struct QuickRepliesView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    let onSelect: (String) -> Void
    @State private var replies: [CannedReply] = []
    @State private var errorMessage: String?
    @State private var search = ""

    private var filteredReplies: [CannedReply] {
        guard !search.isEmpty else { return replies }
        return replies.filter {
            $0.title.localizedCaseInsensitiveContains(search) ||
            $0.content.localizedCaseInsensitiveContains(search)
        }
    }

    var body: some View {
        NavigationStack {
            List(filteredReplies) { reply in
                Button {
                    onSelect(reply.content)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(reply.title).font(.headline)
                        Text(reply.content).foregroundStyle(.secondary).lineLimit(3)
                    }
                }
                .buttonStyle(.plain)
            }
            .overlay {
                if replies.isEmpty {
                    Text(errorMessage ?? "暂无常用语").foregroundStyle(.secondary)
                }
            }
            .navigationTitle("常用语")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $search, prompt: "搜索常用语")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
            }
            .task {
                do { replies = try await appState.client?.cannedReplies() ?? [] }
                catch { errorMessage = error.localizedDescription }
            }
        }
    }
}

private struct ConversationDetailsView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    let conversation: Conversation
    @State private var notes: String
    @State private var tags: String
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var copyMessage: String?

    init(conversation: Conversation) {
        self.conversation = conversation
        _notes = State(initialValue: conversation.notes ?? "")
        _tags = State(initialValue: conversation.tags ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("访客") {
                    if let email = conversation.visitorEmail, !email.isEmpty {
                        Button { copyValue(email, confirmation: "邮箱已复制") } label: {
                            HStack {
                                Text("邮箱").foregroundStyle(.primary)
                                Spacer()
                                Text(email).foregroundStyle(.secondary).lineLimit(1)
                                Image(systemName: "doc.on.doc").foregroundStyle(.blue)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("点按复制邮箱")
                    } else {
                        LabeledContent("邮箱", value: "未填写")
                    }
                    if let ip = conversation.visitorIP, !ip.isEmpty {
                        Button { copyValue(ip, confirmation: "IP 已复制") } label: {
                            HStack {
                                Text("最近 IP").foregroundStyle(.primary)
                                Spacer()
                                Text(ip).foregroundStyle(.secondary).lineLimit(1)
                                Image(systemName: "doc.on.doc").foregroundStyle(.blue)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("点按复制访客 IP")
                    } else {
                        LabeledContent("最近 IP", value: "暂无记录")
                    }
                    LabeledContent("称呼", value: conversation.visitorName ?? "访客")
                    if let url = conversation.lastUrl, !url.isEmpty {
                        LabeledContent("来源页面", value: url)
                    }
                }
                if let copyMessage {
                    Section { Label(copyMessage, systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
                }
                Section("标签") {
                    TextField("多个标签用逗号分隔", text: $tags)
                }
                Section("内部备注") {
                    TextEditor(text: $notes).frame(minHeight: 120)
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .navigationTitle("会话资料")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "保存中…" : "保存") { save() }
                        .disabled(isSaving)
                }
            }
        }
    }

    private func save() {
        isSaving = true
        Task {
            do {
                try await appState.client?.updateConversation(id: conversation.id, notes: notes, tags: tags)
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
            isSaving = false
        }
    }

    private func copyValue(_ value: String, confirmation: String) {
        UIPasteboard.general.string = value
        copyMessage = confirmation
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            copyMessage = nil
        }
    }
}

private struct NativeSettingsView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var barkURL = ""
    @State private var isSaving = false
    @State private var message: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("服务器") {
                    LabeledContent("域名", value: appState.serverURL?.host ?? "")
                    Button("更换服务器", role: .destructive) {
                        appState.forgetServer()
                        dismiss()
                    }
                }
                Section("客户聊天插件") {
                    NavigationLink {
                        WidgetAppearanceSettingsView()
                    } label: {
                        Label("外观与欢迎语", systemImage: "paintpalette")
                    }
                    NavigationLink {
                        WidgetMenuSettingsView()
                    } label: {
                        Label("聊天菜单", systemImage: "list.bullet.rectangle")
                    }
                    NavigationLink {
                        CannedReplyManagementView()
                    } label: {
                        Label("常用语管理", systemImage: "text.bubble")
                    }
                }
                Section("消息提醒") {
                    Toggle(
                        "APP 前台新消息提示音",
                        isOn: Binding(
                            get: { appState.foregroundSoundEnabled },
                            set: { appState.setForegroundSoundEnabled($0) }
                        )
                    )
                    Toggle(
                        "自动翻译客户文字",
                        isOn: Binding(
                            get: { appState.autoTranslateEnabled },
                            set: { appState.setAutoTranslateEnabled($0) }
                        )
                    )
                    .disabled(!supportsNativeTranslation)
                    if !supportsNativeTranslation {
                        Text("自动翻译需要 iOS 18 或更高版本。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Section {
                    TextField("https://api.day.app/你的Key", text: $barkURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    Button(isSaving ? "保存中…" : "保存 Bark 地址") { saveBark() }
                        .disabled(isSaving)
                } header: {
                    Text("Bark 推送")
                } footer: {
                    Text("无 APNs 版本在后台和锁屏时使用 Bark 提醒；App 前台由 SSE 实时接收消息。")
                }
                if let message {
                    Section { Text(message).foregroundStyle(.secondary) }
                }
                Section {
                    Button("退出登录", role: .destructive) {
                        Task {
                            await appState.logout()
                            dismiss()
                        }
                    }
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
            .task {
                do {
                    let settings = try await appState.client?.settings() ?? [:]
                    barkURL = settings["bark_url"] ?? ""
                } catch {
                    message = error.localizedDescription
                }
            }
        }
    }

    private func saveBark() {
        isSaving = true
        message = nil
        Task {
            do {
                try await appState.client?.saveSettings(["bark_url": barkURL.trimmingCharacters(in: .whitespacesAndNewlines)])
                message = "已保存"
            } catch {
                message = error.localizedDescription
            }
            isSaving = false
        }
    }

    private var supportsNativeTranslation: Bool {
        if #available(iOS 18.0, *) { return true }
        return false
    }

}

private struct WidgetAppearanceSettingsView: View {
    @EnvironmentObject private var appState: AppState
    @State private var title = "在线客服"
    @State private var launcherText = "点我联系客服"
    @State private var welcomeMessage = "你好呀，有什么可以帮你的？"
    @State private var primaryColor = Color(hexRGB: "#6D5DFB")
    @State private var secondaryColor = Color(hexRGB: "#3B82F6")
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var message: String?

    var body: some View {
        Form {
            Section("实时预览") {
                VStack(spacing: 10) {
                    Text(title.isEmpty ? "在线客服" : title)
                        .font(.headline)
                        .foregroundStyle(.white)
                    Text(welcomeMessage.isEmpty ? "欢迎语已隐藏" : welcomeMessage)
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.9))
                    Text(launcherText.isEmpty ? "不显示竖排文字" : launcherText)
                        .font(.caption)
                        .foregroundStyle(.white)
                }
                .frame(maxWidth: .infinity)
                .padding()
                .background(
                    LinearGradient(
                        colors: [primaryColor, secondaryColor],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    in: RoundedRectangle(cornerRadius: 14)
                )
            }

            Section("文字") {
                TextField("窗口标题", text: $title)
                TextField("悬浮按钮竖排文字（可留空）", text: $launcherText)
                TextField("访客首次打开的欢迎语（可留空）", text: $welcomeMessage, axis: .vertical)
                    .lineLimit(2...5)
            }

            Section("颜色") {
                ColorPicker("渐变起始色", selection: $primaryColor, supportsOpacity: false)
                ColorPicker("渐变结束色", selection: $secondaryColor, supportsOpacity: false)
                Text("两个颜色设成相同就是纯色。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let message {
                Section { Text(message).foregroundStyle(.secondary) }
            }
        }
        .navigationTitle("插件外观")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "保存中…" : "保存") { save() }
                    .disabled(isSaving || isLoading || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .task { await load() }
    }

    private func load() async {
        do {
            let settings = try await appState.client?.settings() ?? [:]
            title = settings["widget_title"] ?? "在线客服"
            launcherText = settings["widget_launcher_text"] ?? "点我联系客服"
            welcomeMessage = settings["widget_welcome_message"] ?? "你好呀，有什么可以帮你的？"
            primaryColor = Color(hexRGB: settings["widget_color"] ?? "#6D5DFB")
            secondaryColor = Color(hexRGB: settings["widget_color2"] ?? "#3B82F6")
            message = nil
        } catch {
            message = error.localizedDescription
        }
        isLoading = false
    }

    private func save() {
        isSaving = true
        message = nil
        Task {
            do {
                try await appState.client?.saveSettings([
                    "widget_title": title.trimmingCharacters(in: .whitespacesAndNewlines),
                    "widget_color": primaryColor.hexRGB,
                    "widget_color2": secondaryColor.hexRGB,
                    "widget_launcher_text": launcherText.trimmingCharacters(in: .whitespacesAndNewlines),
                    "widget_welcome_message": welcomeMessage.trimmingCharacters(in: .whitespacesAndNewlines)
                ])
                message = "已保存，访客刷新网页后生效"
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } catch {
                message = error.localizedDescription
            }
            isSaving = false
        }
    }
}

private extension Color {
    init(hexRGB: String) {
        let value = hexRGB.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var number: UInt64 = 0
        Scanner(string: value).scanHexInt64(&number)
        guard value.count == 6 else {
            self = .blue
            return
        }
        self.init(
            red: Double((number >> 16) & 0xff) / 255,
            green: Double((number >> 8) & 0xff) / 255,
            blue: Double(number & 0xff) / 255
        )
    }

    var hexRGB: String {
        let color = UIColor(self)
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        guard color.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return "#6D5DFB" }
        return String(format: "#%02X%02X%02X", Int(red * 255), Int(green * 255), Int(blue * 255))
    }
}

private struct CannedReplyEditorContext: Identifiable {
    let id = UUID()
    let reply: CannedReply?
}

private struct CannedReplyManagementView: View {
    @EnvironmentObject private var appState: AppState
    @State private var replies: [CannedReply] = []
    @State private var editor: CannedReplyEditorContext?
    @State private var errorMessage: String?
    @State private var isLoading = true

    var body: some View {
        List {
            ForEach(replies) { reply in
                Button { editor = CannedReplyEditorContext(reply: reply) } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(reply.title).font(.headline)
                        Text(reply.content).foregroundStyle(.secondary).lineLimit(3)
                    }
                }
                .buttonStyle(.plain)
                .swipeActions {
                    Button("删除", role: .destructive) { delete(reply) }
                }
            }
        }
        .overlay {
            if isLoading { ProgressView() }
            else if replies.isEmpty { Text(errorMessage ?? "暂无常用语").foregroundStyle(.secondary) }
        }
        .navigationTitle("常用语管理")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button { editor = CannedReplyEditorContext(reply: nil) } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .sheet(item: $editor) { context in
            CannedReplyEditorView(reply: context.reply) {
                Task { await load() }
            }
        }
        .task { await load() }
    }

    private func load() async {
        do {
            replies = try await appState.client?.cannedReplies() ?? []
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func delete(_ reply: CannedReply) {
        Task {
            do {
                try await appState.client?.deleteCannedReply(id: reply.id)
                replies.removeAll { $0.id == reply.id }
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

private struct CannedReplyEditorView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    let reply: CannedReply?
    let onSaved: () -> Void
    @State private var title: String
    @State private var content: String
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(reply: CannedReply?, onSaved: @escaping () -> Void) {
        self.reply = reply
        self.onSaved = onSaved
        _title = State(initialValue: reply?.title ?? "")
        _content = State(initialValue: reply?.content ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("标题") { TextField("例如：售后说明", text: $title) }
                Section("回复内容") { TextEditor(text: $content).frame(minHeight: 160) }
                if let errorMessage { Section { Text(errorMessage).foregroundStyle(.red) } }
            }
            .navigationTitle(reply == nil ? "新增常用语" : "编辑常用语")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "保存中…" : "保存") { save() }
                        .disabled(isSaving || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func save() {
        isSaving = true
        Task {
            do {
                let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
                let cleanContent = content.trimmingCharacters(in: .whitespacesAndNewlines)
                if let reply {
                    try await appState.client?.updateCannedReply(id: reply.id, title: cleanTitle, content: cleanContent)
                } else {
                    _ = try await appState.client?.createCannedReply(title: cleanTitle, content: cleanContent)
                }
                onSaved()
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
            isSaving = false
        }
    }
}

private struct WidgetMenuEditorContext: Identifiable {
    let id = UUID()
    let item: WidgetMenuItem?
}

private struct WidgetMenuRow: Identifiable {
    let item: WidgetMenuItem
    let depth: Int
    var id: String { item.id }
}

private struct WidgetMenuSettingsView: View {
    @EnvironmentObject private var appState: AppState
    @State private var items: [WidgetMenuItem] = []
    @State private var editor: WidgetMenuEditorContext?
    @State private var errorMessage: String?
    @State private var isLoading = true

    private var rows: [WidgetMenuRow] {
        var output: [WidgetMenuRow] = []
        var visited = Set<String>()
        func appendChildren(of parentID: String?, depth: Int) {
            items
                .filter { $0.parentId == parentID }
                .sorted { $0.sortOrder == $1.sortOrder ? $0.createdAt < $1.createdAt : $0.sortOrder < $1.sortOrder }
                .forEach { item in
                    guard visited.insert(item.id).inserted else { return }
                    output.append(WidgetMenuRow(item: item, depth: depth))
                    appendChildren(of: item.id, depth: depth + 1)
                }
        }
        appendChildren(of: nil, depth: 0)
        items.filter { !visited.contains($0.id) }.forEach { output.append(WidgetMenuRow(item: $0, depth: 0)) }
        return output
    }

    var body: some View {
        List {
            Section {
                ForEach(rows) { row in
                    Button { editor = WidgetMenuEditorContext(item: row.item) } label: {
                        HStack(alignment: .top, spacing: 8) {
                            if row.depth > 0 {
                                Image(systemName: "arrow.turn.down.right")
                                    .foregroundStyle(.secondary)
                            }
                            VStack(alignment: .leading, spacing: 4) {
                                Text(row.item.title).font(.headline)
                                Text((row.item.content ?? "").isEmpty ? "子菜单" : row.item.content ?? "")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                        }
                        .padding(.leading, CGFloat(row.depth) * 14)
                    }
                    .buttonStyle(.plain)
                    .swipeActions {
                        Button("删除", role: .destructive) { delete(row.item) }
                    }
                }
            } footer: {
                Text("内容留空表示这是一个可继续展开的菜单；填写内容表示客户点击后直接看到答案。")
            }
        }
        .overlay {
            if isLoading { ProgressView() }
            else if items.isEmpty { Text(errorMessage ?? "暂无聊天菜单").foregroundStyle(.secondary) }
        }
        .navigationTitle("聊天菜单")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button { editor = WidgetMenuEditorContext(item: nil) } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .sheet(item: $editor) { context in
            WidgetMenuEditorView(allItems: items, item: context.item) {
                Task { await load() }
            }
        }
        .task { await load() }
    }

    private func load() async {
        do {
            items = try await appState.client?.menuItems() ?? []
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func delete(_ item: WidgetMenuItem) {
        Task {
            do {
                try await appState.client?.deleteMenuItem(id: item.id)
                await load()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

private struct WidgetMenuEditorView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    let allItems: [WidgetMenuItem]
    let item: WidgetMenuItem?
    let onSaved: () -> Void
    @State private var parentID: String?
    @State private var title: String
    @State private var content: String
    @State private var sortOrder: Int
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(allItems: [WidgetMenuItem], item: WidgetMenuItem?, onSaved: @escaping () -> Void) {
        self.allItems = allItems
        self.item = item
        self.onSaved = onSaved
        _parentID = State(initialValue: item?.parentId)
        _title = State(initialValue: item?.title ?? "")
        _content = State(initialValue: item?.content ?? "")
        _sortOrder = State(initialValue: item?.sortOrder ?? 0)
    }

    private var parentCandidates: [WidgetMenuItem] {
        let blocked = descendantIDs(of: item?.id)
        return allItems
            .filter { ($0.content ?? "").isEmpty && $0.id != item?.id && !blocked.contains($0.id) }
            .sorted { $0.sortOrder == $1.sortOrder ? $0.createdAt < $1.createdAt : $0.sortOrder < $1.sortOrder }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("位置") {
                    Picker("上级菜单", selection: $parentID) {
                        Text("顶级菜单").tag(nil as String?)
                        ForEach(parentCandidates) { candidate in
                            Text(candidate.title).tag(Optional(candidate.id))
                        }
                    }
                    Stepper("排序：\(sortOrder)", value: $sortOrder, in: 0...999)
                }
                Section("标题") { TextField("例如：发卡问题", text: $title) }
                Section {
                    TextEditor(text: $content).frame(minHeight: 140)
                } header: {
                    Text("点击后显示的内容")
                } footer: {
                    Text("留空表示这是一个子菜单入口；填写后表示这是最终答案。")
                }
                if let errorMessage { Section { Text(errorMessage).foregroundStyle(.red) } }
            }
            .navigationTitle(item == nil ? "新增菜单项" : "编辑菜单项")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "保存中…" : "保存") { save() }
                        .disabled(isSaving || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func descendantIDs(of rootID: String?) -> Set<String> {
        guard let rootID else { return [] }
        var result = Set<String>()
        var queue = [rootID]
        while let parent = queue.popLast() {
            for child in allItems where child.parentId == parent && result.insert(child.id).inserted {
                queue.append(child.id)
            }
        }
        return result
    }

    private func save() {
        isSaving = true
        Task {
            do {
                let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
                let cleanContent = content.trimmingCharacters(in: .whitespacesAndNewlines)
                if let item {
                    try await appState.client?.updateMenuItem(
                        id: item.id,
                        parentId: parentID,
                        title: cleanTitle,
                        content: cleanContent,
                        sortOrder: sortOrder
                    )
                } else {
                    _ = try await appState.client?.createMenuItem(
                        parentId: parentID,
                        title: cleanTitle,
                        content: cleanContent,
                        sortOrder: sortOrder
                    )
                }
                onSaved()
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
            isSaving = false
        }
    }
}
