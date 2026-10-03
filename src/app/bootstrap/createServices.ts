import {DeviceCryptoProvider} from '../../native/identity/DeviceCryptoProvider';
import {PairingHttpsProvider} from '../../providers/desktop/PairingHttpsProvider';
import {QrScannerProvider} from '../../native/camera/QrScannerProvider';
import {QrScanPolicy} from '../../security/QrScanPolicy';
import {QrScannerRuntime} from '../../runtime/capability/QrScannerRuntime';
import { openCetaDatabase } from '../../data/database/NitroSqliteConnection';
import { KeychainStorage } from '../../native/secure-storage/KeychainStorage';
import { XhrTransport } from '../../providers/network/XhrTransport';
import { assembleServices } from './assembleServices';
import { Alert, Platform } from 'react-native';
import {AttachmentCapabilityProvider} from '../../native/files/AttachmentCapabilityProvider';
import {CapabilityRouterRuntime} from '../../runtime/capability/CapabilityRouterRuntime';
import {InMemoryCapabilityPolicy} from '../../security/CapabilityPolicy';
import {CameraCaptureProvider} from '../../native/camera/CameraCaptureProvider';
import {MicrophoneRecordProvider} from '../../native/microphone/MicrophoneRecordProvider';
import {NotificationSendProvider} from '../../native/notification/NotificationSendProvider';
import {InMemoryCapabilityAuditLog} from '../../domain/capability/CapabilityAudit';
import {ExtensionPackagePickerProvider} from '../../native/files/ExtensionPackagePickerProvider';
import {NativeExtensionPackagePickerDriver} from '../../native/files/NativeExtensionPackagePickerDriver';
import {installedAppVersion} from '../../providers/appinfo/AppInfo';
import {GitHubReleaseUpdateService} from '../../providers/update/GitHubReleaseUpdateService';
export async function createServices() {
  const cameraProvider = new CameraCaptureProvider();
  const microphoneProvider = new MicrophoneRecordProvider();
  const attachmentProvider = new AttachmentCapabilityProvider();
  const notificationProvider = new NotificationSendProvider();
  const capabilityAudit = new InMemoryCapabilityAuditLog();
  const networkTransport = new XhrTransport();
  const capabilityRuntime = new CapabilityRouterRuntime(
    [cameraProvider, microphoneProvider, attachmentProvider, notificationProvider],
    new InMemoryCapabilityPolicy(
      request =>
        new Promise(resolve => {
          let settled = false;
          const finish = (value: 'deny' | 'allow-once') => {
            if (!settled) {
              settled = true;
              resolve(value);
            }
          };
          const isMicrophone = request.name === 'microphone.record';
          const isPhotoSelection = request.name === 'photos.select';
          const isNotification = request.name === 'notification.send';
          Alert.alert(
            isNotification
              ? '允许发送一条通知？'
              : isMicrophone
              ? '允许录音一次？'
              : isPhotoSelection
              ? '允许选择图片一次？'
              : request.name === 'file.pick'
              ? '允许选择文件一次？'
              : '允许拍摄一次？',
            isNotification
              ? '通知只包含当前请求提供的标题和正文。'
              : isMicrophone
              ? '录音只在当前前台页面进行，离开页面会立即停止。'
              : isPhotoSelection
              ? '图片只会在你明确发送后交给模型服务。'
              : request.name === 'file.pick'
              ? '文件内容只会在你明确发送后交给模型服务。'
              : '相机照片只会在你明确发送后交给模型服务。',
            [
              {text: '拒绝', style: 'cancel', onPress: () => finish('deny')},
              {text: '允许一次', onPress: () => finish('allow-once')},
            ],
            {cancelable: true, onDismiss: () => finish('deny')},
          );
        }),
      {
        modes: {
          'camera.capture': 'ask',
          'microphone.record': 'ask',
          'file.pick': 'ask',
          'photos.select': 'ask',
          'notification.send': 'ask',
        },
      },
    ),
    Platform.OS === 'ios' ? 'ios' : 'android',
    capabilityAudit,
  );
  const services = await assembleServices(
    openCetaDatabase(),
    new KeychainStorage(),
    networkTransport,
    {crypto:new DeviceCryptoProvider(),transport:new PairingHttpsProvider()},
    capabilityRuntime,
    capabilityAudit,
    new ExtensionPackagePickerProvider(new NativeExtensionPackagePickerDriver()),
  );
  services.appVersion = installedAppVersion();
  services.updates = new GitHubReleaseUpdateService(networkTransport, services.appVersion ?? '0.0.0');
  services.qrScanner=new QrScannerRuntime(new QrScanPolicy(()=>new Promise(resolve=>{
    Alert.alert('允许扫描二维码一次？','相机仅用于本次配对扫描。扫描结果会先显示目标地址，确认后才发送配对请求。',[
      {text:'拒绝',style:'cancel',onPress:()=>resolve(false)},
      {text:'允许一次',onPress:()=>resolve(true)},
    ],{cancelable:true,onDismiss:()=>resolve(false)});
  })),new QrScannerProvider());
  const close=services.close;
  services.close=async()=>{services.qrScanner?.cancel();cameraProvider.cancel();microphoneProvider.cancel();notificationProvider.cancel();await close();};
  return services;
}
