import { protocol } from 'electron'
import { LAN_HUB_SCHEME } from '@lody/shared/platform-kind'
import { createLanHubRequestHandler, type LanHubTarget } from './lan-hub-forward'

export const LAN_HUB_SCHEME_PRIVILEGES = {
  scheme: LAN_HUB_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    corsEnabled: true
  }
} as const

/** Installed once; which LANs exist is asked again for every request. */
export function installLanHubProtocol(resolve: (lanId: string) => LanHubTarget | null): void {
  protocol.handle(LAN_HUB_SCHEME, createLanHubRequestHandler(resolve))
}
