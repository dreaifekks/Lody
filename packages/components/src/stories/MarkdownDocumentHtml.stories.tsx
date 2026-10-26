import type { Meta, StoryObj } from '@storybook/react';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';
import { MarkdownFileResources } from '@/components/ai-gui/markdown-file-image';
import { createFakeFileWorkspaceProvider } from '@/lib/file-workspace-provider';

const provider = createFakeFileWorkspaceProvider({
  files: [{ path: 'docs/logo.svg', kind: 'text', sourceState: 'live-readonly' }],
  snapshots: {
    'docs/logo.svg': {
      kind: 'text',
      text: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><rect width="480" height="240" rx="32" fill="#324967"/><text x="150" y="140" fill="white" font-size="56">logo</text></svg>',
    },
  },
});

const README = String.raw`<p align="center">
  <img src="./logo.svg" width="160" alt="logo">
</p>

<h3 align="center">Project title</h3>

Press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd>. H<sub>2</sub>O, x<sup>2</sup>, <mark>highlighted</mark> text.<br>
A line after a <code>&lt;br&gt;</code>.

<details>
<summary>Collapsed section</summary>

Hidden **Markdown** content with a list:

- first
- second

</details>

<details open>
<summary>Open section</summary>

$$
\begin{align} a &= b + c \\ d &= e \end{align}
$$

</details>

$$
\usepackage[version=4]{mhchem}
\newcommand{\R}{\mathbb{R}}
\def\half{\frac{1}{2}}
$$

Shared macros: $$f: \R \to \R$$ and later:

$$f(x) = \half x^2$$

\[ \ce{2H2 + O2 -> 2H2O} \]

$$
x = \begin{cases} 1 & y > 0 \\ 0 & \text{otherwise} \end{cases}
$$`;

function DocumentPreview({ width }: { width: number }) {
  return (
    <div className="scrollbar-pro h-full overflow-y-auto p-6">
      <div style={{ width }}>
        <MarkdownFileResources provider={provider} documentPath="docs/README.md" automatic active>
          <MarkdownRenderer text={README} allowHtml />
        </MarkdownFileResources>
      </div>
    </div>
  );
}

const meta = {
  title: 'Conversation/Markdown document HTML and math',
  component: DocumentPreview,
  parameters: { layout: 'fullscreen' },
  args: { width: 640 },
} satisfies Meta<typeof DocumentPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = { globals: { theme: 'light' } };
export const Dark: Story = { globals: { theme: 'dark' } };
