import Foundation
import Security

enum Exit: Int32 {
    case usage = 2
    case notFound = 44
    case failed = 70
}

func finish(_ status: OSStatus) -> Never {
    if let text = SecCopyErrorMessageString(status, nil) as String? {
        FileHandle.standardError.write(Data("Keychain error: \(text)\n".utf8))
    } else {
        FileHandle.standardError.write(Data("Keychain error: \(status)\n".utf8))
    }
    exit(status == errSecItemNotFound ? Exit.notFound.rawValue : Exit.failed.rawValue)
}

let arguments = CommandLine.arguments
guard arguments.count == 4 else {
    FileHandle.standardError.write(Data("Usage: keychain-helper <get|set|delete> <service> <account>\n".utf8))
    exit(Exit.usage.rawValue)
}

let operation = arguments[1]
let service = arguments[2]
let account = arguments[3]
let identity: [CFString: Any] = [
    kSecClass: kSecClassGenericPassword,
    kSecAttrService: service,
    kSecAttrAccount: account,
]

switch operation {
case "get":
    var query = identity
    query[kSecReturnData] = true
    query[kSecMatchLimit] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess else { finish(status) }
    guard let data = result as? Data else { finish(errSecDecode) }
    FileHandle.standardOutput.write(data)

case "set":
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty else {
        FileHandle.standardError.write(Data("Refusing to store an empty secret.\n".utf8))
        exit(Exit.usage.rawValue)
    }
    let update = [kSecValueData: data] as CFDictionary
    let updateStatus = SecItemUpdate(identity as CFDictionary, update)
    if updateStatus == errSecItemNotFound {
        var item = identity
        item[kSecValueData] = data
        item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        guard addStatus == errSecSuccess else { finish(addStatus) }
    } else if updateStatus != errSecSuccess {
        finish(updateStatus)
    }

case "delete":
    let status = SecItemDelete(identity as CFDictionary)
    guard status == errSecSuccess else { finish(status) }

default:
    FileHandle.standardError.write(Data("Unknown operation.\n".utf8))
    exit(Exit.usage.rawValue)
}
