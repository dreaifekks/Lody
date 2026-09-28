import { protocol } from 'electron'
import { LocalFileResources } from './local-file-resource'
import { LAN_HUB_SCHEME_PRIVILEGES } from './lan-hub-protocol'

export const localFileResources = new LocalFileResources()

export function registerLocalFileResourceScheme() {
  // Electron accepts a single registration call, so every custom scheme of the
  // shell is declared here.
  protocol.registerSchemesAsPrivileged([
    LAN_HUB_SCHEME_PRIVILEGES,
    {
      scheme: 'lody-resource',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true
      }
    }
  ])
}

export function installLocalFileResourceProtocol() {
  protocol.handle('lody-resource', (request) => localFileResources.respond(request))
}
