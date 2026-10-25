import AVFoundation
import UIKit

@objc(CetaCameraCapture)
public final class CetaCameraCapture: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
  private var picker: UIImagePickerController?
  private var completion: ((String?, String?) -> Void)?
  private var generation = 0
  private var observer: NSObjectProtocol?
  private let maxBytes = 4 * 1024 * 1024

  @objc(captureWithCompletion:)
  public func capture(completion: @escaping (String?, String?) -> Void) {
    DispatchQueue.main.async {
      guard self.completion == nil else { completion(nil, "sync_conflict"); return }
      self.completion = completion
      self.generation += 1
      let generation = self.generation
      let launch: (Bool) -> Void = { granted in
        DispatchQueue.main.async {
          guard generation == self.generation, self.completion != nil else { return }
          guard granted else { self.finish(nil, "permission_denied"); return }
          guard UIImagePickerController.isSourceTypeAvailable(.camera),
            let scene = UIApplication.shared.connectedScenes.first(where: {
              $0.activationState == .foregroundActive
            }) as? UIWindowScene,
            var host = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController
          else { self.finish(nil, "unsupported"); return }
          while let next = host.presentedViewController { host = next }
          let camera = UIImagePickerController()
          camera.sourceType = .camera
          camera.cameraCaptureMode = .photo
          camera.mediaTypes = ["public.image"]
          camera.delegate = self
          camera.modalPresentationStyle = .fullScreen
          self.picker = camera
          self.observer = NotificationCenter.default.addObserver(
            forName: UIApplication.willResignActiveNotification,
            object: nil,
            queue: .main,
          ) { [weak self] _ in self?.cancel() }
          host.present(camera, animated: true)
          DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
            if generation == self.generation { self.finish(nil, "timeout") }
          }
        }
      }
      switch AVCaptureDevice.authorizationStatus(for: .video) {
      case .authorized: launch(true)
      case .notDetermined:
        AVCaptureDevice.requestAccess(for: .video, completionHandler: launch)
      default: launch(false)
      }
    }
  }

  @objc public func cancel() {
    DispatchQueue.main.async { self.finish(nil, "cancelled") }
  }

  public func imagePickerController(
    _ picker: UIImagePickerController,
    didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any],
  ) {
    guard let image = info[.originalImage] as? UIImage,
      let data = image.jpegData(compressionQuality: 0.85)
    else { finish(nil, "unsupported"); return }
    guard data.count > 0, data.count <= maxBytes else {
      finish(nil, "unsupported")
      return
    }
    do {
      let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      let url = directory.appendingPathComponent("ceta-camera-(UUID().uuidString).jpg")
      try data.write(to: url, options: .atomic)
      let object: [String: String] = [
        "uri": url.absoluteString,
        "mime": "image/jpeg",
        "name": url.lastPathComponent,
      ]
      let payload = try JSONSerialization.data(withJSONObject: object)
      guard let raw = String(data: payload, encoding: .utf8) else {
        try? FileManager.default.removeItem(at: url)
        finish(nil, "storage_error")
        return
      }
      finish(raw, nil)
    } catch {
      finish(nil, "storage_error")
    }
  }

  public func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
    finish(nil, "cancelled")
  }

  private func finish(_ raw: String?, _ code: String?) {
    guard let done = completion else { return }
    completion = nil
    generation += 1
    if let observer = observer { NotificationCenter.default.removeObserver(observer) }
    self.observer = nil
    let controller = picker
    picker = nil
    controller?.dismiss(animated: false)
    done(raw, code)
  }

  deinit {
    if let observer = observer { NotificationCenter.default.removeObserver(observer) }
  }
}
