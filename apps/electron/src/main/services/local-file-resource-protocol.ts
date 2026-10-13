import { protocol } from 'electron'
import { LocalFileResources } from './local-file-resource'
import { LAN_HUB_SCHEME_PRIVILEGES } from './lan-hub-protocol'

/**
 * Another kind of resource of the scheme, under a host of its own. It is added
 * by the module that owns it once the application loads: what the entry
 * reaches before that stays free of business imports.
 */
type ResourceHost = {
  respond(request: Request): Promise<Response>
  releaseOwner(owner: number): void
}
const resourceHosts = new Map<string, ResourceHost>()
export function addResourceHost(host: string, resources: ResourceHost) {
  resourceHosts.set(host, resources)
}

// A renderer's resources end together, whichever kind they are.
export const localFileResources = new (class extends LocalFileResources {
  override releaseOwner(owner: number) {
    super.releaseOwner(owner)
    for (const resources of resourceHosts.values()) resources.releaseOwner(owner)
  }
})()

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
  protocol.handle('lody-resource', (request) =>
    (resourceHosts.get(new URL(request.url).hostname) ?? localFileResources).respond(request)
  )
}
