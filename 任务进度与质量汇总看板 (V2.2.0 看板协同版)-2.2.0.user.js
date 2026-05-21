// ==UserScript==
// @name         任务进度与质量汇总看板 (V2.2.0 看板协同版)
// @namespace    https://label.yourcompany.com/
// @version      2.2.0
// @description  按 vendor_id 唯一标识进行汇总。拆分“质检中”与“验收中”，并引入质量双核监控。支持时间滑窗、按序号自然排序，一键下载本地 Excel 及腾讯协作云文档矩阵粘贴。
// @author       PM_Author
// @match        https://label.yourcompany.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    PAGE_SIZE: 50,
  };

  const STATUS_MAP = {
    'pending': '待处理',
    'annotating': '标注中',
    'submitted': '验收中',
    'quality_check': '质检中',
    'rejected': '已驳回',
    'approved': '已完成'
  };

  // 全局存储当前大盘选择的时间窗口（默认0代表看全部）
  let currentLogWindowDays = 0;

  // ==================== 工具函数 ====================

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

  async function aggregateProgress(onProgress) {
    const projectId = getProjectId();
    if (!projectId) throw new Error('无法从 URL 中提取 project_id');

    let pageId = 1;
    let allBatches = [];
    let hasMore = true;

    while (hasMore) {
      onProgress?.(`正在获取批次列表第 ${pageId} 页...`);
      const url = `/api/v1/admin/projects/${projectId}/data/batches?page=${pageId}&page_size=${CONFIG.PAGE_SIZE}`;
      const res = await get(url);

      if (res.code !== 0) throw new Error(`获取列表失败: ${res.msg}`);

      const items = res.data?.items || [];
      allBatches.push(...items);

      if (items.length < CONFIG.PAGE_SIZE) hasMore = false;
      else pageId++;
    }

    onProgress?.(`共拉取到 ${allBatches.length} 个批次，正在动态执行大盘时间滑窗硬清洗...`);

    const summary = {
      total_num: 0, labeled_num: 0,
      qa_checking_num: 0, accepting_num: 0,
      rejected_num: 0, finished_num: 0,
      supplierSummary: {},
      idToNameMap: {}
    };

    const details = [];
    let filteredCount = 0;

    for (const item of allBatches) {
      // 【大盘时间滑窗拦截器】
      if (currentLogWindowDays > 0) {
        const updateTimeStr = item.updated_at;
        if (updateTimeStr) {
          const updateTime = new Date(updateTimeStr).getTime();
          const now = Date.now();
          const milesecondsThreshold = currentLogWindowDays * 24 * 60 * 60 * 1000;

          if (now - updateTime > milesecondsThreshold) {
            filteredCount++;
            continue;
          }
        }
      }

      const vendorId = item.vendor_id || (item.assignee ? `user_${item.assignee}` : "unassigned");
      const vendorName = item.vendor_name || (item.assignee ? `个人: ${item.assignee}` : "内部团队/未分配");

      if (!summary.idToNameMap[vendorId]) {
        summary.idToNameMap[vendorId] = vendorName;
      }

      const taskName = item.name || `批次 ${item.id}`;
      const total = item.total_count || 0;
      const completed = item.completed_count || 0;
      const status = item.status || '';
      const statusCn = STATUS_MAP[status] || status;
      const reason = item.rejected_reason || '';

      let finished = 0, qa_checking = 0, accepting = 0, rejected = 0;
      if (status === 'approved') finished = total;
      else if (status === 'quality_check') qa_checking = total;
      else if (status === 'submitted') accepting = total;
      else if (status === 'rejected') rejected = total;

      // 【质量提取逻辑】严格锁定母包历史快照，防止衍生碎包稀释
      let qaC = 0, qaT = 0;
      let accC = 0, accT = 0;
      let isOrigin = !item.parent_batch_id;

      if (isOrigin) {
        const qaMatchC = reason.match(/\[质检统计\].*?正确:\s*(\d+)/);
        const qaMatchE = reason.match(/\[质检统计\].*?错误:\s*(\d+)/);
        const accMatchC = reason.match(/\[验收统计\].*?正确:\s*(\d+)/);
        const accMatchE = reason.match(/\[验收统计\].*?错误:\s*(\d+)/);

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
          accC = c; accT = c + e;
        } else if (status === 'approved') {
          accC = total; accT = total;
        }
      }

      summary.total_num += total;
      summary.labeled_num += completed;
      summary.qa_checking_num += qa_checking;
      summary.accepting_num += accepting;
      summary.rejected_num += rejected;
      summary.finished_num += finished;

      if (!summary.supplierSummary[vendorId]) {
        summary.supplierSummary[vendorId] = {
            total_num: 0, labeled_num: 0,
            qa_checking_num: 0, accepting_num: 0,
            rejected_num: 0, finished_num: 0
        };
      }
      const s = summary.supplierSummary[vendorId];
      s.total_num += total;
      s.labeled_num += completed;
      s.qa_checking_num += qa_checking;
      s.accepting_num += accepting;
      s.rejected_num += rejected;
      s.finished_num += finished;

      details.push({
        taskName, vendorId,
        supplierName: vendorName,
        total_num: total, labeled_num: completed,
        qa_checking_num: qa_checking, accepting_num: accepting,
        rejected_num: rejected, finished_num: finished, statusCn,
        qa_correct: qaC, qa_total: qaT,
        acc_correct: accC, acc_total: accT,
        isOrigin
      });
    }

    // 任务序号自然升序排序
    details.sort((a, b) => {
      const matchA = a.taskName.match(/\d+/);
      const matchB = b.taskName.match(/\d+/);
      if (matchA && matchB) {
        return parseInt(matchA[0], 10) - parseInt(matchB[0], 10);
      }
      return a.taskName.localeCompare(b.taskName, undefined, { numeric: true, sensitivity: 'base' });
    });

    return { tasks: details, summary, filteredCount };
  }

  // ==================== UI 代码 ====================

  const STYLES = `
    #tm-progress-btn { position: fixed; right: 24px; bottom: 24px; z-index: 99999; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; border: none; border-radius: 12px; padding: 12px 20px; font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); transition: all 0.3s ease; display: flex; align-items: center; gap: 8px; }
    #tm-progress-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6); }
    #tm-progress-btn.loading { opacity: 0.8; cursor: wait; }
    #tm-progress-panel { position: fixed; right: 24px; bottom: 80px; z-index: 99998; width: 960px; max-height: 85vh; background: #fff; border-radius: 16px; box-shadow: 0 8px 40px rgba(0, 0, 0, 0.15); display: none; flex-direction: column; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    #tm-progress-panel.show { display: flex; }

    .tm-panel-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; }
    .tm-panel-header-left { display: flex; align-items: center; gap: 16px; }
    .tm-panel-header h3 { margin: 0; font-size: 16px; font-weight: 600; }

    .tm-dapan-select { background: rgba(255, 255, 255, 0.2); color: #fff; border: 1px solid rgba(255, 255, 255, 0.4); border-radius: 6px; padding: 4px 8px; font-size: 12px; font-weight: 600; outline: none; cursor: pointer; transition: all 0.2s; }
    .tm-dapan-select:hover { background: rgba(255, 255, 255, 0.3); }
    .tm-dapan-select option { color: #333; background: #fff; }

    .tm-panel-close { background: rgba(255,255,255,0.2); border: none; color: #fff; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .tm-panel-status { padding: 12px 20px; font-size: 13px; color: #666; border-bottom: 1px solid #f0f0f0; background: #fafbfc; }

    .tm-summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; padding: 16px 20px; border-bottom: 1px solid #f0f0f0; }
    .tm-summary-card { background: #f8f9ff; border-radius: 10px; padding: 12px 14px; text-align: center; }
    .tm-summary-card .label { font-size: 12px; color: #888; margin-bottom: 6px; }
    .tm-summary-card .value { font-size: 20px; font-weight: 700; color: #333; }
    .tm-summary-card.supplier .value { color: #2563eb; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;}
    .tm-summary-card.total .value { color: #667eea; }
    .tm-summary-card.labeled .value { color: #f59e0b; }
    .tm-summary-card.qa .value { color: #3b82f6; }
    .tm-summary-card.accepting .value { color: #8b5cf6; }
    .tm-summary-card.finished .value { color: #10b981; }

    .tm-detail-section { padding: 12px 20px 8px; font-size: 13px; font-weight: 600; color: #555; background: #fafbfc; border-bottom: 1px solid #f0f0f0; }
    .tm-detail-table-wrap { overflow-y: auto; padding: 0 20px 16px; }

    .tm-detail-table { width: 100%; border-collapse: collapse; font-size: 12px; table-layout: fixed; }
    .tm-detail-table th, .tm-detail-table td { padding: 8px 4px; text-align: center; border-bottom: 1px solid #f0f0f0; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .tm-detail-table th:first-child, .tm-detail-table td:first-child { text-align: left; width: 28%; }
    .tm-detail-table th:nth-child(n+2):nth-child(-n+7), .tm-detail-table td:nth-child(n+2):nth-child(-n+7) { width: 8.5%; }
    .tm-detail-table th:nth-child(8), .tm-detail-table td:nth-child(8),
    .tm-detail-table th:nth-child(9), .tm-detail-table td:nth-child(9) { width: 10.5%; font-weight: 600; }

    .tm-detail-table th { position: sticky; top: 0; background: #f8f9fa; color: #666; font-weight: 600; border-bottom: 2px solid #e9ecef; z-index: 2;}

    .rate-box { display: flex; flex-direction: column; align-items: center; line-height: 1.2; }
    .rate-txt { font-weight: 700; font-size: 12px; }
    .rate-sub { font-size: 10px; color: #999; display: block; margin-top: 1px; }

    .tm-status-tag { display: inline-block; padding: 2px 4px; border-radius: 4px; font-size: 10px; font-weight: 500; background: #e0e7ff; color: #4f46e5; margin-left: 4px; vertical-align: middle;}
    .tm-status-tag.approved { background: #dcfce7; color: #16a34a; }
    .tm-status-tag.rejected { background: #fee2e2; color: #dc2626; }
    .tm-status-tag.pending { background: #f3f4f6; color: #6b7280; }

    /* 底部复合演进功能栏 */
    .tm-footer-actions-group { display: flex; gap: 12px; padding: 0 20px 16px; }
    .tm-copy-btn { flex: 1; margin: 0; padding: 10px; border: 1px solid #ddd; border-radius: 8px; background: #fff; cursor: pointer; font-size: 13px; font-weight: 600; color: #555; text-align: center; transition: all 0.2s;}
    .tm-copy-btn:hover { background: #f0f0f0; border-color: #ccc; }
    #tm-export-btn { background: #f0fdf4; color: #16a34a; border-color: #bbf7d0; }
    #tm-export-btn:hover { background: #dcfce7; border-color: #86efac; }
  `;

  function formatNum(n) { return n.toLocaleString('zh-CN'); }

  function getStatusClass(statusCn) {
    if (statusCn === '已完成') return 'approved';
    if (statusCn === '已驳回') return 'rejected';
    if (statusCn === '待处理') return 'pending';
    return '';
  }

  function genRateCellHtml(correct, total, color) {
    if (total === 0) return `<td><span style="color:#aaa;">-</span></td>`;
    const pct = (correct / total * 100).toFixed(1) + '%';
    return `<td>
      <div class="rate-box">
        <span class="rate-txt" style="color:${color};">${pct}</span>
        <span class="rate-sub">(${correct}/${total})</span>
      </div>
    </td>`;
  }

  function createPanel() {
    if (document.getElementById('tm-progress-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'tm-progress-btn';
    btn.innerHTML = '<span class="icon">📊</span><span>任务进度质量汇总</span>';
    document.body.appendChild(btn);

    const panel = document.createElement('div');
    panel.id = 'tm-progress-panel';
    panel.innerHTML = `
      <div class="tm-panel-header">
        <div class="tm-panel-header-left">
          <h3>📊 任务进度质量汇总</h3>
          <select class="tm-dapan-select" id="tm-dapan-select">
            <option value="0">📦 统计范围: 历史全量批次</option>
            <option value="1">⏳ 统计范围: 当天24h 实时变动</option>
            <option value="3">⏳ 统计范围: 近 3 天 变动批次</option>
            <option value="7">📅 统计范围: 近 7 天 周报标准</option>
            <option value="14">📅 统计范围: 近 14 天 变动批次</option>
          </select>
        </div>
        <button class="tm-panel-close">✕</button>
      </div>
      <div class="tm-panel-status" id="tm-status">点击按钮开始汇总</div>
      <div class="tm-summary-grid" id="tm-summary" style="display:none;"></div>

      <div class="tm-detail-section" id="tm-supplier-title" style="display:none;">🏢 团队拆解</div>
      <div class="tm-detail-table-wrap" id="tm-supplier-wrap" style="display:none; min-height: 110px; max-height: 180px; margin-bottom: 10px;">
        <table class="tm-detail-table">
          <thead><tr><th>归属团队名称</th><th>总量</th><th>已标注</th><th>质检中</th><th>验收中</th><th>已驳回</th><th>已完成</th></tr></thead>
          <tbody id="tm-supplier-body"></tbody>
        </table>
      </div>

      <div class="tm-detail-section" id="tm-detail-title" style="display:none;">📋 各批次明细 (基于原始母包统计首次质量)</div>
      <div class="tm-detail-table-wrap" id="tm-detail-wrap" style="display:none; flex: 1;">
        <table class="tm-detail-table">
          <thead><tr><th>批次名称</th><th>总量</th><th>已标注</th><th>质检中</th><th>验收中</th><th>已驳回</th><th>已完成</th><th>🛡️首次质检</th><th>🎯首次验收</th></tr></thead>
          <tbody id="tm-detail-body"></tbody>
        </table>
      </div>
      <div class="tm-footer-actions-group">
        <button class="tm-copy-btn" id="tm-copy-btn" style="display:none;">📋 一键复制汇总结果 (智能粘贴)</button>
        <button class="tm-copy-btn" id="tm-export-btn" style="display:none;">📊 导出本地 Excel 账本 (.xls)</button>
      </div>
    `;
    document.body.appendChild(panel);
    panel.querySelector('.tm-panel-close').addEventListener('click', () => panel.classList.remove('show'));

    btn.addEventListener('click', () => {
      panel.classList.toggle('show');
      if (panel.classList.contains('show') && !btn.classList.contains('loading')) runAggregation();
    });

    panel.querySelector('#tm-dapan-select').addEventListener('change', (e) => {
      currentLogWindowDays = parseInt(e.target.value, 10);
      runAggregation();
    });
  }

  let lastResult = null;

  async function runAggregation() {
    const btn = document.getElementById('tm-progress-btn');
    const statusEl = document.getElementById('tm-status');
    const summaryEl = document.getElementById('tm-summary');
    const supTitle = document.getElementById('tm-supplier-title');
    const supWrap = document.getElementById('tm-supplier-wrap');
    const supBody = document.getElementById('tm-supplier-body');
    const detailTitle = document.getElementById('tm-detail-title');
    const detailWrap = document.getElementById('tm-detail-wrap');
    const detailBody = document.getElementById('tm-detail-body');
    const copyBtn = document.getElementById('tm-copy-btn');
    const exportBtn = document.getElementById('tm-export-btn');

    btn.classList.add('loading'); btn.innerHTML = '<span class="icon">⏳</span><span>查询中...</span>';

    summaryEl.style.display = 'none';
    supTitle.style.display = 'none'; supWrap.style.display = 'none';
    detailTitle.style.display = 'none'; detailWrap.style.display = 'none';
    copyBtn.style.display = 'none'; exportBtn.style.display = 'none';

    detailBody.innerHTML = ''; supBody.innerHTML = '';

    try {
      const result = await aggregateProgress((msg) => { statusEl.textContent = msg; });
      lastResult = result;

      result.tasks.forEach(p => {
        const tr = document.createElement('tr');

        const qaCellHtml = genRateCellHtml(p.qa_correct, p.qa_total, '#3b82f6');
        const accCellHtml = genRateCellHtml(p.acc_correct, p.acc_total, '#059669');
        const prefix = p.isOrigin ? '' : '<span style="color:#f59e0b; font-size:10px;">[拆分包]</span><br/>';

        tr.innerHTML = `
          <td title="${p.taskName}"><span style="color:#888; font-size:10px;">[${p.supplierName}]</span><br/>${prefix}${p.taskName}<span class="tm-status-tag ${getStatusClass(p.statusCn)}">${p.statusCn}</span></td>
          <td style="color:#667eea;">${formatNum(p.total_num)}</td>
          <td>${formatNum(p.labeled_num)}</td>
          <td>${formatNum(p.qa_checking_num)}</td>
          <td style="color:#8b5cf6; font-weight: 600;">${formatNum(p.accepting_num)}</td>
          <td style="color: #dc2626;">${formatNum(p.rejected_num)}</td>
          <td style="color:#10b981;">${formatNum(p.finished_num)}</td>
          ${qaCellHtml}
          ${accCellHtml}
        `;
        detailBody.appendChild(tr);
      });

      let supHtml = '';
      const sortedIds = Object.entries(result.summary.supplierSummary).sort((a, b) => b[1].total_num - a[1].total_num);

      if (sortedIds.length === 0) {
        supHtml = '<tr><td colspan="9" style="text-align:center; color:#999; padding: 16px;">所选时间窗口内无流转数据</td></tr>';
      } else {
        sortedIds.forEach(([vId, stats]) => {
          const displayName = result.summary.idToNameMap[vId];
          supHtml += `
            <tr>
              <td title="${displayName}"><b>${displayName}</b></td>
              <td style="color:#667eea;">${formatNum(stats.total_num)}</td>
              <td>${formatNum(stats.labeled_num)}</td>
              <td>${formatNum(stats.qa_checking_num)}</td>
              <td style="color:#8b5cf6; font-weight: 600;">${formatNum(stats.accepting_num)}</td>
              <td style="color:#dc2626;">${formatNum(stats.rejected_num)}</td>
              <td style="color:#10b981;">${formatNum(stats.finished_num)}</td>
            </tr>
          `;
        });
      }
      supBody.innerHTML = supHtml;

      const s = result.summary;
      const validNames = Object.values(s.idToNameMap).filter(n => !n.includes('内部团队') && !n.includes('个人:'));
      let supText = validNames.length > 0 ? (validNames.length === 1 ? validNames[0] : `${validNames.length} 支团队`) : '仅内部团队';

      summaryEl.innerHTML = `
        <div class="tm-summary-card supplier" title="${validNames.join('、')}"><div class="label">🏢 标注团队</div><div class="value">${supText}</div></div>
        <div class="tm-summary-card total"><div class="label">📦 总量</div><div class="value">${formatNum(s.total_num)}</div></div>
        <div class="tm-summary-card labeled"><div class="label">🏷️ 已标注</div><div class="value">${formatNum(s.labeled_num)}</div></div>
        <div class="tm-summary-card qa"><div class="label">🛡️ 质检中</div><div class="value">${formatNum(s.qa_checking_num)}</div></div>
        <div class="tm-summary-card accepting"><div class="label">🎯 验收中</div><div class="value">${formatNum(s.accepting_num)}</div></div>
        <div class="tm-summary-card finished"><div class="label">✅ 已完成</div><div class="value">${formatNum(s.finished_num)}</div></div>
      `;

      summaryEl.style.display = 'grid';
      supTitle.style.display = 'block'; supWrap.style.display = 'block';
      detailTitle.style.display = 'block'; detailWrap.style.display = 'block';
      copyBtn.style.display = 'block'; exportBtn.style.display = 'block';

      let rangeText = currentLogWindowDays === 0 ? '历史全量' : (currentLogWindowDays === 1 ? '当天实时' : `近 ${currentLogWindowDays} 天`);
      let filterTip = currentLogWindowDays > 0 ? ` (已隐藏非近期活动批次 ${result.filteredCount} 个)` : '';
      statusEl.textContent = `✅ 汇总完成！当前统计窗口: ${rangeText}${filterTip}`;

    } catch (err) { statusEl.textContent = `❌ 出错了: ${err.message}`; }
    finally { btn.classList.remove('loading'); btn.innerHTML = '<span class="icon">📊</span><span>任务进度质量汇总</span>'; }
  }

  function ensureUI() {
    const isProjectPage = /\/admin\/projects\/\d+/.test(location.pathname);
    if (isProjectPage && !document.getElementById('tm-progress-btn')) {
      if (!document.getElementById('tm-artrefine-styles')) {
        const style = document.createElement('style'); style.id = 'tm-artrefine-styles'; style.textContent = STYLES; document.head.appendChild(style);
      }
      createPanel();
      if (!window.tmCopyBound) {
        window.tmCopyBound = true;
        document.addEventListener('click', (e) => {

          // 1. 处理矩阵化剪贴板复制逻辑（无损直贴腾讯云文档）
          if (e.target.id === 'tm-copy-btn') {
            if (!lastResult) return;

            let matrixChunk = "归属团队/批次名称\t任务总量\t已标注数\t质检中数\t验收中数\t已驳回数\t已完成数\t首次质检直通率\t首次验收直通率\n";

            const rows = document.querySelectorAll('#tm-detail-body tr');
            rows.forEach(row => {
              const cells = row.querySelectorAll('td');
              if (cells.length > 0) {
                let rowData = [];
                cells.forEach((cell, idx) => {
                  let cleaned = cell.innerText.replace(/\n/g, ' '); // 替换内部干扰换行
                  rowData.push(cleaned);
                });
                matrixChunk += rowData.join('\t') + '\n';
              }
            });

            navigator.clipboard.writeText(matrixChunk).then(() => {
              e.target.textContent = '✅ 表格矩阵已格式化，可去云文档一键 Ctrl+V！';
              setTimeout(() => e.target.textContent = '📋 一键矩阵复制结果 (云文档直贴)', 2500);
            });
          }

          // 2. 处理纯本地硬核大盘 Excel 导出 (.xls XML 字节流封装)
          if (e.target.id === 'tm-export-btn') {
            try {
              const dapanTable = document.querySelector('#tm-detail-wrap table');
              const supplierTable = document.querySelector('#tm-supplier-wrap table');
              if (!dapanTable) return;

              // 清洗 Flex 布局盒子，适配 Excel 扁平化数据网格结构
              const cloneDapan = dapanTable.cloneNode(true);
              cloneDapan.querySelectorAll('.rate-box').forEach(box => {
                const txt = box.querySelector('.rate-txt')?.innerText || '-';
                const sub = box.querySelector('.rate-sub')?.innerText || '';
                box.parentElement.innerHTML = `${txt} ${sub}`;
              });

              const timeLabels = { 0: "历史全量", 1: "当天实时", 3: "近3天", 7: "近7天周报", 14: "近14天" };
              const curLabel = timeLabels[currentLogWindowDays] || "大盘大底";

              const combinedExcelHtml = `
                <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
                <head><meta charset="utf-8"></head>
                <body>
                  <h2>📋 大盘明细概览 (${curLabel})</h2>
                  ${cloneDapan.outerHTML}
                  <br/><hr/><br/>
                  <h2>🏢 归属外包团队汇总明细</h2>
                  ${supplierTable ? supplierTable.outerHTML : '暂无团队数据'}
                </body>
                </html>
              `;

              const blob = new Blob([combinedExcelHtml], { type: 'application/vnd.ms-excel;charset=utf-8;' });
              const downloadUrl = URL.createObjectURL(blob);
              const anchor = document.createElement('a');

              anchor.href = downloadUrl;
              anchor.download = `项目大盘进度与质量统计表_${curLabel}_${new Date().toLocaleDateString('zh-CN')}.xls`;
              anchor.click();
              URL.revokeObjectURL(downloadUrl);
            } catch (err) {
              alert('账本导出失败: ' + err.message);
            }
          }

        });
      }
    } else if (!isProjectPage && document.getElementById('tm-progress-btn')) {
      document.querySelectorAll('#tm-progress-btn, #tm-progress-panel').forEach(el => el.remove());
    }
  }

  setInterval(ensureUI, 1500); ensureUI();
})();