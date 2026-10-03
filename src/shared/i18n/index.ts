import {enUS} from './en-US';
import {zhCN} from './zh-CN';
import {messages} from './messages';

export type Locale = 'zh-CN' | 'en-US';
export type TranslationKey = keyof typeof zhCN;
export const defaultLocale: Locale = 'zh-CN';
export function t(key: TranslationKey, locale: Locale = defaultLocale): string {
  return locale === 'en-US' ? enUS[key] : zhCN[key];
}

/** Source phrases are kept as keys until each screen has a dedicated key. */
export function tr(source: string, locale: Locale = defaultLocale): string {
  return locale === 'en-US' ? source : messages[source] ?? source;
}
