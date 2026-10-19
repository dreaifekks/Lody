// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureDocumentRegion,
  documentSelectionLocation,
  formatDocumentSelection,
  locateMarkdownSelection,
  MAX_SELECTION_PIXELS,
  MAX_SELECTION_TEXT,
  selectionRect,
  type DocumentSelection,
} from '../src/lib/document-selection';
import {
  DocumentCaptureButton,
  DocumentSelectionSurface,
  useDocumentSelection,
} from '../src/components/sessions/document-selection-surface';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

describe('document selections', () => {
  it('clamps reverse drags to the visible preview', () => {
    expect(
      selectionRect({ x: 200, y: 150 }, { x: -20, y: -30 }, { width: 100, height: 80 })
    ).toEqual({ x: 0, y: 0, width: 100, height: 80 });
  });
  it('retains source, selected cells, comment and associated image in expanded context', () => {
    const text = formatDocumentSelection({
      path: 'report.xlsx',
      location: 'Revenue!A1:B2',
      text: 'North\t125000',
      comment: 'Check the total',
      image: new File(['png'], 'report-selection.png', { type: 'image/png' }),
    });
    expect(text).toBe(
      'Document selection\nFile: report.xlsx\nLocation: Revenue!A1:B2\nSelected content:\nNorth\t125000\nAnnotated image: report-selection.png\nComment:\nCheck the total'
    );
    expect(() =>
      formatDocumentSelection({
        path: 'report.pdf',
        location: 'Page 1',
        text: 'x'.repeat(MAX_SELECTION_TEXT + 1),
      })
    ).toThrow(RangeError);
  });
  it('locates mounted PDF, read-only DOCX and PPTX pages by intersecting visible bounds', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<div class="page" data-page-number="2"></div><div data-page-index="0" data-page="1"></div><div data-lody-slide="3"></div>';
    root.getBoundingClientRect = () => new DOMRect(10, 20, 400, 600);
    for (const page of root.children)
      page.getBoundingClientRect = () => new DOMRect(10, 20, 400, 600);
    expect(documentSelectionLocation(root, { x: 20, y: 20, width: 40, height: 40 })).toBe(
      'Page 2, Page 1, Slide 4'
    );
    expect(documentSelectionLocation(root, { x: 500, y: 500, width: 10, height: 10 })).toBe(
      'Visible preview'
    );
  });
  it('rejects canceled or over-budget captures before loading the capture engine', async () => {
    const root = document.createElement('div'),
      controller = new AbortController();
    controller.abort();
    await expect(
      captureDocumentRegion(root, { x: 0, y: 0, width: 40, height: 40 }, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      captureDocumentRegion(
        root,
        { x: 0, y: 0, width: MAX_SELECTION_PIXELS, height: 2 },
        new AbortController().signal
      )
    ).rejects.toThrow(RangeError);
  });
});

describe('rendered Markdown selection lines', () => {
  const report = [
    '# Quarterly **report**', // 1
    '',
    'Revenue grew by *12%* in the [north region](https://example.com/north).', // 3
    'Costs stayed flat.', // 4
    '',
    '- First `item`', // 6
    '- [x] Second item', // 7
    '',
    '| Region | Revenue |', // 9
    '| --- | ---: |',
    '| North | 125000 |', // 11
    '',
    '```ts', // 13
    'const total = sum(rows);', // 14
    '```',
    '',
    'Costs stayed flat.', // 17
  ].join('\n');

  it('places a selection inside one block on its source line', () => {
    expect(locateMarkdownSelection(report, 'Quarterly report')).toEqual({
      startLine: 1,
      endLine: 1,
    });
    expect(locateMarkdownSelection(report, 'const total = sum(rows);')).toEqual({
      startLine: 14,
      endLine: 14,
    });
  });

  it('spans rendered markup, soft-wrapped lines, list markers and table cells', () => {
    expect(
      locateMarkdownSelection(report, 'grew by 12% in the north region.\nCosts stayed flat.')
    ).toEqual({ startLine: 3, endLine: 4 });
    expect(locateMarkdownSelection(report, 'First item\nSecond item')).toEqual({
      startLine: 6,
      endLine: 7,
    });
    expect(locateMarkdownSelection(report, 'North\t125000')).toEqual({
      startLine: 11,
      endLine: 11,
    });
  });

  it('places both ends when rendering changes the middle of a long selection', () => {
    expect(
      locateMarkdownSelection(
        report,
        'Second item\n\nRegion\tRevenue\n(added by the renderer)\nNorth\t125000\n\nconst total = sum(rows);'
      )
    ).toEqual({ startLine: 7, endLine: 14 });
  });

  it('gives no lines for text that repeats or is not in the source', () => {
    expect(locateMarkdownSelection(report, 'Costs stayed flat.')).toBeNull();
    expect(locateMarkdownSelection(report, 'Profit')).toBeNull();
    expect(locateMarkdownSelection(report, '  \n ')).toBeNull();
  });
});

describe('document selection ownership', () => {
  let root: Root, container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const button = (label: string) =>
    Array.from(container.querySelectorAll('button')).find(
      (element) => element.textContent === label || element.getAttribute('aria-label') === label
    )!;
  function Picker({ read }: { read: (signal: AbortSignal) => Promise<DocumentSelection> }) {
    const select = useDocumentSelection();
    return createElement(
      'button',
      { disabled: !select, onClick: () => select?.(read) },
      'Pick cells'
    );
  }
  const render = async (
    child: ReactNode,
    source = 'revision-1',
    active = true,
    onAdd: (selection: DocumentSelection) => boolean = () => true
  ) => {
    await act(async () =>
      root.render(
        <DocumentSelectionSurface path="report.xlsx" source={source} active={active} onAdd={onAdd}>
          {child}
        </DocumentSelectionSurface>
      )
    );
  };
  it.each(['source', 'hidden'] as const)(
    'discards a late selection when the %s changes',
    async (change) => {
      let finish!: (value: DocumentSelection) => void;
      let signal!: AbortSignal;
      const pending = new Promise<DocumentSelection>((resolve) => {
        finish = resolve;
      });
      const child = createElement(Picker, {
        read: (current) => {
          signal = current;
          return pending;
        },
      });
      await render(child);
      await act(async () => button('Pick cells').click());
      await render(child, change === 'source' ? 'revision-2' : 'revision-1', change !== 'hidden');
      expect(signal.aborted).toBe(true);
      await act(async () => finish({ path: 'report.xlsx', location: 'A1', text: 'old selection' }));
      expect(container.textContent).not.toContain('old selection');
      expect(container.querySelector('[aria-label="Selection annotation"]')).toBeNull();
    }
  );
  it('retains a rejected selection for retry and clears it only after handoff', async () => {
    let accepted = false;
    const received: DocumentSelection[] = [];
    await render(
      createElement(Picker, {
        read: async () => ({ path: 'report.xlsx', location: 'A1', text: 'North' }),
      }),
      'revision-1',
      true,
      (selection) => {
        if (!accepted) return false;
        received.push(selection);
        return true;
      }
    );
    await act(async () => button('Pick cells').click());
    await act(async () => button('Add to chat').click());
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toContain('North');
    accepted = true;
    await act(async () => button('Add to chat').click());
    expect(received).toEqual([{ path: 'report.xlsx', location: 'A1', text: 'North', comment: '' }]);
    expect(container.querySelector('[aria-label="Selection annotation"]')).toBeNull();
  });
  it('cancels region mode with Escape without staging any content', async () => {
    await render(createElement(DocumentCaptureButton));
    await act(async () => button('Select screenshot area').click());
    const overlay = container.querySelector<HTMLElement>('[data-document-selection-overlay]')!;
    expect(document.activeElement).toBe(overlay);
    await act(async () =>
      overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    expect(container.querySelector('[data-document-selection-overlay]')).toBeNull();
    expect(container.querySelector('[aria-label="Selection annotation"]')).toBeNull();
  });
});
