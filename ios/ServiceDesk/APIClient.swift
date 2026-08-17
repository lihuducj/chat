import Foundation

struct APIClient {
    let baseURL: URL
    let token: String?

    private let decoder = JSONDecoder()

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
        fileSize: Int64? = nil
    ) async throws -> ChatMessage {
        var payload: [String: Any] = ["type": type, "content": content]
        if let fileName { payload["fileName"] = fileName }
        if let fileSize { payload["fileSize"] = fileSize }
        let body = try JSONSerialization.data(withJSONObject: payload)
        return try await request(
            path: "/api/conversations/\(escaped(conversationId))/messages",
            method: "POST",
            body: body
        )
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

    func eventStream() -> AsyncThrowingStream<NativeEvent, Error> {
        AsyncThrowingStream { continuation in
            let streamTask = Task {
                do {
                    guard let url = makeURL(path: "/api/native/events") else {
                        throw AppClientError.invalidServer
                    }
                    var request = URLRequest(url: url, timeoutInterval: 90)
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    if let token, !token.isEmpty {
                        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                    }

                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
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

        let (data, response) = try await URLSession.shared.data(for: request)
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
}

private extension Data {
    mutating func appendUTF8(_ string: String) {
        if let data = string.data(using: .utf8) { append(data) }
    }
}
