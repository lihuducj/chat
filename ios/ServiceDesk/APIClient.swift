import Foundation

struct APIClient {
    let baseURL: URL
    let token: String?

    private let decoder = JSONDecoder()
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpMaximumConnectionsPerHost = 6
        configuration.httpShouldUsePipelining = true
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 90
        return URLSession(configuration: configuration)
    }()

    func probe() async throws {
        _ = try await rawRequest(path: "/api/native/health")
    }

    func checkSession() async throws {
        let _: APIStatus = try await request(path: "/api/me")
    }

    func login(username: String, password: String) async throws -> LoginResponse {
        let data = try JSONSerialization.data(withJSONObject: [
            "username": username,
            "password": password
        ])
        return try await request(path: "/api/login", method: "POST", body: data)
    }

    func logout() async throws {
        let _: APIStatus = try await request(path: "/api/logout", method: "POST")
    }

    func conversations(search: String = "") async throws -> [Conversation] {
        let query = search.isEmpty ? [] : [URLQueryItem(name: "q", value: search)]
        return try await request(path: "/api/conversations", queryItems: query)
    }

    func conversation(id: String) async throws -> Conversation {
        try await request(path: "/api/conversations/\(escaped(id))")
    }

    func messages(conversationId: String) async throws -> [ChatMessage] {
        try await request(path: "/api/conversations/\(escaped(conversationId))/messages")
    }

    func markRead(conversationId: String) async throws {
        let _: APIStatus = try await request(
            path: "/api/conversations/\(escaped(conversationId))/read",
            method: "POST"
        )
    }

    func sendMessage(
        conversationId: String,
        type: String,
        content: String,
        fileName: String? = nil,
        fileSize: Int64? = nil,
        clientMessageId: String? = nil
    ) async throws -> ChatMessage {
        let messageId = clientMessageId ?? "ios-\(UUID().uuidString)"
        var payload: [String: Any] = [
            "type": type,
            "content": content,
            "clientMessageId": messageId
        ]
        if let fileName { payload["fileName"] = fileName }
        if let fileSize { payload["fileSize"] = fileSize }
        let body = try JSONSerialization.data(withJSONObject: payload)
        var lastError: Error = AppClientError.invalidResponse
        for attempt in 0..<3 {
            do {
                return try await request(
                    path: "/api/conversations/\(escaped(conversationId))/messages",
                    method: "POST",
                    body: body,
                    timeout: 20
                )
            } catch {
                lastError = error
                guard shouldRetry(error), attempt < 2 else { break }
                try? await Task.sleep(nanoseconds: UInt64(350 + attempt * 650) * 1_000_000)
            }
        }

        // POST可能已经落库，只是成功回包在弱网中丢失。按幂等ID回查后再决定是否提示失败。
        if let recoveredMessages = try? await messages(conversationId: conversationId),
           let recovered = recoveredMessages.first(where: { $0.id == messageId }) {
            return recovered
        }
        throw lastError
    }

    func recall(conversationId: String, messageId: String) async throws {
        let _: APIStatus = try await request(
            path: "/api/conversations/\(escaped(conversationId))/messages/\(escaped(messageId))/recall",
            method: "POST"
        )
    }

    func updateConversation(id: String, notes: String? = nil, tags: String? = nil, status: String? = nil) async throws {
        var payload: [String: String] = [:]
        if let notes { payload["notes"] = notes }
        if let tags { payload["tags"] = tags }
        if let status { payload["status"] = status }
        let body = try JSONSerialization.data(withJSONObject: payload)
        let _: APIStatus = try await request(
            path: "/api/conversations/\(escaped(id))",
            method: "PATCH",
            body: body
        )
    }

    func sendTyping(conversationId: String) async throws {
        let _: APIStatus = try await request(
            path: "/api/conversations/\(escaped(conversationId))/typing",
            method: "POST"
        )
    }

    func reportNativePresence(active: Bool) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["active": active])
        let _: APIStatus = try await request(
            path: "/api/native/presence",
            method: "POST",
            body: body,
            timeout: 10
        )
    }

    func deleteConversation(id: String) async throws {
        let _: APIStatus = try await request(
            path: "/api/conversations/\(escaped(id))",
            method: "DELETE"
        )
    }

    func cannedReplies() async throws -> [CannedReply] {
        try await request(path: "/api/canned-replies")
    }

    func createCannedReply(title: String, content: String) async throws -> CannedReply {
        let body = try JSONSerialization.data(withJSONObject: ["title": title, "content": content])
        return try await request(path: "/api/canned-replies", method: "POST", body: body)
    }

    func updateCannedReply(id: String, title: String, content: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["title": title, "content": content])
        let _: APIStatus = try await request(
            path: "/api/canned-replies/\(escaped(id))",
            method: "PUT",
            body: body
        )
    }

    func deleteCannedReply(id: String) async throws {
        let _: APIStatus = try await request(path: "/api/canned-replies/\(escaped(id))", method: "DELETE")
    }

    func menuItems() async throws -> [WidgetMenuItem] {
        try await request(path: "/api/menu-items")
    }

    func createMenuItem(parentId: String?, title: String, content: String, sortOrder: Int) async throws -> WidgetMenuItem {
        var payload: [String: Any] = [
            "title": title,
            "content": content,
            "sortOrder": sortOrder
        ]
        if let parentId { payload["parentId"] = parentId }
        let body = try JSONSerialization.data(withJSONObject: payload)
        return try await request(path: "/api/menu-items", method: "POST", body: body)
    }

    func updateMenuItem(id: String, parentId: String?, title: String, content: String, sortOrder: Int) async throws {
        var payload: [String: Any] = [
            "title": title,
            "content": content,
            "sortOrder": sortOrder
        ]
        if let parentId { payload["parentId"] = parentId }
        else { payload["parentId"] = NSNull() }
        let body = try JSONSerialization.data(withJSONObject: payload)
        let _: APIStatus = try await request(
            path: "/api/menu-items/\(escaped(id))",
            method: "PUT",
            body: body
        )
    }

    func deleteMenuItem(id: String) async throws {
        let _: APIStatus = try await request(path: "/api/menu-items/\(escaped(id))", method: "DELETE")
    }

    func settings() async throws -> [String: String] {
        try await request(path: "/api/settings")
    }

    func saveSettings(_ values: [String: String]) async throws {
        let body = try JSONSerialization.data(withJSONObject: values)
        let _: APIStatus = try await request(path: "/api/settings", method: "POST", body: body)
    }

    func upload(data: Data, fileName: String, mimeType: String) async throws -> UploadResponse {
        let boundary = "Boundary-\(UUID().uuidString)"
        var body = Data()
        body.appendUTF8("--\(boundary)\r\n")
        body.appendUTF8("Content-Disposition: form-data; name=\"file\"; filename=\"\(safeFileName(fileName))\"\r\n")
        body.appendUTF8("Content-Type: \(mimeType)\r\n\r\n")
        body.append(data)
        body.appendUTF8("\r\n--\(boundary)--\r\n")

        return try await request(
            path: "/api/upload",
            method: "POST",
            body: body,
            contentType: "multipart/form-data; boundary=\(boundary)",
            timeout: 90
        )
    }

    func absoluteURL(for path: String) -> URL? {
        if let absolute = URL(string: path), absolute.scheme != nil { return absolute }
        return URL(string: path, relativeTo: baseURL)?.absoluteURL
    }

    func eventStream(after eventId: Int64? = nil) -> AsyncThrowingStream<NativeEvent, Error> {
        AsyncThrowingStream { continuation in
            let streamTask = Task {
                do {
                    let queryItems = eventId.map { [URLQueryItem(name: "since", value: String($0))] } ?? []
                    guard let url = makeURL(path: "/api/native/events", queryItems: queryItems) else {
                        throw AppClientError.invalidServer
                    }
                    var request = URLRequest(url: url, timeoutInterval: 90)
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    if let token, !token.isEmpty {
                        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                    }
                    if let eventId {
                        request.setValue(String(eventId), forHTTPHeaderField: "Last-Event-ID")
                    }

                    let (bytes, response) = try await Self.session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else {
                        throw AppClientError.invalidResponse
                    }
                    if http.statusCode == 401 { throw AppClientError.unauthorized }
                    guard (200..<300).contains(http.statusCode) else {
                        throw AppClientError.server(http.statusCode, "实时连接失败（\(http.statusCode)）")
                    }

                    for try await line in bytes.lines {
                        guard !Task.isCancelled else { break }
                        guard line.hasPrefix("data: "),
                              let data = String(line.dropFirst(6)).data(using: .utf8) else { continue }
                        if let event = try? decoder.decode(NativeEvent.self, from: data) {
                            continuation.yield(event)
                        }
                    }
                    if !Task.isCancelled {
                        throw URLError(.networkConnectionLost)
                    }
                    continuation.finish()
                } catch {
                    if Task.isCancelled { continuation.finish() }
                    else { continuation.finish(throwing: error) }
                }
            }
            continuation.onTermination = { _ in streamTask.cancel() }
        }
    }

    private func request<T: Decodable>(
        path: String,
        method: String = "GET",
        queryItems: [URLQueryItem] = [],
        body: Data? = nil,
        contentType: String = "application/json",
        timeout: TimeInterval = 30
    ) async throws -> T {
        let data = try await rawRequest(
            path: path,
            method: method,
            queryItems: queryItems,
            body: body,
            contentType: contentType,
            timeout: timeout
        )
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw AppClientError.invalidResponse
        }
    }

    private func rawRequest(
        path: String,
        method: String = "GET",
        queryItems: [URLQueryItem] = [],
        body: Data? = nil,
        contentType: String = "application/json",
        timeout: TimeInterval = 30
    ) async throws -> Data {
        guard let url = makeURL(path: path, queryItems: queryItems) else { throw AppClientError.invalidServer }

        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let (data, response) = try await Self.session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw AppClientError.invalidResponse }
        if http.statusCode == 401 { throw AppClientError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let message = payload?["error"] as? String ?? "请求失败（\(http.statusCode)）"
            throw AppClientError.server(http.statusCode, message)
        }
        return data
    }

    private func escaped(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }

    private func makeURL(path: String, queryItems: [URLQueryItem] = []) -> URL? {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return nil }
        components.path = path
        components.queryItems = queryItems.isEmpty ? nil : queryItems
        return components.url
    }

    private func safeFileName(_ value: String) -> String {
        value.replacingOccurrences(of: "\"", with: "_")
            .replacingOccurrences(of: "\r", with: "_")
            .replacingOccurrences(of: "\n", with: "_")
    }

    private func shouldRetry(_ error: Error) -> Bool {
        if let urlError = error as? URLError {
            return [
                .timedOut, .networkConnectionLost, .notConnectedToInternet,
                .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed
            ].contains(urlError.code)
        }
        if case let AppClientError.server(status, _) = error {
            return status >= 500
        }
        return false
    }
}

private extension Data {
    mutating func appendUTF8(_ string: String) {
        if let data = string.data(using: .utf8) { append(data) }
    }
}
