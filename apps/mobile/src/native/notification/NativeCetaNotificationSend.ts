import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

export interface Spec extends TurboModule {
  send(payload: string): Promise<void>;
  cancel(): void;
}

export default TurboModuleRegistry.get<Spec>('CetaNotificationSend');
