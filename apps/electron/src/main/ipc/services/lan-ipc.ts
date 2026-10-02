import { getIpcContext, IpcMethod, IpcService } from 'electron-ipc-decorator'
import {
  ElectronLanAddInputSchema,
  ElectronLanIdInputSchema,
  ElectronLanJoinInputSchema,
  ElectronLanMachineNameInputSchema,
  ElectronLanUpdateInputSchema,
  type ElectronLanFailure,
  type ElectronLanReachability,
  type ElectronLanResult,
  type ElectronLanState,
  type ElectronLanSummary
} from '@lody/shared/electron-ipc'
import { measureLanHubLatency, probeLanHub } from '@lody/shared/node/lan-hub'
import type { LanHubStore } from '@lody/shared/node/lan-hub-store'
import { assertProductWindowSender } from '../assert-sender'
import { getIpcServiceDeps } from '../ipc-service-deps'

const UNAVAILABLE: ElectronLanFailure = {
  ok: false,
  code: 'unavailable',
  message: 'LANs are not available in this application'
}

const INVALID_INPUT: ElectronLanFailure = {
  ok: false,
  code: 'invalid_input',
  message: 'The request is not valid'
}

/**
 * The LANs of this installation. A summary never carries a credential; only
 * `getInvite` hands one out, on an explicit request of a product window.
 */
export class LanIpc extends IpcService {
  static override readonly groupName = 'lan'

  @IpcMethod()
  async getState(): Promise<ElectronLanState | null> {
    return getIpcServiceDeps().lanHubStore?.getState() ?? null
  }

  @IpcMethod()
  async join(input: unknown): Promise<ElectronLanResult<{ lan: ElectronLanSummary }>> {
    return edit(ElectronLanJoinInputSchema.safeParse(input), (store, value) => store.join(value))
  }

  @IpcMethod()
  async add(input: unknown): Promise<ElectronLanResult<{ lan: ElectronLanSummary }>> {
    return edit(ElectronLanAddInputSchema.safeParse(input), (store, value) => store.add(value))
  }

  @IpcMethod()
  async update(input: unknown): Promise<ElectronLanResult<{ lan: ElectronLanSummary }>> {
    return edit(ElectronLanUpdateInputSchema.safeParse(input), (store, value) =>
      store.update(value)
    )
  }

  @IpcMethod()
  async remove(input: unknown): Promise<ElectronLanResult> {
    return edit(ElectronLanIdInputSchema.safeParse(input), (store, value) => store.remove(value))
  }

  @IpcMethod()
  async setMachineName(input: unknown): Promise<ElectronLanResult> {
    return edit(ElectronLanMachineNameInputSchema.safeParse(input), (store, value) =>
      store.setMachineName(value)
    )
  }

  @IpcMethod()
  async getInvite(input: unknown): Promise<{ ok: true; invite: string } | ElectronLanFailure> {
    assertProductWindowSender(getIpcContext().event)
    const store = getIpcServiceDeps().lanHubStore
    if (!store) return UNAVAILABLE
    const parsed = ElectronLanIdInputSchema.safeParse(input)
    return parsed.success ? store.getInvite(parsed.data) : INVALID_INPUT
  }

  @IpcMethod()
  async probe(input: unknown): Promise<ElectronLanReachability> {
    const parsed = ElectronLanIdInputSchema.safeParse(input)
    const hub = parsed.success ? getIpcServiceDeps().lanHubStore?.resolve(parsed.data.id) : null
    return hub ? await probeLanHub(hub) : 'unreachable'
  }

  /** The hub's round trip in milliseconds, or `null` when it does not answer. */
  @IpcMethod()
  async latency(input: unknown): Promise<number | null> {
    const parsed = ElectronLanIdInputSchema.safeParse(input)
    const hub = parsed.success ? getIpcServiceDeps().lanHubStore?.resolve(parsed.data.id) : null
    return hub ? await measureLanHubLatency(hub) : null
  }
}

function edit<Input, Output>(
  parsed: { success: true; data: Input } | { success: false },
  apply: (store: LanHubStore, input: Input) => Output
): Output | ElectronLanFailure {
  assertProductWindowSender(getIpcContext().event)
  const store = getIpcServiceDeps().lanHubStore
  if (!store) return UNAVAILABLE
  return parsed.success ? apply(store, parsed.data) : INVALID_INPUT
}
