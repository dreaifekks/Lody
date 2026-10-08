import { MemoryProviderRequestSchema, MemoryProviderResponseSchema } from './memory-provider';
import {
  IosSimulatorCommandSchema,
  IosSimulatorRequestSchema,
  IosSimulatorResponseSchema,
} from './ios-simulator';
import { isWorkspaceMcpServerMeta, type WorkspaceMcpServerMeta } from './workspace-mcp';
import { LocalFileResolutionSchema } from './local-file-preview';
import { MachinePiExtensionsResponseSchema } from './pi-extensions';
import { MachineVoiceRequestSchema, MachineVoiceResponseSchema } from './machine-voice';
import { z } from 'zod';
import { SESSION_GOAL_ACTIONS } from './goal';
import {
  CodeCollabV2ErrorSchema,
  CodeCollabV2FileIndexRequestSchema,
  CodeCollabV2FileIndexSnapshotSchema,
  CodeCollabV2InitDirectoryOkSchema,
  CodeCollabV2InitDirectoryRequestSchema,
  CodeCollabV2LspUnsupportedSchema,
  CodeCollabV2OpenAllChangesDiffRequestSchema,
  CodeCollabV2OpenAllChangesDiffResponseSchema,
  CodeCollabV2OpenCurrentDiffRequestSchema,
  CodeCollabV2OpenCurrentDiffResponseSchema,
  CodeCollabV2OpenTextOkSchema,
  CodeCollabV2OpenTextRequestSchema,
  CodeCollabV2OpenTurnDiffRequestSchema,
  CodeCollabV2OpenTurnDiffResponseSchema,
  CodeCollabV2RefreshTextRequestSchema,
  CodeCollabV2RefreshTextResponseSchema,
  CodeCollabV2SaveTextRequestSchema,
  CodeCollabV2SaveTextResponseSchema,
} from './code-collab';
import { FilePreviewV3RequestSchema, FilePreviewV3ResponseSchema } from './file-preview';
import {
  SessionCancelResponseSchema,
  SessionDispatchTurnResponseSchema,
  SessionEditAndResendResponseSchema,
  SessionEditAndResendSpecSchema,
  SessionForkResponseSchema,
  SessionForkSpecSchema,
  SessionIdSchema,
  AgentConfigIdSchema,
  SessionPreparationCancelSpecSchema,
  SessionPreparationSpecSchema,
  SessionPrepareCancelResponseSchema,
  SessionPrepareResponseSchema,
  SessionPreviewEndpointAcquireResponseSchema,
  SessionPreviewCreateRequestSchema,
  SessionPreviewCreateResponseSchema,
  SessionPreviewRevokeRequestSchema,
  SessionPreviewRevokeResponseSchema,
  SessionPreviewStatusRequestSchema,
  SessionPreviewStatusResponseSchema,
  SessionPreviewEndpointReleaseResponseSchema,
  PreviewTargetSchema,
  SessionSteerResponseSchema,
  SessionGoalResponseSchema,
  SessionTerminateResponseSchema,
} from './message-schemas';

export const LOCAL_MACHINE_RPC_PATH = '/machine-rpc';

const BaseLocalMachineRpcRequestSchema = z
  .object({
    machineId: z.string().trim().min(1),
    workspaceId: z.string().trim().min(1),
    ownerSessionId: z.string().trim().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const SessionActiveInvocationContextResultSchema = z.discriminatedUnion('active', [
  z
    .object({
      type: z.literal('session/active-invocation-context'),
      sessionId: SessionIdSchema,
      active: z.literal(false),
    })
    .strict(),
  z
    .object({
      type: z.literal('session/active-invocation-context'),
      sessionId: SessionIdSchema,
      active: z.literal(true),
      requesterUserId: z.string().trim().min(1),
      sourceTurnId: z.string().trim().min(1),
      inputConfig: z.record(z.string(), z.unknown()),
    })
    .strict(),
]);
export type SessionActiveInvocationContextResult = z.infer<
  typeof SessionActiveInvocationContextResultSchema
>;

export const McpToolListResultSchema = z
  .object({
    type: z.literal('mcp/tools'),
    tools: z.array(z.object({ name: z.string(), description: z.string().optional() })),
  })
  .strict();
export type McpToolListResult = z.infer<typeof McpToolListResultSchema>;

export const SessionToolResultSchema = z
  .object({
    type: z.literal('session/tool-result'),
    content: z.array(z.object({ type: z.literal('text'), text: z.string() }).strict()),
    isError: z.boolean().optional(),
  })
  .strict();

const SessionToolCallSchema = z.object({
  name: z.string().min(1).max(100),
  arguments: z
    .record(z.string(), z.json())
    .refine(
      (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 256 * 1024,
      'Session tool arguments exceed 256 KiB'
    ),
});

const TerminalSessionIdSchema = z.string().trim().min(1).max(200);
const TerminalPromptShape = {
  prompt: z
    .string()
    .min(1)
    .max(1024 * 1024),
  mode: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  configOption: z.array(z.string().min(1)).max(50).optional(),
};
const TerminalSessionTargetSchema = <const T extends string>(command: T) =>
  z.object({ command: z.literal(command), sessionId: TerminalSessionIdSchema }).strict();

const TerminalSelectorSchema = z.string().trim().min(1).max(500);
const TerminalEnvSchema = z.record(z.string(), z.string());
const TerminalTitleGenerationSchema = z
  .object({
    configOptionValues: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
  })
  .strict();
/** Present when the command changes the field; an absent `value` clears it. */
const TerminalClearableSchema = <T extends z.ZodType>(value: T) =>
  z.object({ value: value.optional() }).strict();
const TerminalMcpOptionsSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    default: z.boolean().optional(),
    command: z.string().optional(),
    arg: z.array(z.string()).optional(),
    env: z.array(z.string()).optional(),
    envPassthrough: z.array(z.string()).optional(),
    url: z.string().optional(),
    bearerToken: z.string().optional(),
    header: z.array(z.string()).optional(),
  })
  .strict();

/** `lody agent-config` and `lody mcp` writes: catalog edits the daemon makes for a terminal. */
const TerminalCatalogCommandSchemas = [
  z
    .object({
      command: z.literal('agent-config-show'),
      selector: TerminalSelectorSchema.optional(),
      showSecrets: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal('agent-config-target'),
      selector: TerminalSelectorSchema.optional(),
      machine: TerminalSelectorSchema.optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal('agent-config-refresh'),
      machineId: TerminalSelectorSchema,
      configId: TerminalSelectorSchema,
    })
    .strict(),
  z
    .object({
      command: z.literal('agent-config-create'),
      agentType: TerminalSelectorSchema,
      machine: TerminalSelectorSchema.optional(),
      name: z.string().trim().min(1).max(500).optional(),
      description: z.string().max(10_000).optional(),
      env: TerminalEnvSchema,
      prompt: z
        .string()
        .max(1024 * 1024)
        .optional(),
      titleGeneration: TerminalTitleGenerationSchema.optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal('agent-config-update'),
      selector: TerminalSelectorSchema.optional(),
      name: z.string().trim().min(1).max(500).optional(),
      description: TerminalClearableSchema(z.string().max(10_000)).optional(),
      env: z
        .object({ set: TerminalEnvSchema, unset: z.array(z.string().min(1)) })
        .strict()
        .optional(),
      prompt: TerminalClearableSchema(z.string().max(1024 * 1024)).optional(),
      titleGeneration: TerminalClearableSchema(TerminalTitleGenerationSchema).optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal('agent-config-delete'),
      selector: TerminalSelectorSchema.optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal('mcp'),
      action: z.enum(['add', 'set', 'remove']),
      selector: TerminalSelectorSchema,
      offline: z.boolean().optional(),
      options: TerminalMcpOptionsSchema,
    })
    .strict(),
] as const;

/** A `lody` command of this machine's user that its daemon runs on the workspace replica. */
export const TerminalCommandSchema = z.discriminatedUnion('command', [
  z
    .object({
      command: z.literal('create'),
      ...TerminalPromptShape,
      title: z.string().trim().min(1).max(500).optional(),
      machine: z.string().trim().min(1).optional(),
      agentConfig: z.string().trim().min(1).optional(),
      parent: TerminalSessionIdSchema.optional(),
      useCurrentSessionAsParent: z.boolean().optional(),
      /** The terminal's `LODY_SESSION_ID`: the opener of the new Session. */
      currentSessionId: TerminalSessionIdSchema.optional(),
      repo: z.string().trim().min(1).optional(),
      localProject: z.string().trim().min(1).optional(),
      worktree: z.boolean().optional(),
      branch: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal('chat'),
      sessionId: TerminalSessionIdSchema,
      ...TerminalPromptShape,
    })
    .strict(),
  z
    .object({
      command: z.literal('wait'),
      sessionId: TerminalSessionIdSchema,
      userTurnId: z.string().trim().min(1),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(24 * 60 * 60 * 1000),
    })
    .strict(),
  z
    .object({
      command: z.literal('cancel'),
      sessionId: TerminalSessionIdSchema,
      turnId: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal('rename'),
      sessionId: TerminalSessionIdSchema,
      title: z.string().trim().min(1).max(500),
    })
    .strict(),
  TerminalSessionTargetSchema('archive'),
  TerminalSessionTargetSchema('restore'),
  TerminalSessionTargetSchema('delete'),
  TerminalSessionTargetSchema('show'),
  ...TerminalCatalogCommandSchemas,
  z.object({ command: z.literal('github-list') }).strict(),
  z
    .object({
      command: z.literal('operation-list'),
      session: TerminalSessionIdSchema,
      state: z.string().optional(),
      limit: z.number().optional(),
      cursor: z.string().optional(),
    })
    .strict(),
  z.object({ command: z.literal('sync'), concurrency: z.number().int().min(1).max(64) }).strict(),
  z
    .object({
      command: z.literal('export'),
      /** An absolute directory on this machine; the daemon writes it as the same user. */
      outputDir: z.string().min(1),
      offline: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      command: z.literal('machine-list'),
      onlineOnly: z.boolean().optional(),
      includeAgents: z.boolean().optional(),
      includeAcpCapabilities: z.boolean().optional(),
    })
    .strict(),
]);
export type TerminalCommand = z.infer<typeof TerminalCommandSchema>;

export const TerminalCommandResultSchema = z
  .object({
    type: z.literal('cli/command-result'),
    value: z.record(z.string(), z.json()),
  })
  .strict();

export const LocalMachineRpcRequestSchema = z.discriminatedUnion('method', [
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('ios-simulator/agent-control'),
    params: z.object({ sessionId: SessionIdSchema, command: IosSimulatorCommandSchema }).strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('ios-simulator/control'),
    params: IosSimulatorRequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('mcp/list-tools'),
    params: z
      .object({ server: z.custom<WorkspaceMcpServerMeta>(isWorkspaceMcpServerMeta) })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/call-tool'),
    params: SessionToolCallSchema.extend({ sessionId: SessionIdSchema }).strict(),
  }).strict(),
  // A terminal command: no Session or Turn drives it, so the daemon admits
  // only its read-only tools and answers as the machine's own user.
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('cli/call-tool'),
    params: SessionToolCallSchema.strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('cli/command'),
    params: TerminalCommandSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/get-active-invocation-context'),
    params: z
      .object({
        sessionId: SessionIdSchema,
      })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('code-collab/get-file-index'),
    params: CodeCollabV2FileIndexRequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('code-collab/open-text'),
    params: CodeCollabV2OpenTextRequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('code-collab/refresh-text'),
    params: CodeCollabV2RefreshTextRequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('code-collab/save-text'),
    params: CodeCollabV2SaveTextRequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('code-collab/open-current-diff'),
    params: CodeCollabV2OpenCurrentDiffRequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('code-collab/open-all-changes-diff'),
    params: CodeCollabV2OpenAllChangesDiffRequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('code-collab/open-turn-diff'),
    params: CodeCollabV2OpenTurnDiffRequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('code-collab/init-directory'),
    params: CodeCollabV2InitDirectoryRequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('code-collab/lsp-definition'),
    params: z
      .object({
        sessionId: z.string().trim().min(1),
        path: z.string().min(1),
        line: z.number().int().nonnegative().optional(),
        character: z.number().int().nonnegative().optional(),
      })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('code-collab/lsp-references'),
    params: z
      .object({
        sessionId: z.string().trim().min(1),
        path: z.string().min(1),
        line: z.number().int().nonnegative().optional(),
        character: z.number().int().nonnegative().optional(),
      })
      .strict(),
  }).strict(),
  // File Preview v3 over the same-machine IPC path. Params travel in the clear
  // here because the socket never leaves the machine.
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('file/preview'),
    params: FilePreviewV3RequestSchema,
  }).strict(),
  // Electron's same-machine preview route. This method deliberately has no
  // Loro Streams counterpart: the desktop user may inspect any local file,
  // while remote requests retain File Preview v3's restricted-root policy.
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('file/resolve-local'),
    params: FilePreviewV3RequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/cancel'),
    params: z
      .object({
        sessionId: SessionIdSchema,
        turnId: z.string().trim().min(1),
        subagentTaskId: z.string().trim().min(1).optional(),
      })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/fork'),
    params: SessionForkSpecSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/edit-and-resend'),
    params: SessionEditAndResendSpecSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/dispatch-turn'),
    params: z
      .object({
        sessionId: SessionIdSchema,
        userTurnId: z.string().trim().min(1),
        userId: z.string().trim().min(1),
        timestamp: z.string().trim().min(1),
        // Opaque at the transport layer; the CLI normalizes it with
        // `normalizeSessionTurnInputConfig` before offering the turn, the same
        // guard the Loro Streams Machine RPC server applies.
        inputConfig: z.record(z.string(), z.unknown()),
      })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/prepare'),
    params: SessionPreparationSpecSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/prepare-cancel'),
    params: SessionPreparationCancelSpecSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/steer'),
    params: z
      .object({
        sessionId: z.string().trim().min(1),
        expectedTurnId: z.string().trim().min(1),
        userTurnId: z.string().trim().min(1),
        userId: z.string().trim().min(1),
        timestamp: z.string().trim().min(1),
        inputConfig: z.record(z.string(), z.unknown()),
      })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/goal'),
    params: z
      .object({
        sessionId: SessionIdSchema,
        action: z.enum(SESSION_GOAL_ACTIONS),
        objective: z.string().trim().min(1).optional(),
        userId: z.string().trim().min(1),
      })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/preview-create'),
    params: SessionPreviewCreateRequestSchema.omit({
      type: true,
      machineId: true,
      workspaceId: true,
    }),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/preview-revoke'),
    params: SessionPreviewRevokeRequestSchema.omit({
      type: true,
      machineId: true,
      workspaceId: true,
    }),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/preview-status'),
    params: SessionPreviewStatusRequestSchema.omit({
      type: true,
      machineId: true,
      workspaceId: true,
    }),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/preview-endpoint-acquire'),
    params: z
      .object({
        sessionId: z.string().trim().min(1),
        requestedByUserId: z.string().trim().min(1),
        target: PreviewTargetSchema,
      })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/preview-endpoint-release'),
    params: z
      .object({
        sessionId: z.string().trim().min(1),
        endpointId: z.string().trim().min(1),
      })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('session/terminate'),
    params: z
      .object({
        sessionId: z.string().trim().min(1),
      })
      .strict(),
  }).strict(),
  /**
   * A machine RPC request for another member of this workspace's LAN, which
   * the agent service of this machine carries over its direct connection to
   * that member instead of the hub. `request` is the envelope the hub would
   * carry; the target checks it as one read from its request stream.
   */
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('lan/rpc-forward'),
    params: z
      .object({
        targetMachineId: z.string().trim().min(1),
        request: z
          .record(z.string(), z.unknown())
          .refine(
            (value) =>
              new TextEncoder().encode(JSON.stringify(value)).byteLength <= 8 * 1024 * 1024,
            'The request exceeds 8 MiB'
          ),
      })
      .strict(),
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('machine/memory'),
    params: MemoryProviderRequestSchema,
  }).strict(),
  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('machine/pi-extensions'),
    params: z
      .object({
        configId: AgentConfigIdSchema.optional(),
      })
      .strict(),
  }).strict(),  BaseLocalMachineRpcRequestSchema.extend({
    method: z.literal('machine/voice'),
    params: MachineVoiceRequestSchema,
  }).strict(),
]);

export type LocalMachineRpcRequest = z.infer<typeof LocalMachineRpcRequestSchema>;
export type LocalMachineRpcRequestValidated = LocalMachineRpcRequest;

/**
 * What became of a request carried to another member: `sent` false when it
 * never reached the member, which leaves it to the hub; otherwise the
 * member's answers, as it would have written them to the hub.
 */
export const LanRpcForwardResultSchema = z
  .object({
    type: z.literal('lan/rpc-forward_response'),
    sent: z.boolean(),
    answers: z.array(z.unknown()),
    error: z.string().optional(),
  })
  .strict();
export type LanRpcForwardResult = z.infer<typeof LanRpcForwardResultSchema>;

export const LocalMachineRpcResultSchema = z.union([
  LanRpcForwardResultSchema,
  // Before the looser session responses, which would strip its fields.
  MachineVoiceResponseSchema,
  MemoryProviderResponseSchema,
  IosSimulatorResponseSchema,
  McpToolListResultSchema,
  SessionToolResultSchema,
  TerminalCommandResultSchema,
  SessionActiveInvocationContextResultSchema,
  CodeCollabV2FileIndexSnapshotSchema,
  CodeCollabV2OpenTextOkSchema,
  CodeCollabV2RefreshTextResponseSchema,
  CodeCollabV2SaveTextResponseSchema,
  CodeCollabV2OpenCurrentDiffResponseSchema,
  CodeCollabV2OpenAllChangesDiffResponseSchema,
  CodeCollabV2OpenTurnDiffResponseSchema,
  CodeCollabV2InitDirectoryOkSchema,
  CodeCollabV2LspUnsupportedSchema,
  CodeCollabV2ErrorSchema,
  FilePreviewV3ResponseSchema,
  LocalFileResolutionSchema,
  SessionCancelResponseSchema,
  SessionDispatchTurnResponseSchema,
  SessionEditAndResendResponseSchema,
  SessionForkResponseSchema,
  SessionPrepareResponseSchema,
  SessionPrepareCancelResponseSchema,
  SessionPreviewEndpointAcquireResponseSchema,
  SessionPreviewEndpointReleaseResponseSchema,
  SessionSteerResponseSchema,
  SessionPreviewCreateResponseSchema,
  SessionPreviewRevokeResponseSchema,
  SessionPreviewStatusResponseSchema,
  SessionGoalResponseSchema,
  SessionTerminateResponseSchema,
  MachinePiExtensionsResponseSchema,
]);
export type LocalMachineRpcResult = z.infer<typeof LocalMachineRpcResultSchema>;

export const LocalMachineRpcResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      result: LocalMachineRpcResultSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.string().trim().min(1),
    })
    .strict(),
]);
export type LocalMachineRpcResponse = z.infer<typeof LocalMachineRpcResponseSchema>;

export function safeParseLocalMachineRpcRequest(
  raw: string
):
  | { readonly success: true; readonly data: LocalMachineRpcRequestValidated }
  | { readonly success: false; readonly error: z.ZodError } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const result = LocalMachineRpcRequestSchema.safeParse(parsed);
    if (!result.success) {
      return { success: false, error: result.error };
    }
    return { success: true, data: result.data };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof z.ZodError
          ? error
          : new z.ZodError([
              {
                code: z.ZodIssueCode.custom,
                path: [],
                message: 'Invalid JSON',
              },
            ]),
    };
  }
}

export { FilePreviewV3ErrorSchema } from './file-preview';
