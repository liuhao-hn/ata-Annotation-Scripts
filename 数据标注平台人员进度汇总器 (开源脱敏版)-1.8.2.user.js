// ==UserScript==
// @name         数据标注平台人员进度汇总器 (开源脱敏版)
// @namespace    https://github.com/yourusername
// @version      1.8.2
// @description  同时提取供应商质检与甲方验收双重通过率，质检与验收双轨版；并引入分离式累加逻辑，实现数学意义上累积验收通过率的计算
// @author       Your Name
// @match        https://*.your-company-domain.com/admin/projects/* // [TODO: 请修改为你们实际的标注系统业务域名]
// @grant        none
// @run-at       document-end
// ==/UserScript==
// ╔══════════════════════════════════════════════════════════════╗
// ║  ⚠️ 本文件为脱敏版本（Portfolio Version）                    ║
// ║  平台名称、URL、作者信息已做脱敏处理，保留全部工程逻辑。       ║
// ║  原始代码已在实际生产环境中稳定运行数月。                     ║
// ╚══════════════════════════════════════════════════════════════╝

(function () {
  'use strict';

  // [TODO: 根据实际后台 API 分页配置进行调整]
  const CONFIG = {
    PAGE_SIZE: 50,
  };

  function getProjectId() {
    const match = location.pathname.match(/\/admin\/projects\/(\d+)/);
    return match ? match[1] : null;
  }

  async function get(url) {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
      },
      credentials: 'include',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    return resp.json();
  }

  // ==================== 核心逻辑 ====================

  async function aggregateProgress(onProgress, onDetail) {
    const projectId = getProjectId();
    if (!projectId) throw new Error('无法从 URL 中提取 project_id');

    let pageId = 1;
    let allBatches = [];
    let hasMore = true;

    while (hasMore) {
      onProgress?.(`正在获取批次数据第 ${pageId} 页...`);
      // [TODO: 修改为实际的后台数据批次接口 API]
      const url = `/api/v1/admin/projects/${projectId}/data/batches?page=${pageId}&page_size=${CONFIG.PAGE_SIZE}`;
      const res = await get(url);

      if (res.code !== 0) throw new Error(`获取列表失败: ${res.msg}`);

      const items = res.data?.items || [];
      allBatches.push(...items);
      if (items.length < CONFIG.PAGE_SIZE) hasMore = false;
      else pageId++;
    }

    onProgress?.(`数据拉取完毕，正在应用极简逻辑计算双漏斗...`);

    const summary = {
      total_num: 0, labeled_num: 0, wait_label_num: 0,
      deliver_reviewing_num: 0, rejected_num: 0, finished_num: 0,
      qa_correct: 0, qa_total: 0,
      acc_correct: 0, acc_errors: 0 // 验收采用“通关量+错误量”的计分模式
    };

    const assigneeMap = {};

    for (const item of allBatches) {
      const assignee = item.assignee || '未分配';
      const total = item.total_count || 0;
      const completed = item.completed_count || 0;
      const status = item.status || '';

      let finished = 0, reviewing = 0, rejected = 0;
      if (status === 'approved') finished = total;
      else if (status === 'submitted' || status === 'quality_check') reviewing = total;
      else if (status === 'rejected') rejected = total;

      // 【核心升级：分离式双漏斗算法】
      let qaC = 0, qaT = 0, accC = 0, accE = 0;

      // 1. 抓取父批次的“历史错题本” (经典逻辑，保证质检稳定)
      if (!item.parent_batch_id) {
          const reason = item.rejected_reason || '';

          // 质检逻辑：[TODO: 此处的正则匹配依赖于实际系统的驳回理由格式，如不同需自行修改]
          if (reason.includes('[质检统计]')) {
              const cMatch = reason.match(/\[质检统计\].*?正确:\s*(\d+)/);
              const eMatch = reason.match(/\[质检统计\].*?错误:\s*(\d+)/);
              qaC = cMatch ? parseInt(cMatch[1], 10) : 0;
              qaT = qaC + (eMatch ? parseInt(eMatch[1], 10) : 0);
          } else if (reason.includes('[验收统计]')) {
              qaC = total; qaT = total; // 进了验收，说明质检过了
          } else if (status === 'approved' || status === 'submitted') {
              qaC = total; qaT = total; // 全绿通关
          }

          // 验收逻辑：只从历史记录里抠出“错误数”
          if (reason.includes('[验收统计]')) {
              const eMatch = reason.match(/\[验收统计\].*?错误:\s*(\d+)/);
              accE = eMatch ? parseInt(eMatch[1], 10) : 0;
          }
      }

      // 2. 抓取真实的通关量（适用于所有批次，包含原包和拆分包）
      if (status === 'approved') {
          accC = total;
      }

      // 累加大盘
      summary.total_num += total;
      summary.labeled_num += completed;
      summary.wait_label_num += (total - completed);
      summary.deliver_reviewing_num += reviewing;
      summary.rejected_num += rejected;
      summary.finished_num += finished;

      summary.qa_correct += qaC; summary.qa_total += qaT;
      summary.acc_correct += accC; summary.acc_errors += accE;

      if (!assigneeMap[assignee]) {
        assigneeMap[assignee] = {
          assigneeName: assignee,
          total_num: 0, labeled_num: 0, wait_label_num: 0,
          deliver_reviewing_num: 0, rejected_num: 0, finished_num: 0,
          qa_correct: 0, qa_total: 0, acc_correct: 0, acc_errors: 0
        };
      }

      // 累加个人
      assigneeMap[assignee].total_num += total;
      assigneeMap[assignee].labeled_num += completed;
      assigneeMap[assignee].wait_label_num += (total - completed);
      assigneeMap[assignee].deliver_reviewing_num += reviewing;
      assigneeMap[assignee].rejected_num += rejected;
      assigneeMap[assignee].finished_num += finished;

      assigneeMap[assignee].qa_correct += qaC; assigneeMap[assignee].qa_total += qaT;
      assigneeMap[assignee].acc_correct += accC; assigneeMap[assignee].acc_errors += accE;
    }

    // 将分离记录的 correct 和 errors 合并为标准的显示格式
    const details = Object.values(assigneeMap).map(d => {
        d.acc_total = d.acc_correct + d.acc_errors; // 比如：29(对) + 3(错) = 32(总)
        return d;
    }).sort((a, b) => {
        if (a.assigneeName === '未分配') return 1;
        if (b.assigneeName === '未分配') return -1;
        return a.assigneeName.localeCompare(b.assigneeName);
    });

    summary.acc_total = summary.acc_correct + summary.acc_errors;

    for (const d of details) onDetail?.(d);
    return { tasks: details, summary };
  }

  // ==================== UI 代码 ====================

  const STYLES = `
    #tm-user-progress-btn { position: fixed; left: 24px; bottom: 24px; z-index: 99999; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #fff; border: none; border-radius: 12px; padding: 12px 20px; font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4); display: flex; align-items: center; gap: 8px; transition: all 0.2s; }
    #tm-user-progress-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(16, 185, 129, 0.6); }
    #tm-user-progress-panel { position: fixed; left: 24px; bottom: 80px; z-index: 99998; width: 880px; max-height: 80vh; background: #fff; border-radius: 16px; box-shadow: 0 8px 40px rgba(0, 0, 0, 0.15); display: none; flex-direction: column; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    #tm-user-progress-panel.show { display: flex; }
    .tm-user-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #fff; }
    .tm-user-header h3 { margin: 0; font-size: 16px; font-weight: 600; }
    .tm-user-close { background: rgba(255,255,255,0.2); border: none; color: #fff; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .tm-user-status { padding: 12px 20px; font-size: 13px; color: #666; border-bottom: 1px solid #f0f0f0; background: #fafbfc; }
    .tm-user-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; padding: 16px 20px; border-bottom: 1px solid #f0f0f0; }
    .tm-user-card { background: #f8f9ff; border-radius: 10px; padding: 12px 10px; text-align: center; }
    .tm-user-card .label { font-size: 12px; color: #888; margin-bottom: 6px; white-space: nowrap;}
    .tm-user-card .value { font-size: 20px; font-weight: 700; color: #333; }
    .tm-user-card.labeled .value { color: #f59e0b; }
    .tm-user-card.reviewing .value { color: #8b5cf6; }
    .tm-user-card.rejected .value { color: #dc2626; }
    .tm-user-card.finished .value { color: #10b981; }
    .tm-user-card.waiting .value { color: #ef4444; }
    .tm-user-card.qa .value { color: #3b82f6; }
    .tm-user-section { padding: 12px 20px 8px; font-size: 13px; font-weight: 600; color: #555; }
    .tm-user-table-wrap { flex: 1; overflow-y: auto; padding: 0 20px 16px; }
    .tm-user-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .tm-user-table th { position: sticky; top: 0; background: #f8f9fa; padding: 8px 6px; text-align: right; color: #666; border-bottom: 2px solid #e9ecef; white-space: nowrap; }
    .tm-user-table th:first-child { text-align: left; }
    .tm-user-table td { padding: 8px 6px; text-align: right; border-bottom: 1px solid #f0f0f0; color: #333; }
    .tm-user-table td:first-child { text-align: left; font-weight: 500; }
    .rate-box { display: flex; flex-direction: column; align-items: flex-end; line-height: 1.2; }
    .rate-pct { font-weight: 700; font-size: 13px; }
    .rate-detail { font-size: 10px; color: #888; margin-top: 2px; }
    .tm-user-copy-btn { margin: 0 20px 16px; padding: 8px; border: 1px solid #ddd; border-radius: 8px; background: #fff; cursor: pointer; font-size: 13px; color: #555; text-align: center; transition: all 0.2s;}
    .tm-user-copy-btn:hover { background: #f0f0f0; }
  `;

  function injectStyles() {
    if (document.getElementById('tm-user-styles')) return;
    const style = document.createElement('style');
    style.id = 'tm-user-styles';
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  function formatNum(n) { return n.toLocaleString('zh-CN'); }

  function genRateCell(correct, total, color) {
      if (total === 0) return `<td><span style="color:#aaa;">-</span></td>`;
      const pct = (correct / total * 100).toFixed(1) + '%';
      return `
        <td>
            <div class="rate-box">
                <span class="rate-pct" style="color: ${color};">${pct}</span>
                <span class="rate-detail">(对${correct}/阅${total})</span>
            </div>
        </td>`;
  }

  function createPanel() {
    if (document.getElementById('tm-user-progress-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'tm-user-progress-btn';
    btn.innerHTML = '<span class="icon">🧑‍💻</span><span>人员汇总</span>';
    document.body.appendChild(btn);

    const panel = document.createElement('div');
    panel.id = 'tm-user-progress-panel';
    panel.innerHTML = `
      <div class="tm-user-header"><h3>🧑‍💻 人员进度与质量汇总</h3><button class="tm-user-close">✕</button></div>
      <div class="tm-user-status" id="tm-user-status">点击按钮开始汇总</div>
      <div class="tm-user-grid" id="tm-user-summary" style="display:none;"></div>
      <div class="tm-user-section" id="tm-user-detail-title" style="display:none;">📋 成员明细 (固定姓名排序)</div>
      <div class="tm-user-table-wrap" id="tm-user-detail-wrap" style="display:none;">
        <table class="tm-user-table">
          <thead><tr><th>标注员</th><th>认领总量</th><th>🛡️质检通过率</th><th>🎯验收通过率</th><th>已标注</th><th>待标注</th><th>审核中</th><th>已驳回</th><th>已完成</th></tr></thead>
          <tbody id="tm-user-detail-body"></tbody>
        </table>
      </div>
      <button class="tm-user-copy-btn" id="tm-user-copy-btn" style="display:none;">📋 复制人员双轨质量</button>
    `;
    document.body.appendChild(panel);

    panel.querySelector('.tm-user-close').addEventListener('click', () => panel.classList.remove('show'));
    btn.addEventListener('click', () => {
      panel.classList.add('show');
      runAggregation();
    });
  }

  let lastResult = null;

  async function runAggregation() {
    const statusEl = document.getElementById('tm-user-status');
    const summaryEl = document.getElementById('tm-user-summary');
    const detailTitle = document.getElementById('tm-user-detail-title');
    const detailWrap = document.getElementById('tm-user-detail-wrap');
    const detailBody = document.getElementById('tm-user-detail-body');
    const copyBtn = document.getElementById('tm-user-copy-btn');

    summaryEl.style.display = 'none'; detailTitle.style.display = 'none'; detailWrap.style.display = 'none'; copyBtn.style.display = 'none';
    detailBody.innerHTML = '';

    try {
      const result = await aggregateProgress(
        (msg) => { statusEl.textContent = msg; },
        (progress) => {
          const tr = document.createElement('tr');
          const nameStyle = progress.assigneeName === '未分配' ? 'color: #9ca3af; font-style: italic;' : '';

          const qaCell = genRateCell(progress.qa_correct, progress.qa_total, '#3b82f6');
          const accCell = genRateCell(progress.acc_correct, progress.acc_total, '#059669');

          tr.innerHTML = `
            <td style="${nameStyle}">${progress.assigneeName}</td>
            <td>${formatNum(progress.total_num)}</td>
            ${qaCell}
            ${accCell}
            <td>${formatNum(progress.labeled_num)}</td>
            <td>${formatNum(progress.wait_label_num)}</td>
            <td>${formatNum(progress.deliver_reviewing_num)}</td>
            <td style="color: #dc2626; font-weight: 600;">${formatNum(progress.rejected_num)}</td>
            <td>${formatNum(progress.finished_num)}</td>
          `;
          detailBody.appendChild(tr);
        }
      );

      lastResult = result;

      const s = result.summary;
      const globalQa = s.qa_total > 0 ? (s.qa_correct / s.qa_total * 100).toFixed(1) + '%' : '-';
      const globalAcc = s.acc_total > 0 ? (s.acc_correct / s.acc_total * 100).toFixed(1) + '%' : '-';

      summaryEl.innerHTML = `
        <div class="tm-user-card"><div class="label">📦 总任务数</div><div class="value">${formatNum(s.total_num)}</div></div>
        <div class="tm-user-card labeled"><div class="label">🏷️ 已标注</div><div class="value">${formatNum(s.labeled_num)}</div></div>
        <div class="tm-user-card waiting"><div class="label">⏳ 待标注</div><div class="value">${formatNum(s.wait_label_num)}</div></div>
        <div class="tm-user-card qa"><div class="label">🛡️ 质检通过率</div><div class="value">${globalQa}</div></div>

        <div class="tm-user-card"><div class="label">🎯 验收通过率</div><div class="value" style="color:#059669;">${globalAcc}</div></div>
        <div class="tm-user-card reviewing"><div class="label">🔍 审核中</div><div class="value">${formatNum(s.deliver_reviewing_num)}</div></div>
        <div class="tm-user-card rejected"><div class="label">❌ 已驳回</div><div class="value">${formatNum(s.rejected_num)}</div></div>
        <div class="tm-user-card finished"><div class="label">✅ 已完成</div><div class="value">${formatNum(s.finished_num)}</div></div>
      `;

      statusEl.textContent = `✅ 完成！质检与验收双漏斗数据已生成`;
      summaryEl.style.display = 'grid'; detailTitle.style.display = 'block'; detailWrap.style.display = 'block'; copyBtn.style.display = 'block';
    } catch (err) {
      statusEl.textContent = `❌ 错误: ${err.message}`;
    }
  }

  function setupCopy() {
    if (window.tmUserCopyBound) return;
    window.tmUserCopyBound = true;
    document.addEventListener('click', (e) => {
      if (e.target.id === 'tm-user-copy-btn') {
        if (!lastResult) return;
        const s = lastResult.summary;
        const globalQa = s.qa_total > 0 ? (s.qa_correct / s.qa_total * 100).toFixed(1) + '%' : '-';
        const globalAcc = s.acc_total > 0 ? (s.acc_correct / s.acc_total * 100).toFixed(1) + '%' : '-';

        let text = "人员绩效结果 (双漏斗追踪)\n————————————————\n";
        text += `🛡️大盘质检通过率: ${globalQa}\n`;
        text += `🎯大盘验收通过率: ${globalAcc}\n————————————————\n`;

        const rows = document.querySelectorAll('#tm-user-detail-body tr');
        rows.forEach(row => {
          const cells = row.querySelectorAll('td');
          if(cells[0].innerText !== '未分配') {
              const qaText = cells[2].innerText.replace(/\n/g, '');
              const accText = cells[3].innerText.replace(/\n/g, '');
              text += `- ${cells[0].innerText}: 质检 ${qaText} | 验收 ${accText} | 认领 ${cells[1].innerText} | 完成 ${cells[8].innerText}\n`;
          }
        });
        navigator.clipboard.writeText(text).then(() => {
          e.target.textContent = '✅ 已复制！';
          setTimeout(() => { e.target.textContent = '📋 复制人员双轨质量'; }, 2000);
        });
      }
    });
  }

  function ensureUI() {
    const isProjectPage = /\/admin\/projects\/\d+/.test(location.pathname);
    if (isProjectPage && !document.getElementById('tm-user-progress-btn')) {
      injectStyles();
      createPanel();
      setupCopy();
    } else if (!isProjectPage && document.getElementById('tm-user-progress-btn')) {
      document.querySelectorAll('#tm-user-progress-btn, #tm-user-progress-panel, style[id^="tm-user-styles"]').forEach(el => el.remove());
    }
  }

  ensureUI();
  setInterval(ensureUI, 1500);

})();