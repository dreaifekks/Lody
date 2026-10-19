/** Synthetic articles a Board thread might write: a report and an interactive page. */

export const ARTICLE_REPORT_MD = [
  '# 看板 article 原型调研报告',
  '',
  '线程 A 在 2026-10-19 写的示例报告，用来验证 article 浮窗：标题、列表、表格和代码块。',
  '选中任意一段文字，可以把批注作为 chip 放进右边线程的输入框。',
  '',
  '## 结论',
  '',
  '- 浮窗是右侧面板的聚焦布局，不是 Dialog，线程对话不会重新挂载。',
  '- HTML 在 widget 页面里运行，只能从几个 CDN 加载脚本和样式。',
  '- 刷新靠 digest 轮询：线程工作时每 5 秒，空闲时每 15 秒。',
  '',
  '## 数据',
  '',
  '| 方案 | 改动范围 | 需要发 dev 包 | 风险 |',
  '| --- | --- | :---: | --- |',
  '| 聚焦布局 | 前端 | 否 | 低 |',
  '| Dialog 浮窗 | 前端 | 否 | 线程重复挂载 |',
  '| MCP 打开卡片 | CLI + 前端 | 是 | 中 |',
  '',
  '## 轮询节奏',
  '',
  '1. 展开且文件可见时开始。',
  '2. 线程一轮结束时补查一次。',
  '3. digest 不变就什么都不做。',
  '',
  '```ts',
  'useSessionFileDigestWatch({ enabled, busy, check });',
  '```',
  '',
  '> 这份数据可能过时了：上游 0.107.0 还没打 tag。',
  '',
].join('\n');

export const ARTICLE_DEMO_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>轮询开销演示</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  body { margin: 0; padding: 24px; font-family: var(--font-sans); color: var(--text-primary); background: var(--surface-0); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { color: var(--text-secondary); margin: 0 0 16px; }
  .controls { display: flex; gap: 8px; margin-bottom: 16px; }
  button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border-strong); background: var(--surface-1); color: var(--text-primary); cursor: pointer; }
  button.active { background: var(--bg-accent); border-color: var(--border-accent); color: var(--text-accent); }
  .card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  #status { margin-top: 12px; font-size: 13px; color: var(--text-muted); }
</style>
</head>
<body>
<h1>每小时的预览请求数</h1>
<p>按线程状态切换节奏，看 digest 轮询在 LAN 上有多少请求。</p>
<div class="controls">
  <button id="busy" class="active">线程工作中（5 秒）</button>
  <button id="idle">线程空闲（15 秒）</button>
</div>
<div class="card"><canvas id="chart" height="220"></canvas></div>
<div id="status">Chart.js 加载中…</div>
<script>
  const status = document.getElementById('status');
  if (typeof Chart === 'undefined') {
    status.textContent = 'Chart.js 没有加载：CDN 被拦截了。';
  } else {
    const hours = Array.from({ length: 8 }, (_, i) => i + 1 + ' 小时');
    const series = (interval) => hours.map((_, i) => Math.round(((i + 1) * 3600) / interval));
    const chart = new Chart(document.getElementById('chart'), {
      type: 'bar',
      data: { labels: hours, datasets: [{ label: '累计请求', data: series(5), backgroundColor: '#378ADD' }] },
      options: { animation: false, plugins: { legend: { display: false } } },
    });
    const pick = (interval, id) => {
      chart.data.datasets[0].data = series(interval);
      chart.update();
      document.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.id === id));
      status.textContent = '每 ' + interval + ' 秒一次，8 小时共 ' + series(interval).at(-1) + ' 次请求。';
    };
    document.getElementById('busy').addEventListener('click', () => pick(5, 'busy'));
    document.getElementById('idle').addEventListener('click', () => pick(15, 'idle'));
    pick(5, 'busy');
  }
</script>
</body>
</html>
`;
