import AVFoundation
import UIKit

@objc(CetaMicrophoneRecord)
public final class CetaMicrophoneRecord: NSObject, AVAudioRecorderDelegate {
  private var recorder: AVAudioRecorder?
  private var controller: CetaMicrophoneController?
  private var completion: ((String?, String?) -> Void)?
  private var observer: NSObjectProtocol?
  private var generation = 0
  private var outputURL: URL?
  private var finishing = false
  private let maxBytes = 8 * 1024 * 1024
  private let maxDuration: TimeInterval = 60

  @objc(recordWithCompletion:)
  public func record(completion: @escaping (String?, String?) -> Void) {
    DispatchQueue.main.async {
      guard self.completion == nil else { completion(nil, "sync_conflict"); return }
      self.completion = completion
      self.generation += 1
      let generation = self.generation
      let launch: (Bool) -> Void = { granted in
        DispatchQueue.main.async {
          guard generation == self.generation, self.completion != nil else { return }
          guard granted else { self.finish(nil, "permission_denied"); return }
          guard let scene = UIApplication.shared.connectedScenes.first(where: {
            $0.activationState == .foregroundActive
          }) as? UIWindowScene,
            var host = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController
          else { self.finish(nil, "unsupported"); return }
          while let next = host.presentedViewController { host = next }
          let recordingController = CetaMicrophoneController()
          recordingController.onStop = { [weak self] in self?.finishRecording() }
          recordingController.modalPresentationStyle = .formSheet
          self.controller = recordingController
          self.observer = NotificationCenter.default.addObserver(
            forName: UIApplication.willResignActiveNotification,
            object: nil,
            queue: .main,
          ) { [weak self] _ in self?.cancel() }
          host.present(recordingController, animated: true) {
            self.startRecorder(generation: generation)
          }
          DispatchQueue.main.asyncAfter(deadline: .now() + self.maxDuration) {
            if generation == self.generation { self.finishRecording() }
          }
        }
      }
      switch AVAudioSession.sharedInstance().recordPermission {
      case .granted: launch(true)
      case .undetermined:
        AVAudioSession.sharedInstance().requestRecordPermission(completionHandler: launch)
      default: launch(false)
      }
    }
  }

  private func startRecorder(generation: Int) {
    guard generation == self.generation, completion != nil else { return }
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.record, mode: .default, options: [])
      try session.setActive(true, options: [])
      let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      let url = directory.appendingPathComponent("ceta-recording-\(UUID().uuidString).m4a")
      let settings: [String: Any] = [
        AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
        AVSampleRateKey: 44_100,
        AVNumberOfChannelsKey: 1,
        AVEncoderBitRateKey: 128_000,
      ]
      let value = try AVAudioRecorder(url: url, settings: settings)
      value.delegate = self
      guard value.record(forDuration: maxDuration) else {
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        finish(nil, "unsupported")
        return
      }
      recorder = value
      outputURL = url
      finishing = false
    } catch {
      finish(nil, "unsupported")
    }
  }

  private func finishRecording() {
    guard !finishing else { return }
    finishing = true
    let value = recorder
    recorder = nil
    let duration = value?.currentTime ?? 0
    value?.delegate = nil
    value?.stop()
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    guard let url = outputURL,
      let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
      let size = attributes[.size] as? NSNumber,
      size.intValue > 0,
      size.intValue <= maxBytes,
      duration > 0,
      duration <= maxDuration
    else {
      finish(nil, "unsupported")
      return
    }
    do {
      let object: [String: Any] = [
        "uri": url.absoluteString,
        "mime": "audio/mp4",
        "name": url.lastPathComponent,
        "durationMs": Int((duration * 1000).rounded()),
      ]
      let payload = try JSONSerialization.data(withJSONObject: object)
      guard let raw = String(data: payload, encoding: .utf8) else {
        finish(nil, "storage_error")
        return
      }
      finish(raw, nil)
    } catch {
      finish(nil, "storage_error")
    }
  }

  @objc public func cancel() {
    DispatchQueue.main.async {
      guard self.completion != nil else { return }
      self.finishing = true
      self.recorder?.delegate = nil
      self.recorder?.stop()
      self.recorder = nil
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      self.finish(nil, "cancelled")
    }
  }

  private func finish(_ raw: String?, _ code: String?) {
    guard let done = completion else { return }
    completion = nil
    generation += 1
    if let observer = observer { NotificationCenter.default.removeObserver(observer) }
    observer = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    if code != nil, let url = outputURL { try? FileManager.default.removeItem(at: url) }
    outputURL = nil
    let presented = controller
    controller = nil
    presented?.dismiss(animated: false)
    done(raw, code)
  }

  public func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
    if !flag && !finishing { finish(nil, "provider_error") }
  }

  deinit {
    if let observer = observer { NotificationCenter.default.removeObserver(observer) }
  }
}

private final class CetaMicrophoneController: UIViewController {
  var onStop: (() -> Void)?

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    let stack = UIStackView()
    stack.axis = .vertical
    stack.alignment = .center
    stack.spacing = 24
    stack.translatesAutoresizingMaskIntoConstraints = false
    let label = UILabel()
    label.text = "正在录音，离开页面会立即停止"
    let button = UIButton(type: .system)
    button.setTitle("停止录音", for: .normal)
    button.addTarget(self, action: #selector(stop), for: .touchUpInside)
    stack.addArrangedSubview(label)
    stack.addArrangedSubview(button)
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
    ])
  }

  @objc private func stop() { onStop?() }
}
