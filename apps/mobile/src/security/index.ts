export type SecretReference = {
  readonly id: string;
};
export type {
  CapabilityGrant,
  CapabilityPolicy,
  CapabilityPolicyPrompt,
  CapabilityPolicyMode,
  CapabilityPromptDecision,
  InMemoryCapabilityPolicyOptions,
} from './CapabilityPolicy';
export {InMemoryCapabilityPolicy} from './CapabilityPolicy';
