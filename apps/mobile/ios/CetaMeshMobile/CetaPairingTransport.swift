import Foundation
import CryptoKit

@objc(CetaPairingTransport)
public final class CetaPairingTransport: NSObject {
  private var calls: [String:CetaPairingCall] = [:]
  @objc(post:body:requestId:tlsPin:completion:)
  public func post(_ url:String, body:String, requestId:String, tlsPin:String?, completion:@escaping (String?,String?)->Void) {
    DispatchQueue.main.async {
      guard let endpoint=URL(string:url),let parts=URLComponents(url:endpoint,resolvingAgainstBaseURL:false),
        parts.scheme == "https",let host=parts.host,self.allowedHost(host),parts.user == nil,parts.password == nil,
        parts.port == nil || ((1...65535).contains(parts.port!) && parts.port != 443),
        url == "https://"+host+(parts.port.map {":"+String($0)} ?? "")+parts.path,
        parts.query == nil,parts.fragment == nil,
        ["/cetamesh/v1/pairing/exchange","/cetamesh/v1/pairing/confirm"].contains(parts.path),
        url.utf16.count <= 1024,body.utf8.count <= 16384,
        tlsPin == nil || tlsPin!.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil,
        requestId.range(of:"^pairing-request-[0-9]+$",options:.regularExpression) != nil,
        self.calls[requestId] == nil
      else {completion(nil,"invalid_protocol");return}
      let call=CetaPairingCall()
      call.completion = {raw,code in self.calls.removeValue(forKey:requestId);completion(raw,code)}
      self.calls[requestId]=call;call.start(endpoint,body:Data(body.utf8),pin:tlsPin)
    }
  }
  @objc(cancel:)
  public func cancel(_ requestId:String) {DispatchQueue.main.async {self.calls[requestId]?.finish(nil,"cancelled")}}
  private func allowedHost(_ host:String)->Bool {
    let labels=host.components(separatedBy:".")
    guard host.utf8.count<=253,host != "localhost",!host.hasSuffix(".localhost"),
      labels.allSatisfy({$0.range(of:"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$",options:.regularExpression) != nil}) else{return false}
    if host.range(of:"^[0-9.]+$",options:.regularExpression) != nil ||
      labels.last!.range(of:"^(?:[0-9]+|0x[0-9a-f]+)$",options:.regularExpression) != nil {
      return labels.count==4 && labels.allSatisfy({$0.range(of:"^(0|[1-9][0-9]{0,2})$",options:.regularExpression) != nil && (Int($0) ?? 256)<=255}) && labels[0] != "127" && labels[0] != "0"
    }
    return true
  }
}
private final class CetaPairingCall:NSObject,URLSessionDataDelegate {
  var completion:((String?,String?)->Void)?
  private var session:URLSession?
  private var bytes=Data()
  private var pin:String?
  func start(_ url:URL,body:Data,pin:String?) {
    self.pin=pin
    let config=URLSessionConfiguration.ephemeral
    config.httpShouldSetCookies=false;config.httpCookieStorage=nil;config.urlCredentialStorage=nil
    config.urlCache=nil;config.requestCachePolicy = .reloadIgnoringLocalCacheData
    config.timeoutIntervalForRequest=15;config.timeoutIntervalForResource=15
    session=URLSession(configuration:config,delegate:self,delegateQueue:.main)
    var request=URLRequest(url:url);request.httpMethod="POST";request.httpBody=body
    request.setValue("application/json",forHTTPHeaderField:"Content-Type")
    request.setValue("application/json",forHTTPHeaderField:"Accept")
    session?.dataTask(with:request).resume()
  }
  func finish(_ raw:String?,_ code:String?) {
    guard let done=completion else{return};completion=nil
    session?.invalidateAndCancel();session=nil;bytes.removeAll(keepingCapacity:false);pin=nil;done(raw,code)
  }
  // v1.1 pinning: only a request carrying the invitation's tlsPin leaves default
  // handling, and only an exact SHA-256(DER) leaf match is accepted. No pin means
  // unchanged system TLS validation; nothing is ever installed app-wide.
  func urlSession(_ session:URLSession,didReceive challenge:URLAuthenticationChallenge,completionHandler:@escaping (URLSession.AuthChallengeDisposition,URLCredential?)->Void) {
    guard let pin=pin,challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      let trust=challenge.protectionSpace.serverTrust,
      let chain=SecTrustCopyCertificateChain(trust) as? [SecCertificate],let leaf=chain.first
    else {completionHandler(.performDefaultHandling,nil);return}
    let digest=Data(SHA256.hash(data:SecCertificateCopyData(leaf) as Data))
    let actual=digest.map {String(format:"%02x",$0)}.joined()
    completionHandler(actual == pin ? .useCredential : .cancelAuthenticationChallenge,actual == pin ? URLCredential(trust:trust) : nil)
  }
  func urlSession(_ session:URLSession,task:URLSessionTask,willPerformHTTPRedirection response:HTTPURLResponse,newRequest request:URLRequest,completionHandler:@escaping (URLRequest?)->Void) {
    completionHandler(nil);finish(nil,"invalid_protocol")
  }
  func urlSession(_ session:URLSession,dataTask:URLSessionDataTask,didReceive response:URLResponse,completionHandler:@escaping (URLSession.ResponseDisposition)->Void) {
    guard let response=response as? HTTPURLResponse,response.statusCode == 200,response.expectedContentLength <= 32768 else {
      completionHandler(.cancel);let status=(response as? HTTPURLResponse)?.statusCode
      finish(nil,status == 401 || status == 403 ? "unauthorized":"invalid_protocol");return
    }
    completionHandler(.allow)
  }
  func urlSession(_ session:URLSession,dataTask:URLSessionDataTask,didReceive data:Data) {
    guard bytes.count+data.count<=32768 else{finish(nil,"invalid_protocol");return};bytes.append(data)
  }
  func urlSession(_ session:URLSession,task:URLSessionTask,didCompleteWithError error:Error?) {
    guard completion != nil else{return}
    if let error=error as NSError? {finish(nil,error.code == NSURLErrorTimedOut ? "timeout":"network_unavailable");return}
    guard let raw=String(data:bytes,encoding:.utf8) else {finish(nil,"invalid_protocol");return}
    finish(raw,nil)
  }
}
