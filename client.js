/**
 * DSH PDF Enhanced — Client 半体
 *
 * 1) 侧栏底部动作区（sidebar.footer.action）显示 OCR 进度：有任务才出现，没任务不占位。
 * 2) 点开在应用内浮层（shell.overlay）里看详情：进度条、页数、失败页、耗时、预计剩余、缓存目录。
 *
 * 数据由 Host 半体的 /plugins/dsh-doc-parser/api/progress 提供（只回环，内存态）。
 * 约束：不 require 任何 @deepseek-ai/dsh-client-* 包，只从 module table 取 React；
 * 颜色用主题 token + 兜底值。
 */
window.__ModuleLoader__.load({
  id: 'dsh-doc-parser',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const BASE = '/plugins/dsh-doc-parser';
    const POLL_MS = 2000;

    const token = (name, fallback) => `var(--dsw-alias-${name}, ${fallback})`;

    // ---------- 共享状态：侧栏按钮与浮层共用一个轮询结果 ----------
    let state = { jobs: [], error: '' };
    const subs = new Set();
    let timer = null;
    let inflight = false;

    async function poll() {
      if (inflight) return;
      inflight = true;
      try {
        const r = await fetch(BASE + '/api/progress', { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        state = { jobs: Array.isArray(j.jobs) ? j.jobs : [], error: '' };
      } catch (err) {
        state = { jobs: state.jobs, error: String((err && err.message) || err) };
      } finally {
        inflight = false;
        for (const f of subs) f(state);
      }
    }

    function ensurePolling() {
      if (timer) return;
      poll();
      timer = setInterval(poll, POLL_MS);
    }

    function useProgress() {
      const [v, setV] = React.useState(state);
      React.useEffect(() => {
        subs.add(setV);
        ensurePolling();
        setV(state);
        return () => {
          subs.delete(setV);
        };
      }, []);
      return v;
    }

    // ---------- 浮层开关：按钮与浮层联动 ----------
    let open = false;
    const openSubs = new Set();
    const setOpen = (v) => {
      open = v;
      for (const f of openSubs) f(v);
    };
    function useOpen() {
      const [v, setV] = React.useState(open);
      React.useEffect(() => {
        openSubs.add(setV);
        setV(open);
        return () => {
          openSubs.delete(setV);
        };
      }, []);
      return v;
    }

    // ---------- 小工具 ----------
    function fmtDur(ms) {
      const s = Math.max(0, Math.round((ms || 0) / 1000));
      if (s < 60) return s + ' 秒';
      const m = Math.floor(s / 60);
      const r = s % 60;
      return r ? m + ' 分 ' + r + ' 秒' : m + ' 分';
    }

    function etaOf(j) {
      if (!j.done || j.finished) return 0;
      const per = j.elapsedMs / j.done;
      return Math.max(0, Math.round(per * (j.total - j.done)));
    }

    function baseName(p) {
      const s = String(p || '');
      const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
      return i >= 0 ? s.slice(i + 1) : s;
    }

    function bar(pct, warn) {
      return h(
        'div',
        { style: { height: 6, borderRadius: 3, background: token('bg-l2', '#2a2f37'), overflow: 'hidden' } },
        h('div', {
          style: {
            width: Math.min(100, Math.max(0, pct)) + '%',
            height: '100%',
            background: warn ? token('status-warning', '#e0a13a') : token('brand-primary', '#4c8dff'),
            transition: 'width .3s ease',
          },
        }),
      );
    }

    // ---------- 侧栏入口 ----------
    function ProgressEntry({ className }) {
      const s = useProgress();
      const running = s.jobs.filter((j) => !j.finished);
      if (!running.length) return null;
      const j = running[0];
      const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
      return h(
        'button',
        {
          type: 'button',
          className,
          title: 'PDF OCR ' + j.done + '/' + j.total + ' 页（点开看详情）',
          'aria-label': 'PDF OCR 进度',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            cursor: 'pointer',
            background: 'transparent',
            border: 0,
          },
          onClick: () => setOpen(true),
        },
        h(
          'span',
          { style: { fontSize: 11, fontVariantNumeric: 'tabular-nums', opacity: 0.85 } },
          j.done + '/' + j.total,
        ),
        h('span', { style: { width: 44, display: 'inline-block' } }, bar(pct, j.failed.length > 0)),
        running.length > 1
          ? h('span', { style: { fontSize: 10, opacity: 0.7 } }, '+' + (running.length - 1))
          : null,
      );
    }

    // ---------- 浮层详情 ----------
    function JobRow(j, i) {
      const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
      const eta = etaOf(j);
      return h(
        'div',
        {
          key: j.cacheDir || String(i),
          style: {
            padding: '10px 12px',
            borderRadius: 8,
            border: '1px solid ' + token('border-l2', '#2a2f37'),
            background: token('bg-l1', '#191c22'),
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
          h('b', { style: { fontSize: 12 } }, baseName(j.pdf)),
          h('span', { style: { flex: 1 } }),
          h('span', { style: { fontSize: 11, opacity: 0.8, fontVariantNumeric: 'tabular-nums' } }, j.finished ? '完成' : pct + '%'),
        ),
        bar(pct, j.failed.length > 0),
        h(
          'div',
          { style: { fontSize: 11, opacity: 0.78, display: 'flex', gap: 12, flexWrap: 'wrap' } },
          h('span', null, j.done + '/' + j.total + ' 页'),
          h('span', null, '已用 ' + fmtDur(j.elapsedMs)),
          eta ? h('span', null, '预计剩余 ' + fmtDur(eta)) : null,
          j.failed.length ? h('span', { style: { color: token('status-warning', '#e0a13a') } }, '失败 ' + j.failed.length) : null,
          j.note ? h('span', { style: { opacity: 0.65 } }, j.note) : null,
        ),
        j.failed.length
          ? h('div', { style: { fontSize: 11, opacity: 0.7 } }, '失败页：' + j.failed.join(', ') + '（可对该页单独重跑）')
          : null,
        j.cacheDir
          ? h('div', { style: { fontSize: 10, opacity: 0.5, wordBreak: 'break-all' } }, j.cacheDir)
          : null,
      );
    }

    function ProgressPanel() {
      const isOpen = useOpen();
      const s = useProgress();
      React.useEffect(() => {
        if (!isOpen) return undefined;
        const onKey = (e) => {
          if (e.key === 'Escape') setOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [isOpen]);
      if (!isOpen) return null;
      const btn = { fontSize: 12, cursor: 'pointer', padding: '4px 8px' };
      return h(
        'div',
        {
          onClick: () => setOpen(false),
          style: {
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,.55)',
            zIndex: 2147483000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          },
        },
        h(
          'div',
          {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': 'PDF OCR 进度',
            onClick: (e) => e.stopPropagation(),
            style: {
              width: 'min(560px, 92vw)',
              maxHeight: '80vh',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              background: token('bg-base', '#14161a'),
              color: token('label-primary', '#e6e6e6'),
              border: '1px solid ' + token('border-l2', '#2a2f37'),
              borderRadius: 10,
            },
          },
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 10px',
                borderBottom: '1px solid ' + token('border-l2', '#2a2f37'),
              },
            },
            h('b', { style: { fontSize: 13 } }, 'PDF OCR 进度'),
            h('span', { style: { flex: 1 } }),
            h('button', { type: 'button', style: btn, 'aria-label': '关闭', onClick: () => setOpen(false) }, '关闭'),
          ),
          h(
            'div',
            { style: { padding: 12, display: 'flex', flexDirection: 'column', gap: 8, overflow: 'auto' } },
            s.jobs.length
              ? s.jobs.map(JobRow)
              : h(
                  'div',
                  { style: { fontSize: 12, opacity: 0.7 } },
                  '当前没有 OCR 任务。调用 doc_ocr（含 prefetch）后，这里会实时显示进度。',
                ),
            s.error
              ? h('div', { style: { fontSize: 11, color: token('status-warning', '#e0a13a') } }, '读取进度失败：' + s.error)
              : null,
          ),
          h(
            'div',
            {
              style: {
                fontSize: 10,
                opacity: 0.55,
                padding: '6px 12px',
                borderTop: '1px solid ' + token('border-l2', '#2a2f37'),
              },
            },
            '每 2 秒自动刷新 · 数据来自本机 Host 半体内存，不落盘',
          ),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'dsh-doc-parser.entry', order: 39 },
            ProgressEntry,
          ),
        );
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-doc-parser.panel', order: 39 },
            ProgressPanel,
          ),
        );
      },
    };
  },
});
