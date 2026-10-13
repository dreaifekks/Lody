import { getLocalFileSocketPath } from '@lody/shared/node/local-terminal'
import { mainPlatformKind } from '../platform'
import { addResourceHost } from './local-file-resource-protocol'
import {
  MemberFileResources,
  openAgentFileRange,
  type AgentFileRangeOpener
} from './member-file-resource'

/** Asks the agent service of this machine for part of a file. */
export const openMemberFileRange: AgentFileRangeOpener = (target, range, signal) =>
  openAgentFileRange(getLocalFileSocketPath(mainPlatformKind), target, range, signal)

/** Files the agent service reads for the desktop, under `lody-resource://member/`. */
export const memberFileResources = new MemberFileResources(openMemberFileRange)
addResourceHost('member', memberFileResources)
