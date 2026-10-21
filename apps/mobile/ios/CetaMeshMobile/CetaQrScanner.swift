import AVFoundation
import UIKit

@objc(CetaQrScanner)
public final class CetaQrScanner: NSObject {
  private var controller: CetaQrController?
  private var completion: ((String?, String?) -> Void)?
  private var generation = 0
  @objc(scanWithCompletion:)
  public func scan(completion: @escaping (String?, String?) -> Void) {
    DispatchQueue.main.async {
      guard self.completion == nil else {completion(nil,"sync_conflict"); return}
      self.completion = completion
      self.generation += 1
      let generation = self.generation
      let launch: (Bool) -> Void = { granted in
        DispatchQueue.main.async {
          guard generation == self.generation, self.completion != nil else {return}
          guard granted else {self.finish(nil,"permission_denied");return}
          guard UIApplication.shared.applicationState == .active,
            let scene = UIApplication.shared.connectedScenes.first(where: {$0.activationState == .foregroundActive}) as? UIWindowScene,
            var host = scene.windows.first(where: {$0.isKeyWindow})?.rootViewController
          else {self.finish(nil,"unsupported");return}
          while let next = host.presentedViewController {host = next}
          let scanner = CetaQrController()
          scanner.done = {raw,code in self.finish(raw,code)}
          scanner.modalPresentationStyle = .fullScreen
          self.controller = scanner
          host.present(scanner, animated: true)
          DispatchQueue.main.asyncAfter(deadline: .now()+60) {
            if generation == self.generation {self.finish(nil,"cancelled")}
          }
        }
      }
      switch AVCaptureDevice.authorizationStatus(for: .video) {
      case .authorized: launch(true)
      case .notDetermined: AVCaptureDevice.requestAccess(for: .video, completionHandler: launch)
      default: launch(false)
      }
    }
  }
  @objc public func cancel() {DispatchQueue.main.async {self.finish(nil,"cancelled")}}
  private func finish(_ raw: String?, _ code: String?) {
    guard let done = completion else {return}
    completion = nil;generation += 1
    controller?.stop(); controller?.dismiss(animated: false);controller = nil
    if let raw = raw, raw.utf16.count > 8192 {done(nil,"invalid_protocol")}
    else {done(raw,code)}
  }
}

private final class CetaQrController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  var done: ((String?,String?) -> Void)?
  private let session = AVCaptureSession()
  private let queue = DispatchQueue(label:"com.cetameshmobile.qr.camera")
  private var preview: AVCaptureVideoPreviewLayer?
  private var observer: NSObjectProtocol?
  private var stopped = false
  private let lock = NSLock()
  override func viewDidLoad() {
    super.viewDidLoad();view.backgroundColor = .black
    let button = UIButton(type: .system);button.setTitle("取消扫描",for:.normal)
    button.addTarget(self,action:#selector(cancel),for:.touchUpInside)
    button.translatesAutoresizingMaskIntoConstraints=false;view.addSubview(button)
    NSLayoutConstraint.activate([button.bottomAnchor.constraint(equalTo:view.safeAreaLayoutGuide.bottomAnchor,constant:-20),button.centerXAnchor.constraint(equalTo:view.centerXAnchor)])
    observer = NotificationCenter.default.addObserver(forName:UIApplication.willResignActiveNotification,object:nil,queue:.main){[weak self] _ in self?.cancel()}
    queue.async {
      do {
        guard let device = AVCaptureDevice.default(for:.video) else {throw NSError(domain:"camera",code:1)}
        let input = try AVCaptureDeviceInput(device:device)
        let output = AVCaptureMetadataOutput()
        self.session.beginConfiguration()
        guard self.session.canAddInput(input),self.session.canAddOutput(output) else {self.session.commitConfiguration();throw NSError(domain:"camera",code:1)}
        self.session.addInput(input);self.session.addOutput(output)
        output.setMetadataObjectsDelegate(self,queue:.main)
        guard output.availableMetadataObjectTypes.contains(.qr) else {self.session.commitConfiguration();throw NSError(domain:"camera",code:1)}
        output.metadataObjectTypes=[.qr];self.session.commitConfiguration()
        self.lock.lock();let stopped=self.stopped;self.lock.unlock()
        if stopped {return}
        DispatchQueue.main.async {
          self.lock.lock();let stopped=self.stopped;self.lock.unlock()
          if stopped {return}
          let layer=AVCaptureVideoPreviewLayer(session:self.session);layer.videoGravity = .resizeAspectFill
          layer.frame=self.view.bounds;self.view.layer.insertSublayer(layer,at:0);self.preview=layer
        }
        self.session.startRunning()
      } catch {DispatchQueue.main.async {self.done?(nil,"unsupported")}}
    }
  }
  override func viewDidLayoutSubviews(){super.viewDidLayoutSubviews();preview?.frame=view.bounds}
  func metadataOutput(_ output:AVCaptureMetadataOutput,didOutput objects:[AVMetadataObject],from connection:AVCaptureConnection){
    guard let code=objects.first as? AVMetadataMachineReadableCodeObject,code.type == .qr,let raw=code.stringValue else{return}
    done?(raw,nil)
  }
  @objc private func cancel(){done?(nil,"cancelled")}
  func stop(){
    lock.lock();stopped=true;lock.unlock();done=nil
    if let observer=observer{NotificationCenter.default.removeObserver(observer);self.observer=nil}
    queue.async {if self.session.isRunning {self.session.stopRunning()}}
  }
  deinit {if let observer=observer {NotificationCenter.default.removeObserver(observer)}}
}
