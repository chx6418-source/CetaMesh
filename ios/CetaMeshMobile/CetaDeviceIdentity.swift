import CryptoKit
import Foundation
import Security

/// Private key references never leave this class. Only public metadata is stored in preferences.
@objc(CetaDeviceIdentity)
public final class CetaDeviceIdentity: NSObject {
  private static let queue = DispatchQueue(label: "com.cetameshmobile.identity")
  private static let tag = Data("com.cetameshmobile.identity.p256.v1".utf8)
  private static let recordKey = "com.cetameshmobile.identity.public.v1"
  private static var persistenceFailed = false
  private let defaults = UserDefaults.standard
  private enum Failure: String, Error {
    case unsupported, storage_error, invalid_protocol
  }

  // Explicit selectors keep the ObjC++ adapter independent of Swift selector inference.
  @objc(getIdentityWithCompletion:)
  public func getIdentity(completion: @escaping (String?, String?) -> Void) {
    perform(completion) { try self.identity().1 }
  }

  @objc(sign:completion:)
  public func sign(_ data: String, completion: @escaping (String?, String?) -> Void) {
    perform(completion) {
      let bytes = try self.boundedData(data)
      let key = try self.identity().0
      var error: Unmanaged<CFError>?
      guard let signature = SecKeyCreateSignature(
        key, .ecdsaSignatureMessageX962SHA256, bytes as CFData, &error
      ) else { throw Failure.storage_error }
      return (signature as Data).base64EncodedString()
    }
  }

  @objc(verify:data:signature:completion:)
  public func verify(
    _ publicKey: String, data: String, signature: String,
    completion: @escaping (Bool, String?) -> Void
  ) {
    Self.queue.async {
      do {
        let bytes = try self.boundedData(data)
        let rawKey = try self.decode(publicKey, max: 88)
        guard rawKey.count == 65, rawKey.first == 4 else { throw Failure.invalid_protocol }
        let der = try self.decode(signature, max: 96)
        guard (8...72).contains(der.count) else { throw Failure.invalid_protocol }
        guard let key = try? P256.Signing.PublicKey(x963Representation: rawKey) else {
          throw Failure.invalid_protocol
        }
        // Well-bounded but invalid DER/signatures resolve false, as on Android.
        guard let sig = try? P256.Signing.ECDSASignature(derRepresentation: der) else {
          completion(false, nil)
          return
        }
        completion(key.isValidSignature(sig, for: bytes), nil)
      } catch let failure as Failure {
        completion(false, failure.rawValue)
      } catch {
        completion(false, Failure.storage_error.rawValue)
      }
    }
  }

  @objc(fingerprint:completion:)
  public func fingerprint(_ token: String, completion: @escaping (String?,String?) -> Void) {
    perform(completion) {
      guard try self.decode(token, max:44).count == 32 else {throw Failure.invalid_protocol}
      return SHA256.hash(data: Data(token.utf8)).map {String(format:"%02x",$0)}.joined()
    }
  }

  @objc(randomNonceWithCompletion:)
  public func randomNonce(completion: @escaping (String?, String?) -> Void) {
    perform(completion) { try self.randomBytes(count: 32).base64EncodedString() }
  }

  private func perform(
    _ completion: @escaping (String?, String?) -> Void,
    operation: @escaping () throws -> String
  ) {
    Self.queue.async {
      do { completion(try operation(), nil) }
      catch let failure as Failure { completion(nil, failure.rawValue) }
      catch { completion(nil, Failure.storage_error.rawValue) }
    }
  }

  private func boundedData(_ value: String) throws -> Data {
    guard value.utf8.count <= 16384 else { throw Failure.invalid_protocol }
    return Data(value.utf8)
  }

  private func decode(_ value: String, max: Int) throws -> Data {
    guard value.utf8.count <= max, !value.isEmpty,
      let bytes = Data(base64Encoded: value), bytes.base64EncodedString() == value
    else { throw Failure.invalid_protocol }
    return bytes
  }

  private func randomBytes(count: Int) throws -> Data {
    var bytes = Data(count: count)
    let status = bytes.withUnsafeMutableBytes {
      SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!)
    }
    guard status == errSecSuccess else { throw Failure.storage_error }
    return bytes
  }

  private func randomUUID() throws -> String {
    var bytes = [UInt8](try randomBytes(count: 16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    return UUID(uuid: (
      bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
      bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )).uuidString.lowercased()
  }

  private func formatter() -> ISO8601DateFormatter {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter
  }

  private func storedKey() throws -> SecKey? {
    // Query by tag/type first; never mistake a key with unexpected attributes for no key.
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: Self.tag,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
      kSecReturnRef as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let result = result,
      CFGetTypeID(result) == SecKeyGetTypeID()
    else { throw Failure.storage_error }
    // CF type ID is checked above; Security returns a SecKey for this query.
    return (result as! SecKey)
  }

  private func requireEnclave(_ key: SecKey) throws {
    guard let attributes = SecKeyCopyAttributes(key) as? [String: Any],
      attributes[kSecAttrTokenID as String] as? String == kSecAttrTokenIDSecureEnclave as String,
      attributes[kSecAttrKeySizeInBits as String] as? Int == 256,
      SecKeyIsAlgorithmSupported(key, .sign, .ecdsaSignatureMessageX962SHA256)
    else { throw Failure.unsupported }
  }

  private func publicRepresentation(_ key: SecKey) throws -> String {
    guard let publicKey = SecKeyCopyPublicKey(key) else { throw Failure.storage_error }
    var error: Unmanaged<CFError>?
    // External representation is requested ONLY for the public key.
    guard let representation = SecKeyCopyExternalRepresentation(publicKey, &error) else {
      throw Failure.storage_error
    }
    let bytes = representation as Data
    guard bytes.count == 65, bytes.first == 4 else { throw Failure.storage_error }
    return bytes.base64EncodedString()
  }

  private func identity() throws -> (SecKey, String) {
    guard !Self.persistenceFailed else { throw Failure.storage_error }
    guard SecureEnclave.isAvailable else { throw Failure.unsupported }
    let key = try storedKey()
    let record = defaults.object(forKey: Self.recordKey)
    if key == nil && record == nil {
      var error: Unmanaged<CFError>?
      guard let access = SecAccessControlCreateWithFlags(
        nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .privateKeyUsage, &error
      ) else { throw Failure.storage_error }
      let attributes: [String: Any] = [
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits as String: 256,
        kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
        kSecPrivateKeyAttrs as String: [
          kSecAttrIsPermanent as String: true,
          kSecAttrApplicationTag as String: Self.tag,
          kSecAttrAccessControl as String: access,
        ],
      ]
      guard let created = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
        throw Failure.storage_error
      }
      try requireEnclave(created)
      let metadata: [String: String] = [
        "deviceId": try randomUUID(),
        "deviceName": "iOS device",
        "platform": "ios",
        "publicKey": try publicRepresentation(created),
        "createdAt": formatter().string(from: Date()),
      ]
      let encoded = try JSONSerialization.data(withJSONObject: metadata, options: [.sortedKeys])
      guard let json = String(data: encoded, encoding: .utf8) else { throw Failure.storage_error }
      // Persist only AFTER permanent key creation. Interrupted writes leave an orphan, never rotate.
      Self.persistenceFailed = true
      defaults.set(json, forKey: Self.recordKey)
      guard defaults.synchronize() else { throw Failure.storage_error }
      Self.persistenceFailed = false
      return (created, json)
    }
    guard let key = key, let json = record as? String else { throw Failure.storage_error }
    try requireEnclave(key)
    try validateRecord(json, publicKey: publicRepresentation(key))
    return (key, json)
  }

  private func validateRecord(_ json: String, publicKey: String) throws {
    guard json.utf8.count <= 2048,
      let fields = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: String],
      Set(fields.keys) == Set(["deviceId", "deviceName", "platform", "publicKey", "createdAt"]),
      let id = fields["deviceId"],
      id.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        options: .regularExpression) != nil,
      let name = fields["deviceName"], !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      name.utf16.count <= 100,
      !name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
      let timestamp = fields["createdAt"], timestamp.utf8.count == 24,
      let date = formatter().date(from: timestamp), formatter().string(from: date) == timestamp,
      fields["platform"] == "ios", fields["publicKey"] == publicKey
    else { throw Failure.storage_error }
  }
}
