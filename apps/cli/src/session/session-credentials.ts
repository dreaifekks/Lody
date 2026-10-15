import { Cause, Effect, Exit, Scope } from 'effect';
import {
  GitCredentialBroker,
  type GitCredentialBrokerSessionContext,
  type GitCredentialLease,
} from '@/lib/git-credential-broker';

/** Runtime capability, deliberately excluded from serializable/mutable SessionConfig. */
export type SessionCredentials =
  | { readonly mode: 'native'; release(): Promise<void> }
  | {
      readonly mode: 'lan';
      readonly env: Readonly<Record<string, string>>;
      readonly active: boolean;
      release(): Promise<void>;
    }
  | { readonly mode: 'managed'; readonly lease: GitCredentialLease; release(): Promise<void> };

export const nativeSessionCredentials: SessionCredentials = {
  mode: 'native',
  release: async () => {},
};

/**
 * Temporary Promise boundary for Session/SessionManager. The broker acquisition
 * is Effect-native; the same scope follows preparation into the adopted Session.
 * No scope or authority is copied through launch-config merges.
 * @deprecated Effect owners should acquire broker.acquireContext in their scope.
 */
export function acquireSessionCredentialsLegacy(
  broker: GitCredentialBroker,
  context: GitCredentialBrokerSessionContext
): SessionCredentials {
  const scope = Scope.makeUnsafe();
  const acquired = Effect.runSyncExit(Scope.provide(broker.acquireContext(context), scope));
  if (Exit.isFailure(acquired)) {
    Effect.runSync(Scope.close(scope, acquired));
    throw Cause.squash(acquired.cause);
  }
  let closing: Promise<void> | undefined;
  return {
    mode: 'managed',
    lease: acquired.value,
    release: () =>
      (closing ??= Effect.runPromiseExit(Scope.close(scope, Exit.void)).then((exit) => {
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
      })),
  };
}

/** A LAN token belongs to the prepared runtime and follows its adoption/release. */
export function createLanSessionCredentials(env: Record<string, string>): SessionCredentials {
  let active = true;
  return {
    mode: 'lan',
    env: Object.freeze(
      Object.fromEntries(
        Object.entries(env).filter(
          ([key]) =>
            key === 'GH_TOKEN' ||
            key === 'LODY_MANAGED_GH_TOKEN_SHA256' ||
            /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)
        )
      )
    ),
    get active() {
      return active;
    },
    release: async () => {
      active = false;
    },
  };
}
