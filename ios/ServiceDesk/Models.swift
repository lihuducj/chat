import Foundation

struct LoginResponse: Decodable {
    let ok: Bool
    let token: String
}

struct APIStatus: Decodable {
    let ok: Bool?
}

struct Conversation: Identifiable, Codable, Hashable {
    let id: String
    let visitorId: String
    let status: String
    let createdAt: Int64
    let lastMessageAt: Int64
    let unreadCount: Int
    let notes: String?
    let tags: String?
    let visitorDeliveredAt: Int64?
    let visitorReadAt: Int64?
    let visitorName: String?
    let visitorEmail: String?
    let lastUrl: String?
    let lastMessage: String?
    let lastType: String?

    enum CodingKeys: String, CodingKey {
        case id, status, notes, tags
        case visitorId = "visitor_id"
        case createdAt = "created_at"
        case lastMessageAt = "last_message_at"
        case unreadCount = "unread_count"
        case visitorDeliveredAt = "visitor_delivered_at"
        case visitorReadAt = "visitor_read_at"
        case visitorName = "visitor_name"
        case visitorEmail = "visitor_email"
        case lastUrl = "last_url"
        case lastMessage = "last_message"
        case lastType = "last_type"
    }

    var displayName: String {
        if let email = visitorEmail, !email.isEmpty { return email }
        if let name = visitorName, !name.isEmpty { return name }
        return "访客"
    }

    var preview: String {
        switch lastType {
        case "image": return "[图片]"
        case "file": return "[文件]"
        default: return lastMessage ?? ""
        }
    }
}

extension Conversation {
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        visitorId = try values.decodeIfPresent(String.self, forKey: .visitorId) ?? ""
        status = try values.decodeIfPresent(String.self, forKey: .status) ?? "open"
        createdAt = try values.decodeIfPresent(Int64.self, forKey: .createdAt) ?? 0
        lastMessageAt = try values.decodeIfPresent(Int64.self, forKey: .lastMessageAt) ?? createdAt
        unreadCount = try values.decodeIfPresent(Int.self, forKey: .unreadCount) ?? 0
        notes = try values.decodeIfPresent(String.self, forKey: .notes)
        tags = try values.decodeIfPresent(String.self, forKey: .tags)
        visitorDeliveredAt = try values.decodeIfPresent(Int64.self, forKey: .visitorDeliveredAt)
        visitorReadAt = try values.decodeIfPresent(Int64.self, forKey: .visitorReadAt)
        visitorName = try values.decodeIfPresent(String.self, forKey: .visitorName)
        visitorEmail = try values.decodeIfPresent(String.self, forKey: .visitorEmail)
        lastUrl = try values.decodeIfPresent(String.self, forKey: .lastUrl)
        lastMessage = try values.decodeIfPresent(String.self, forKey: .lastMessage)
        lastType = try values.decodeIfPresent(String.self, forKey: .lastType)
    }
}

struct ChatMessage: Identifiable, Codable, Hashable {
    let id: String
    let conversationId: String
    let sender: String
    let type: String
    let content: String
    let fileName: String?
    let fileSize: Int64?
    let createdAt: Int64
    let recalled: Int?

    enum CodingKeys: String, CodingKey {
        case id, sender, type, content, recalled
        case conversationId = "conversation_id"
        case fileName = "file_name"
        case fileSize = "file_size"
        case createdAt = "created_at"
    }

    var isRecalled: Bool { (recalled ?? 0) != 0 }
    var isAgent: Bool { sender == "agent" }
    var isPending: Bool { id.hasPrefix("local-") }
}

extension ChatMessage {
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        conversationId = try values.decodeIfPresent(String.self, forKey: .conversationId) ?? ""
        sender = try values.decodeIfPresent(String.self, forKey: .sender) ?? "visitor"
        type = try values.decodeIfPresent(String.self, forKey: .type) ?? "text"
        content = try values.decodeIfPresent(String.self, forKey: .content) ?? ""
        fileName = try values.decodeIfPresent(String.self, forKey: .fileName)
        fileSize = try values.decodeIfPresent(Int64.self, forKey: .fileSize)
        createdAt = try values.decodeIfPresent(Int64.self, forKey: .createdAt) ?? 0
        recalled = try values.decodeIfPresent(Int.self, forKey: .recalled)
    }
}

struct NativeEvent: Decodable, Hashable {
    let type: String
    let conversationId: String?
    let messageId: String?
    let message: ChatMessage?
}

struct UploadResponse: Decodable {
    let url: String
    let name: String
    let size: Int64
    let type: String
}

struct CannedReply: Identifiable, Decodable {
    let id: String
    let title: String
    let content: String
    let createdAt: Int64

    enum CodingKeys: String, CodingKey {
        case id, title, content
        case createdAt = "created_at"
    }
}

enum AppClientError: LocalizedError {
    case invalidServer
    case unauthorized
    case server(Int, String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .invalidServer:
            return "服务器地址无效"
        case .unauthorized:
            return "登录已失效，请重新登录"
        case let .server(_, message):
            return message
        case .invalidResponse:
            return "服务器返回了无法识别的数据"
        }
    }
}

enum DisplayFormatters {
    static let time: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    static let listDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "MM/dd HH:mm"
        return formatter
    }()

    static func date(milliseconds: Int64) -> Date {
        Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1000)
    }

    static func fileSize(_ bytes: Int64?) -> String {
        guard let bytes else { return "" }
        return ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}
