import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import UIKit
import Combine

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
                    try? await Task.sleep(nanoseconds: 15_000_000_000)
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
            errorMessage = nil
        } catch {
            guard sequence == loadSequence else { return }
            appState.handleUnauthorized(error)
            errorMessage = error.localizedDescription
        }
        isLoading = false
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
    @State private var showQuickReplies = false
    @State private var showDetails = false
    @State private var visitorIsTyping = false
    @State private var pendingRecall: ChatMessage?
    @State private var previewImageURL: URL?
    @State private var typingTask: Task<Void, Never>?
    @State private var typingHideTask: Task<Void, Never>?
    @State private var messageLoadSequence = 0
    @FocusState private var composerFocused: Bool

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
                            ForEach(messages) { message in
                                MessageBubble(
                                    message: message,
                                    client: appState.client,
                                    receipt: receiptText(for: message),
                                    onImageTap: { previewImageURL = $0 }
                                ) {
                                    pendingRecall = message
                                }
                                .id(message.id)
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 14)
                    }
                    .background(Color(uiColor: .systemGroupedBackground))
                    .onChange(of: messages.count) { _ in
                        guard let last = messages.last else { return }
                        withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                    .onAppear {
                        if let last = messages.last { proxy.scrollTo(last.id, anchor: .bottom) }
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

            if visitorIsTyping {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("对方正在输入…")
                    Spacer()
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 14)
                .padding(.top, 5)
            }

            HStack(alignment: .bottom, spacing: 10) {
                Menu {
                    Button { showPhotoPicker = true } label: {
                        Label("照片", systemImage: "photo")
                    }
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button { showCamera = true } label: {
                            Label("拍照", systemImage: "camera")
                        }
                    }
                    Button { showFileImporter = true } label: {
                        Label("文件", systemImage: "doc")
                    }
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .font(.system(size: 25))
                }

                Button { showQuickReplies = true } label: {
                    Image(systemName: "text.bubble")
                        .font(.system(size: 22))
                }

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

                if isSending {
                    ProgressView()
                        .frame(width: 30, height: 30)
                } else {
                    Button(action: sendText) {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 30))
                    }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(.bar)
        }
        .navigationTitle(liveConversation.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
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
        .sheet(isPresented: $showQuickReplies) {
            QuickRepliesView { content in
                draft = content
                showQuickReplies = false
                DispatchQueue.main.async { composerFocused = true }
            }
        }
        .sheet(isPresented: $showDetails) {
            ConversationDetailsView(conversation: liveConversation)
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
        }
        .onAppear {
            if draft.isEmpty {
                draft = UserDefaults.standard.string(forKey: draftStorageKey) ?? ""
            }
        }
        .task {
            await loadMessages()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                guard !Task.isCancelled else { break }
                await loadMessages(showError: false)
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
        let localId = "local-\(UUID().uuidString)"
        let pending = ChatMessage(
            id: localId,
            conversationId: conversation.id,
            sender: "agent",
            type: "text",
            content: text,
            fileName: nil,
            fileSize: nil,
            createdAt: Int64(Date().timeIntervalSince1970 * 1000),
            recalled: 0
        )
        draft = ""
        messages.append(pending)
        isSending = true
        Task {
            defer { isSending = false }
            do {
                let message = try await client.sendMessage(
                    conversationId: conversation.id,
                    type: "text",
                    content: text
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

    private func handleRealtimeEvent(_ event: NativeEvent) {
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

    private func receiptText(for message: ChatMessage) -> String? {
        guard message.isAgent, message.id == messages.last(where: { $0.isAgent })?.id else { return nil }
        if message.isPending { return "发送中" }
        if (liveConversation.visitorReadAt ?? 0) >= message.createdAt { return "已读" }
        if (liveConversation.visitorDeliveredAt ?? 0) >= message.createdAt { return "已送达" }
        return "已发送"
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

private struct MessageBubble: View {
    let message: ChatMessage
    let client: APIClient?
    let receipt: String?
    let onImageTap: (URL) -> Void
    let onRecall: () -> Void

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
                        Button { onImageTap(url) } label: {
                            AsyncImage(url: url) { phase in
                                switch phase {
                                case let .success(image):
                                    image.resizable().scaledToFit()
                                case .failure:
                                    Label("图片加载失败", systemImage: "photo")
                                default:
                                    ProgressView().frame(height: 100)
                                }
                            }
                        }
                        .buttonStyle(.plain)
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
                    } else {
                        Text(message.content)
                            .textSelection(.enabled)
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
                        Text("· \(receipt)")
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            .contextMenu {
                if message.type == "text" && !message.isRecalled {
                    Button {
                        UIPasteboard.general.string = message.content
                    } label: {
                        Label("复制", systemImage: "doc.on.doc")
                    }
                }
                if message.isAgent && !message.isRecalled {
                    Button(role: .destructive, action: onRecall) {
                        Label("撤回消息", systemImage: "arrow.uturn.backward")
                    }
                }
            }
            .opacity(message.isPending ? 0.65 : 1)
            if !message.isAgent { Spacer(minLength: 48) }
        }
    }
}

private struct ImagePreviewView: View {
    @Environment(\.dismiss) private var dismiss
    let url: URL
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                AsyncImage(url: url) { phase in
                    switch phase {
                    case let .success(image):
                        image
                            .resizable()
                            .scaledToFit()
                            .scaleEffect(scale)
                            .gesture(
                                MagnificationGesture()
                                    .onChanged { value in
                                        scale = min(max(lastScale * value, 1), 5)
                                    }
                                    .onEnded { _ in lastScale = scale }
                            )
                            .onTapGesture(count: 2) {
                                withAnimation(.spring(response: 0.3)) {
                                    scale = scale > 1 ? 1 : 2
                                    lastScale = scale
                                }
                            }
                    case .failure:
                        Label("图片加载失败", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.white)
                    default:
                        ProgressView().tint(.white)
                    }
                }
            }
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

    init(conversation: Conversation) {
        self.conversation = conversation
        _notes = State(initialValue: conversation.notes ?? "")
        _tags = State(initialValue: conversation.tags ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("访客") {
                    LabeledContent("邮箱", value: conversation.visitorEmail ?? "未填写")
                    LabeledContent("称呼", value: conversation.visitorName ?? "访客")
                    if let url = conversation.lastUrl, !url.isEmpty {
                        LabeledContent("来源页面", value: url)
                    }
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

}
