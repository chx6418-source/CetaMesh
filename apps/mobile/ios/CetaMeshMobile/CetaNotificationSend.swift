import Foundation
import UserNotifications

@objc(CetaNotificationSend)
public final class CetaNotificationSend: NSObject {
  private struct Payload {
    let title: String
    let body: String?
  }

  private var completion: ((String?, String?) -> Void)?
  private var generation = 0
  private var pendingIdentifier: String?
  private let maxBytes = 4096
  private let maxTitleLength = 120
  private let maxBodyLength = 500

  @objc(send:completion:)
  public func send(_ raw: String, completion: @escaping (String?, String?) -> Void) {
    DispatchQueue.main.async {
      guard self.completion == nil else {
        completion(nil, "sync_conflict")
        return
      }
      guard let payload = self.parse(raw) else {
        completion(nil, "invalid_protocol")
        return
      }
      self.completion = completion
      self.generation += 1
      let generation = self.generation
      let center = UNUserNotificationCenter.current()
      center.getNotificationSettings { settings in
        DispatchQueue.main.async {
          guard generation == self.generation, self.completion != nil else { return }
          switch settings.authorizationStatus {
          case .authorized, .provisional, .ephemeral:
            self.schedule(payload, generation: generation)
          case .notDetermined:
            center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
              DispatchQueue.main.async {
                guard generation == self.generation, self.completion != nil else { return }
                if granted {
                  self.schedule(payload, generation: generation)
                } else {
                  self.finish("permission_denied")
                }
              }
            }
          default:
            self.finish("permission_denied")
          }
        }
      }
    }
  }

  @objc public func cancel() {
    DispatchQueue.main.async {
      guard self.completion != nil else { return }
      if let identifier = self.pendingIdentifier {
        UNUserNotificationCenter.current().removePendingNotificationRequests(
          withIdentifiers: [identifier],
        )
      }
      self.finish("cancelled")
    }
  }

  private func isSafeText(_ value: String, maxLength: Int, allowEmpty: Bool) -> Bool {
    guard value.count <= maxLength, allowEmpty || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return false
    }
    return value.unicodeScalars.allSatisfy { scalar in
      scalar.value >= 32 || scalar.value == 9 || scalar.value == 10 || scalar.value == 13
    }
  }

  private func parse(_ raw: String) -> Payload? {
    guard raw.utf8.count <= maxBytes,
      let data = raw.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      object.keys.allSatisfy({ $0 == "title" || $0 == "body" }),
      let title = object["title"] as? String,
      isSafeText(title, maxLength: maxTitleLength, allowEmpty: false)
    else { return nil }
    if let value = object["body"] {
      guard let body = value as? String,
        isSafeText(body, maxLength: maxBodyLength, allowEmpty: true)
      else { return nil }
      return Payload(title: title, body: body)
    }
    return Payload(title: title, body: nil)
  }

  private func schedule(_ payload: Payload, generation: Int) {
    guard generation == self.generation, completion != nil else { return }
    let content = UNMutableNotificationContent()
    content.title = payload.title
    if let body = payload.body, !body.isEmpty { content.body = body }
    content.sound = .default
    content.threadIdentifier = "cetamesh"
    let identifier = "cetamesh-notification-\(UUID().uuidString)"
    pendingIdentifier = identifier
    let request = UNNotificationRequest(
      identifier: identifier,
      content: content,
      trigger: UNTimeIntervalNotificationTrigger(timeInterval: 0.1, repeats: false),
    )
    UNUserNotificationCenter.current().add(request) { error in
      DispatchQueue.main.async {
        guard generation == self.generation, self.completion != nil else { return }
        if error == nil {
          self.finish(nil)
        } else {
          self.finish("provider_error")
        }
      }
    }
  }

  private func finish(_ code: String?) {
    guard let done = completion else { return }
    completion = nil
    generation += 1
    pendingIdentifier = nil
    done(nil, code)
  }
}
