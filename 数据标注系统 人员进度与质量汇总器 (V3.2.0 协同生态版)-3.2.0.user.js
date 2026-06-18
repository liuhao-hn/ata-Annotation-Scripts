// ==UserScript==
// @name         数据标注系统 人员进度与质量汇总器 (V3.2.0 协同生态版)
// @namespace    https://label.your-company.com/
// @version      3.2.0
// @description  引入前端时间滑窗硬过滤机制，支持一键下载本地 Excel，优化剪贴板数据流，完美无缝支持向腾讯文档/飞书表格等协作文档中智能粘贴。
// @author       PM_Author
// @match        https://label.your-company.com/admin/projects/*
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

  const CONFIG = { PAGE_SIZE: 50 };

  // 全局存储当前选择的时间窗口（默认0代表看全部）
  let currentTimeWindowDays = 0;

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
      const url = `/api/v1/admin/projects/${projectId}/data/batches?page=${pageId}&page_size=${CONFIG.PAGE_SIZE}`;
      const res = await get(url);

      if (res.code !== 0) throw new Error(`获取列表失败: ${res.msg}`);

      const items = res.data?.items || [];
      allBatches.push(...items);
      if (items.length < CONFIG.PAGE_SIZE) hasMore = false;
      else pageId++;
    }

    onProgress?.(`数据拉取完毕，正在动态执行时间滑窗硬清洗...`);

    const summary = {
      total_num: 0, labeled_num: 0,
      qa_checking_num: 0, accepting_num: 0,
      rejected_num: 0, finished_num: 0,
      qa_correct: 0, qa_total: 0,
      acc_first_correct: 0, acc_first_total: 0,
      acc_cum_correct: 0, acc_cum_errors: 0
    };

    const assigneeMap = {};
    let filteredCount = 0;

    for (const item of allBatches) {
      // 时间滑窗硬过滤拦截器
      if (currentTimeWindowDays > 0) {
        const updateTimeStr = item.updated_at;
        if (updateTimeStr) {
          const updateTime = new Date(updateTimeStr).getTime();
          const now = Date.now();
          const milesecondsThreshold = currentTimeWindowDays * 24 * 60 * 60 * 1000;

          if (now - updateTime > milesecondsThreshold) {
            filteredCount++;
            continue;
          }
        }
      }

      const assignee = item.assignee || '未分配';
      const total = item.total_count || 0;
      const completed = item.completed_count || 0;
      const status = item.status || '';
      const reason = item.rejected_reason || '';

      let finished = 0, qa_checking = 0, accepting = 0, rejected = 0;

      if (status === 'approved') finished = total;
      else if (status === 'submitted') accepting = total;
      else if (status === 'quality_check') qa_checking = total;
      else if (status === 'rejected') rejected = total;

      let qaC = 0, qaT = 0;
      let acc_first_C = 0, acc_first_T = 0;
      let acc_cum_C = 0, acc_cum_E = 0;

      let isOrigin = !item.parent_batch_id;

      // 累积折损
      if (reason.includes('[验收统计]')) {
          const eMatch = reason.match(/\[验收统计\].*?错误:\s*(\d+)/);
          acc_cum_E = eMatch ? parseInt(eMatch[1], 10) : 0;
      }
      if (status === 'approved') {
          acc_cum_C = total;
      }

      // 一审直通
      if (isOrigin) {
          const accMatchC = reason.match(/\[验收统计\].*?正确:\s*(\d+)/);
          const accMatchE = reason.match(/\[验收统计\].*?错误:\s*(\d+)/);
          const qaMatchC = reason.match(/\[质检统计\].*?正确:\s*(\d+)/);
          const qaMatchE = reason.match(/\[质检统计\].*?错误:\s*(\d+)/);

          if (qaMatchC || qaMatchE) {
              const c = qaMatchC ? parseInt(qaMatchC[1], 10) : 0;
              const e = qaMatchE ? parseInt(qaMatchE[1], 10) : 0;
              qaC = c; qaT = c + e;
          } else if (reason.includes('[验收统计]') || status === 'approved' || status === 'submitted') {
              qaC = total; qaT = total;
          }

          if (accMatchC || accMatchE) {
              const c = accMatchC ? parseInt(accMatchC[1], 10) : 0;
              const e = accMatchE ? parseInt(accMatchE[1], 10) : 0;
              acc_first_C = c; acc_first_T = c + e;
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

      summary.total_num += total; assigneeMap[assignee].total_num += total;
      summary.labeled_num += completed; assigneeMap[assignee].labeled_num += completed;
      summary.qa_checking_num += qa_checking; assigneeMap[assignee].qa_checking_num += qa_checking;
      summary.accepting_num += accepting; assigneeMap[assignee].accepting_num += accepting;
      summary.rejected_num += rejected; assigneeMap[assignee].rejected_num += rejected;
      summary.finished_num += finished; assigneeMap[assignee].finished_num += finished;

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
    return { tasks: details, summary, filteredCount, totalLoaded: allBatches.length };
  }

  // ==================== UI 代码 ====================

  const STYLES = `
    #tm-user-progress-btn { position: fixed; left: 24px; bottom: 24px; z-index: 99999; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #fff; border: none; border-radius: 12px; padding: 12px 20px; font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4); display: flex; align-items: center; gap: 8px; transition: all 0.2s; }
    #tm-user-progress-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(16, 185, 129, 0.6); }
    #tm-user-progress-panel { position: fixed; left: 24px; bottom: 80px; z-index: 99998; width: 1100px; max-height: 85vh; background: #fff; border-radius: 16px; box-shadow: 0 8px 40px rgba(0, 0, 0, 0.15); display: none; flex-direction: column; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    #tm-user-progress-panel.show { display: flex; }

    .tm-user-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #fff; }
    .tm-user-header-left { display: flex; align-items: center; gap: 16px; }
    .tm-user-header h3 { margin: 0; font-size: 16px; font-weight: 600; }
    .tm-window-select { background: rgba(255, 255, 255, 0.2); color: #fff; border: 1px solid rgba(255, 255, 255, 0.4); border-radius: 6px; padding: 4px 8px; font-size: 12px; font-weight: 600; outline: none; cursor: pointer; transition: all 0.2s; }
    .tm-window-select:hover { background: rgba(255, 255, 255, 0.3); }
    .tm-window-select option { color: #333; background: #fff; }

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

    .tm-user-table th, .tm-user-table td { padding: 8px 6px; text-align: center; border-bottom: 1px solid #f0f0f0; color: #333; white-space: nowrap; }
    .tm-user-table th:first-child, .tm-user-table td:first-child { text-align: left; }
    .tm-user-table th { position: sticky; top: 0; background: #f8f9fa; color: #666; border-bottom: 2px solid #e9ecef; white-space: nowrap; z-index: 2;}

    .rate-box { display: flex; flex-direction: column; align-items: center; line-height: 1.2; }
    .rate-pct { font-weight: 700; font-size: 13px; }
    .rate-detail { font-size: 10px; color: #888; margin-top: 2px; }

    /* 底部按钮栏生态排版 */
    .tm-btn-footer-group { display: flex; gap: 12px; padding: 0 20px 16px; }
    .tm-user-copy-btn { flex: 1; margin: 0; padding: 10px; border: 1px solid #ddd; border-radius: 8px; background: #fff; cursor: pointer; font-size: 13px; font-weight: 600; color: #555; text-align: center; transition: all 0.2s;}
    .tm-user-copy-btn:hover { background: #f0f0f0; border-color: #ccc; }
    #tm-user-export-btn { background: #f0fdf4; color: #16a34a; border-color: #bbf7d0; }
    #tm-user-export-btn:hover { background: #dcfce7; border-color: #86efac; }
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
      <div class="tm-user-header">
        <div class="tm-user-header-left">
          <h3>🧑‍💻 人员进度质量汇总</h3>
          <select class="tm-window-select" id="tm-window-select">
            <option value="0">📊 考核范围: 历史全量数据</option>
            <option value="1">⏳ 考核范围: 近24h 1天 实时产出</option>
            <option value="3">⏳ 考核范围: 近 3 天 短期绩效</option>
            <option value="7">📅 考核范围: 近 7 天 周汇报绩效</option>
            <option value="14">📅 考核范围: 近 14 天 长期绩效</option>
          </select>
        </div>
        <button class="tm-user-close">✕</button>
      </div>
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
      <div class="tm-btn-footer-group">
        <button class="tm-user-copy-btn" id="tm-user-copy-btn" style="display:none;">📋 一键复制绩效结果 (智能粘贴)</button>
        <button class="tm-user-copy-btn" id="tm-user-export-btn" style="display:none;">📊 导出本地 Excel 账本 (.xls)</button>
      </div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('.tm-user-close').addEventListener('click', () => panel.classList.remove('show'));

    btn.addEventListener('click', () => {
      panel.classList.add('show');
      runAggregation();
    });

    panel.querySelector('#tm-window-select').addEventListener('change', (e) => {
      currentTimeWindowDays = parseInt(e.target.value, 10);
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
    const exportBtn = document.getElementById('tm-user-export-btn');

    summaryEl.style.display = 'none'; detailTitle.style.display = 'none'; detailWrap.style.display = 'none';
    copyBtn.style.display = 'none'; exportBtn.style.display = 'none';
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

      let labelText = currentTimeWindowDays === 1 ? '当天实时' : `近 ${currentTimeWindowDays} 天`;
      let filterTip = currentTimeWindowDays > 0 ? ` (已过滤历史过期包 ${result.filteredCount} 个)` : '';
      statusEl.textContent = `✅ 汇总完成！当前统计窗口: ${currentTimeWindowDays === 0 ? '全量历史' : labelText}${filterTip}`;
      summaryEl.style.display = 'grid'; detailTitle.style.display = 'block'; detailWrap.style.display = 'block';
      copyBtn.style.display = 'block'; exportBtn.style.display = 'block';
    } catch (err) {
      statusEl.textContent = `❌ 错误: ${err.message}`;
    }
  }

  function setupActionEvents() {
    if (window.tmUserEventsBound) return;
    window.tmUserEventsBound = true;

    document.addEventListener('click', (e) => {
      // 1. 处理智能解析复制逻辑
      if (e.target.id === 'tm-user-copy-btn') {
        if (!lastResult) return;

        // 升级为矩阵式制表符设计 (\t)，完美支持各大云端协作 Sheet 的多单元格一键切分粘贴
        let matrixText = "标注员\t总量\t已标注\t质检中\t验收中\t已驳回\t已完成\t质检通过率\t首次验收通过率\t累积折损通过率\n";

        const rows = document.querySelectorAll('#tm-user-detail-body tr');
        rows.forEach(row => {
          const cells = row.querySelectorAll('td');
          if (cells.length > 0 && cells[0].innerText !== '未分配') {
            let rowData = [];
            cells.forEach((cell, index) => {
              let text = cell.innerText.replace(/\n/g, ' '); // 洗掉换行
              rowData.push(text);
            });
            matrixText += rowData.join('\t') + '\n';
          }
        });

        navigator.clipboard.writeText(matrixText).then(() => {
          e.target.textContent = '✅ 矩阵格式已就绪，可去云文档直接 Ctrl+V！';
          setTimeout(() => { e.target.textContent = '📋 一键复制绩效结果 (智能粘贴)'; }, 2500);
        });
      }

      // 2. 处理硬核本地 Excel 导出逻辑
      if (e.target.id === 'tm-user-export-btn') {
        try {
          const originalTable = document.querySelector('.tm-user-table');
          if (!originalTable) return;

          // 克隆并做清洁清洗，防止 rate-box Flex 排版破坏 Excel 的单元格结构
          const cloneTable = originalTable.cloneNode(true);
          cloneTable.querySelectorAll('.rate-box').forEach(box => {
            const pct = box.querySelector('.rate-pct')?.innerText || '-';
            const detail = box.querySelector('.rate-detail')?.innerText || '';
            box.parentElement.innerHTML = `${pct} ${detail}`;
          });

          const timeLabels = { 0: "历史全量", 1: "当天实时", 3: "近3天", 7: "近7天周报", 14: "近14天" };
          const curLabel = timeLabels[currentTimeWindowDays] || "绩效战报";

          const worksheetHtml = `
            <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
            <head><meta charset="utf-8"></head>
            <body>${cloneTable.outerHTML}</body>
            </html>
          `;

          const blob = new Blob([worksheetHtml], { type: 'application/vnd.ms-excel;charset=utf-8;' });
          const downloadUrl = URL.createObjectURL(blob);
          const anchor = document.createElement('a');

          anchor.href = downloadUrl;
          anchor.download = `标注团队绩效明细表_${curLabel}_${new Date().toLocaleDateString('zh-CN')}.xls`;
          anchor.click();
          URL.revokeObjectURL(downloadUrl);
        } catch (err) {
          alert('导出失败: ' + err.message);
        }
      }
    });
  }

  function ensureUI() {
    const isProjectPage = /\/admin\/projects\/\d+/.test(location.pathname);
    if (isProjectPage && !document.getElementById('tm-user-progress-btn')) {
      injectStyles();
      createPanel();
      setupActionEvents();
    } else if (!isProjectPage && document.getElementById('tm-user-progress-btn')) {
      document.querySelectorAll('#tm-user-progress-btn, #tm-user-progress-panel, style[id^="tm-user-styles"]').forEach(el => el.remove());
    }
  }

  ensureUI();
  setInterval(ensureUI, 1500);

})();