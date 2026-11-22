import { describe, expect, it } from 'vitest';
import type { AcpCommandSummary } from '@lody/shared';
import {
  BTW_SLASH_COMMAND,
  mergeBtwAvailableCommands,
  parseBtwSlashCommand,
} from '../src/components/sessions/btw/btw-slash-command';

describe('btw-slash-command', () => {
  describe('parseBtwSlashCommand', () => {
    it('matches bare /btw and /btw with question across case and whitespace', () => {
      expect(parseBtwSlashCommand('/btw')).toEqual({ matched: true, question: '' });
      expect(parseBtwSlashCommand('  /btw   ')).toEqual({ matched: true, question: '' });
      expect(parseBtwSlashCommand('/btw what is Streams RPC?')).toEqual({
        matched: true,
        question: 'what is Streams RPC?',
      });
      expect(parseBtwSlashCommand('/BTW\n  line 1\nline 2  ')).toEqual({
        matched: true,
        question: 'line 1\nline 2',
      });
    });

    it('does not match other commands or mid-sentence /btw', () => {
      expect(parseBtwSlashCommand('')).toEqual({ matched: false });
      expect(parseBtwSlashCommand('/btwx test')).toEqual({ matched: false });
      expect(parseBtwSlashCommand('/plan /btw foo')).toEqual({ matched: false });
      expect(parseBtwSlashCommand('hello /btw world')).toEqual({ matched: false });
    });
  });

  describe('mergeBtwAvailableCommands', () => {
    it('appends the client /btw command when absent', () => {
      expect(mergeBtwAvailableCommands(undefined)).toEqual([BTW_SLASH_COMMAND]);
      const base: AcpCommandSummary[] = [{ name: 'plan', description: 'Enter plan mode' }];
      expect(mergeBtwAvailableCommands(base)).toEqual([...base, BTW_SLASH_COMMAND]);
    });

    it('deduplicates existing /btw entries case-insensitively without mutating input', () => {
      const existing: AcpCommandSummary[] = [
        { name: 'compact', description: 'Compact context' },
        { name: 'BTW', description: 'Provider btw' },
        { name: 'btw', description: 'Duplicate btw' },
      ];
      const merged = mergeBtwAvailableCommands(existing);
      expect(merged).toEqual([
        { name: 'compact', description: 'Compact context' },
        { name: 'BTW', description: 'Provider btw' },
      ]);
      expect(existing).toHaveLength(3);
    });
  });
});
