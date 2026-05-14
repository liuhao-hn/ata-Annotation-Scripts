// ==UserScript==
// @name         数据标注平台人员进度与绩效汇总器 (V2.4.1 双核开源版)
// @namespace    https://github.com/yourusername
// @version      2.4.1
// @description  加入双核（首次验收通过和累积折损通过）对比机制，首次验收通过可以对比质检通过，查看初期标注质量；累积折损通过则将所有历史返工计入基数，以此量化达成最终交付所消耗的真实审核成本。
// @author       Your Name
// @match        https://*.your-company-domain.com/admin/projects/* // [TODO: 请修改为实际的标注系统业务域名]
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // [TODO: 根据实际后台 API 分页配置进行调整]
  const CONFIG = { PAGE_SIZE: 50 };

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
      // [TODO: 根据实际系统的 API 路由结构进行调整]
      const url = `/api/v1/admin/projects/${projectId}/data/batches?page=${pageId}&page_size=${CONFIG.PAGE_SIZE}`;
      const res = await get(url);

      if (res.code !== 0) throw new Error(`获取列表失败: ${res.msg}`);

      const items = res.data?.items || [];
      allBatches.push(...items);
      if (items.length < CONFIG.PAGE_SIZE) hasMore = false;
      else pageId++;
    }

    onProgress?.(`数据拉取完毕，正在同台计算进度与质量双核数据...`);

    const summary = {
      total_num: 0, labeled_num: 0,
      qa_checking_num: 0, accepting_num: 0,
      rejected_num: 0, finished_num: 0,
      qa_correct: 0, qa_total: 0,
      acc_first_correct: 0, acc_first_total: 0,
      acc_cum_correct: 0, acc_cum_errors: 0
    };

    const assigneeMap = {};

    for (const item of allBatches) {
      const assignee = item.assignee || '未分配';
      const total = item.total_count || 0;
      const completed = item.completed_count || 0;
      const status = item.status || '';
      const reason = item.rejected_reason || '';

      let finished = 0, qa_checking = 0, accepting = 0, rejected = 0;

      if (status === 'approved') finished = total;
      else if (status === 'submitted') accepting = total;          // submitted -> 验收中
      else if (status === 'quality_check') qa_checking = total;    // quality_check -> 质检中
      else if (status === 'rejected') rejected = total;

      let qaC = 0, qaT = 0;
      let acc_first_C = 0, acc_first_T = 0;
      let acc_cum_C = 0, acc_cum_E = 0;

      let isOrigin = !item.parent_batch_id;

      // 【1. 累积折损逻辑】(全局历史捞取)
      if (reason.includes('[验收统计]')) {
          const eMatch = reason.match(/\[验收统计\].*?错误:\s*(\d+)/);
          acc_cum_E = eMatch ? parseInt(eMatch[1], 10) : 0;
      }
      if (status === 'approved') {
          acc_cum_C = total;
      }

      // 【2. 一审直通逻辑】(严格使用抽检真实基数，绝不膨胀！)
      if (isOrigin) {
          const accMatchC = reason.match(/\[验收统计\].*?正确:\s*(\d+)/);
          const accMatchE = reason.match(/\[验收统计\].*?错误:\s*(\d+)/);
          const qaMatchC = reason.match(/\[质检统计\].*?正确:\s*(\d+)/);
          const qaMatchE = reason.match(/\[质检统计\].*?错误:\s*(\d+)/);

          // 质检一审
          if (qaMatchC || qaMatchE) {
              const c = qaMatchC ? parseInt(qaMatchC[1], 10) : 0;
              const e = qaMatchE ? parseInt(qaMatchE[1], 10) : 0;
              qaC = c;
              qaT = c + e; // 直接使用抽检数相加
          } else if (reason.includes('[验收统计]') || status === 'approved' || status === 'submitted') {
              qaC = total; qaT = total;
          }

          // 验收一审
          if (accMatchC || accMatchE) {
              const c = accMatchC ? parseInt(accMatchC[1], 10) : 0;
              const e = accMatchE ? parseInt(accMatchE[1], 10) : 0;
              acc_first_C = c;
              acc_first_T = c + e; // 直接使用抽检数相加，对了7个错3个，分母就是10！
          } else if (status === 'approved') {
              acc_first_C = total; acc_first_T = total;
          }
      }

      if (!assigneeMap[assignee]) {
        assigneeMap[assignee] = {
          assigneeName: assignee,
          total_num: 0, labeled_num: 0,
          qa_checking_num: 0, accepting_num: 0,
          rejected_num: 0, finished_num: 0,
          qa_correct: 0, qa_total: 0,
          acc_first_correct: 0, acc_first_total: 0,
          acc_cum_correct: 0, acc_cum_errors: 0
        };
      }

      // 【3. 基础进度累加】
      summary.total_num += total; assigneeMap[assignee].total_num += total;
      summary.labeled_num += completed; assigneeMap[assignee].labeled_num += completed;
      summary.qa_checking_num += qa_checking; assigneeMap[assignee].qa_checking_num += qa_checking;
      summary.accepting_num += accepting; assigneeMap[assignee].accepting_num += accepting;
      summary.rejected_num += rejected; assigneeMap[assignee].rejected_num += rejected;
      summary.finished_num += finished; assigneeMap[assignee].finished_num += finished;

      // 双核数据累加
      summary.qa_correct += qaC; summary.qa_total += qaT;
      summary.acc_first_correct += acc_first_C; summary.acc_first_total += acc_first_T;
      summary.acc_cum_correct += acc_cum_C; summary.acc_cum_errors += acc_cum_E;

      assigneeMap[assignee].qa_correct += qaC; assigneeMap[assignee].qa_total += qaT;
      assigneeMap[assignee].acc_first_correct += acc_first_C; assigneeMap[assignee].acc_first_total += acc_first_T;
      assigneeMap[assignee].acc_cum_correct += acc_cum_C; assigneeMap[assignee].acc_cum_errors += acc_cum_E;
    }

    const details = Object.values(assigneeMap).map(d => {
        d.acc_cum_total = d.acc_cum_correct + d.acc_cum_errors;
        return d;
    }).sort((a, b) => {
        if (a.assigneeName === '未分配') return 1;
        if (b.assigneeName === '未分配') return -1;
        return a.assigneeName.localeCompare(b.assigneeName);
    });

    summary.acc_cum_total = summary.acc_cum_correct + summary.acc_cum_errors;

    for (const d of details) onDetail?.(d);
    return { tasks: details, summary };
  }

  // ==================== UI 代码 ====================

  const STYLES = `
    #tm-user-progress-btn { position: fixed; left: 24px; bottom: 24px; z-index: 99999; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #fff; border: none; border-radius: 12px; padding: 12px 20px; font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4); display: flex; align-items: center; gap: 8px; transition: all 0.2s; }
    #tm-user-progress-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(16, 185, 129, 0.6); }
    #tm-user-progress-panel { position: fixed; left: 24px; bottom: 80px; z-index: 99998; width: 1100px; max-height: 85vh; background: #fff; border-radius: 16px; box-shadow: 0 8px 40px rgba(0, 0, 0, 0.15); display: none; flex-direction: column; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    #tm-user-progress-panel.show { display: flex; }
    .tm-user-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #fff; }
    .tm-user-header h3 { margin: 0; font-size: 16px; font-weight: 600; }
    .tm-user-close { background: rgba(255,255,255,0.2); border: none; color: #fff; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .tm-user-status { padding: 12px 20px; font-size: 13px; color: #666; border-bottom: 1px solid #f0f0f0; background: #fafbfc; }

    .tm-user-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; padding: 16px 20px; border-bottom: 1px solid #f0f0f0; }
    .tm-user-card { background: #f8f9ff; border-radius: 10px; padding: 12px 10px; text-align: center; }
    .tm-user-card .label { font-size: 12px; color: #888; margin-bottom: 6px; white-space: nowrap;}
    .tm-user-card .value { font-size: 20px; font-weight: 700; color: #333; }
    .tm-user-card.labeled .value { color: #f59e0b; }
    .tm-user-card.qa_check .value { color: #3b82f6; }
    .tm-user-card.accepting .value { color: #8b5cf6; }
    .tm-user-card.rejected .value { color: #dc2626; }
    .tm-user-card.finished .value { color: #10b981; }
    .tm-user-card.qa_rate .value { color: #3b82f6; }
    .tm-user-card.acc_first .value { color: #059669; }
    .tm-user-card.acc_cum .value { color: #d97706; }

    .tm-user-section { padding: 12px 20px 8px; font-size: 13px; font-weight: 600; color: #555; }
    .tm-user-table-wrap { flex: 1; overflow-y: auto; padding: 0 20px 16px; }
    .tm-user-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .tm-user-table th { position: sticky; top: 0; background: #f8f9fa; padding: 8px 6px; text-align: right; color: #666; border-bottom: 2px solid #e9ecef; white-space: nowrap; z-index: 2;}
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
    btn.innerHTML = '<span class="icon">🧑‍💻</span><span>人员进度质量汇总</span>';
    document.body.appendChild(btn);

    const panel = document.createElement('div');
    panel.id = 'tm-user-progress-panel';
    panel.innerHTML = `
      <div class="tm-user-header"><h3>🧑‍💻 人员绩效进度看板</h3><button class="tm-user-close">✕</button></div>
      <div class="tm-user-status" id="tm-user-status">点击按钮开始汇总</div>
      <div class="tm-user-grid" id="tm-user-summary" style="display:none;"></div>
      <div class="tm-user-section" id="tm-user-detail-title" style="display:none;">📋 成员明细 (先看进度，再看质量)</div>
      <div class="tm-user-table-wrap" id="tm-user-detail-wrap" style="display:none;">
        <table class="tm-user-table">
          <thead>
            <tr>
                <th>标注员</th>
                <th>总量</th>
                <th>已标注</th>
                <th>质检中</th>
                <th>验收中</th>
                <th>已驳回</th>
                <th>已完成</th>
                <th>🛡️质检通过率</th>
                <th>🎯验收(首次验收通过)</th>
                <th>🎯验收(累积折损通过)</th>
            </tr>
          </thead>
          <tbody id="tm-user-detail-body"></tbody>
        </table>
      </div>
      <button class="tm-user-copy-btn" id="tm-user-copy-btn" style="display:none;">📋 复制人员绩效结果</button>
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
        (p) => {
          const tr = document.createElement('tr');
          const nameStyle = p.assigneeName === '未分配' ? 'color: #9ca3af; font-style: italic;' : '';

          const qaCell = genRateCell(p.qa_correct, p.qa_total, '#3b82f6');
          const accFirstCell = genRateCell(p.acc_first_correct, p.acc_first_total, '#059669');
          const accCumCell = genRateCell(p.acc_cum_correct, p.acc_cum_total, '#d97706');

          tr.innerHTML = `
            <td style="${nameStyle}">${p.assigneeName}</td>
            <td>${formatNum(p.total_num)}</td>
            <td>${formatNum(p.labeled_num)}</td>
            <td>${formatNum(p.qa_checking_num)}</td>
            <td style="color:#8b5cf6; font-weight: 600;">${formatNum(p.accepting_num)}</td>
            <td style="color: #dc2626; font-weight: 600;">${formatNum(p.rejected_num)}</td>
            <td style="color: #10b981; font-weight: 600;">${formatNum(p.finished_num)}</td>
            ${qaCell}
            ${accFirstCell}
            ${accCumCell}
          `;
          detailBody.appendChild(tr);
        }
      );

      lastResult = result;
      const s = result.summary;

      const globalQa = s.qa_total > 0 ? (s.qa_correct / s.qa_total * 100).toFixed(1) + '%' : '-';
      const globalAccFirst = s.acc_first_total > 0 ? (s.acc_first_correct / s.acc_first_total * 100).toFixed(1) + '%' : '-';
      const globalAccCum = s.acc_cum_total > 0 ? (s.acc_cum_correct / s.acc_cum_total * 100).toFixed(1) + '%' : '-';

      summaryEl.innerHTML = `
        <div class="tm-user-card"><div class="label">📦 总量</div><div class="value">${formatNum(s.total_num)}</div></div>
        <div class="tm-user-card labeled"><div class="label">🏷️ 已标注</div><div class="value">${formatNum(s.labeled_num)}</div></div>
        <div class="tm-user-card rejected"><div class="label">❌ 已驳回</div><div class="value">${formatNum(s.rejected_num)}</div></div>

        <div class="tm-user-card qa_check"><div class="label">🛡️ 质检中</div><div class="value">${formatNum(s.qa_checking_num)}</div></div>
        <div class="tm-user-card accepting"><div class="label">🎯 验收中</div><div class="value">${formatNum(s.accepting_num)}</div></div>
        <div class="tm-user-card finished"><div class="label">✅ 已完成</div><div class="value">${formatNum(s.finished_num)}</div></div>

        <div class="tm-user-card qa_rate"><div class="label">🛡️ 质检通过率</div><div class="value">${globalQa}</div></div>
        <div class="tm-user-card acc_first"><div class="label">🎯 验收通过率(首次验收)</div><div class="value">${globalAccFirst}</div></div>
        <div class="tm-user-card acc_cum"><div class="label">🎯 验收通过率(累积折损)</div><div class="value">${globalAccCum}</div></div>
      `;

      statusEl.textContent = `✅ 完成`;
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
        const globalAccFirst = s.acc_first_total > 0 ? (s.acc_first_correct / s.acc_first_total * 100).toFixed(1) + '%' : '-';
        const globalAccCum = s.acc_cum_total > 0 ? (s.acc_cum_correct / s.acc_cum_total * 100).toFixed(1) + '%' : '-';

        let text = "人员绩效结果 (进度卡点追踪 & 质量双核比对)\n————————————————\n";
        text += `🛡️总体质检通过率: ${globalQa}\n`;
        text += `🎯总体验收(首次验收通过率): ${globalAccFirst}\n`;
        text += `🎯总体验收(累积折损通过率): ${globalAccCum}\n————————————————\n`;

        const rows = document.querySelectorAll('#tm-user-detail-body tr');
        rows.forEach(row => {
          const cells = row.querySelectorAll('td');
          if(cells[0].innerText !== '未分配') {
              const qaText = cells[7].innerText.replace(/\n/g, '');
              const accFirstText = cells[8].innerText.replace(/\n/g, '');
              const accCumText = cells[9].innerText.replace(/\n/g, '');
              text += `- ${cells[0].innerText}: 认领${cells[1].innerText} | 质检中${cells[3].innerText} | 验收中${cells[4].innerText} | 完${cells[6].innerText} | 质检率${qaText} | 首验${accFirstText} | 累积${accCumText}\n`;
          }
        });
        navigator.clipboard.writeText(text).then(() => {
          e.target.textContent = '✅ 已复制结果！';
          setTimeout(() => { e.target.textContent = '📋 复制人员绩效结果'; }, 2000);
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