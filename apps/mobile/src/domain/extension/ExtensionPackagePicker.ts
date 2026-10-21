export const EXTENSION_PACKAGE_MAX_BYTES = 1_048_576;

export type ExtensionPackageDocument = {
  readonly name: string;
  readonly text: string;
};

export interface ExtensionPackagePicker {
  pick(): Promise<ExtensionPackageDocument>;
}
