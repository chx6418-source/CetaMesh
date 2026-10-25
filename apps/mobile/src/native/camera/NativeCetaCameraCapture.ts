import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

export interface Spec extends TurboModule {
  capture(): Promise<string>;
  cancel(): void;
}

export default TurboModuleRegistry.get<Spec>('CetaCameraCapture');
