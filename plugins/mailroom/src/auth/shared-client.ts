import type { OAuthClientConfig } from '../types.js';

// Google Desktop OAuth clients are public application identifiers. User refresh
// tokens remain private and are stored only in macOS Keychain.
export const SHARED_OAUTH_CLIENT: OAuthClientConfig = {
  clientId: '69873104219-rgbgb86h1tj9idssud5ign96kfbror53.apps.googleusercontent.com',
  clientSecret: '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',
};
