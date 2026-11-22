import type { CodeNavQueryResponse } from '@lody/shared';
import type {
  CodeNavCallersInput,
  CodeNavDefinitionInput,
  CodeNavDiffOutlineInput,
  CodeNavEnclosingInput,
} from './types';

export type CodeNavWorkerParentMessage =
  | {
      readonly type: 'code-nav/query';
      readonly id: number;
      readonly action: 'diff-outline';
      readonly input: CodeNavDiffOutlineInput;
    }
  | {
      readonly type: 'code-nav/query';
      readonly id: number;
      readonly action: 'enclosing';
      readonly input: CodeNavEnclosingInput;
    }
  | {
      readonly type: 'code-nav/query';
      readonly id: number;
      readonly action: 'definition';
      readonly input: CodeNavDefinitionInput;
    }
  | {
      readonly type: 'code-nav/query';
      readonly id: number;
      readonly action: 'callers';
      readonly input: CodeNavCallersInput;
    }
  | {
      readonly type: 'code-nav/cancel';
      readonly id: number;
    }
  | {
      readonly type: 'code-nav/shutdown';
    };

export type CodeNavWorkerChildMessage = {
  readonly type: 'code-nav/result';
  readonly id: number;
  readonly response: CodeNavQueryResponse;
};

export function isCodeNavWorkerChildMessage(value: unknown): value is CodeNavWorkerChildMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly type?: unknown }).type === 'code-nav/result' &&
    typeof (value as { readonly id?: unknown }).id === 'number' &&
    typeof (value as { readonly response?: unknown }).response === 'object' &&
    (value as { readonly response?: unknown }).response !== null
  );
}
