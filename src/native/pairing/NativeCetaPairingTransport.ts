import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';
export interface Spec extends TurboModule {post(url:string,body:string,requestId:string):Promise<string>;cancel(requestId:string):void;}
export default TurboModuleRegistry.get<Spec>('CetaPairingTransport');
