// ==UserScript==
// @name         数据标注系统 任务进度与质量汇总器
// @namespace    https://label.your-company.com/
// @version      2.0.0
// @description  按 vendor_id 唯一标识进行汇总，将“审核中”精细拆分为“质检中”与“验收中”，并引入原始批次的首次直通率（质检与验收）监控。
// @author       PM_Author
// @match        https://label.your-company.com/*
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

    onProgress?.(`共拉取到 ${allBatches.length} 个批次，正在进行全量质量双核汇总...`);

    const summary = {
      total_num: 0, labeled_num: 0,
      qa_checking_num: 0, accepting_num: 0,
      rejected_num: 0, finished_num: 0,
      supplierSummary: {},
      idToNameMap: {}
    };

    const details = [];

    for (const item of allBatches) {
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

      // 总盘进度累加
      summary.total_num += total;
      summary.labeled_num += completed;
      summary.qa_checking_num += qa_checking;
      summary.accepting_num += accepting;
      summary.rejected_num += rejected;
      summary.finished_num += finished;

      // 按供应商分类汇总
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

    return { tasks: details, summary };
  }

  // ==================== UI 代码 ====================

  const STYLES = `
    #tm-progress-btn { position: fixed; right: 24px; bottom: 24px; z-index: 99999; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; border: none; border-radius: 12px; padding: 12px 20px; font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); transition: all 0.3s ease; display: flex; align-items: center; gap: 8px; }
    #tm-progress-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6); }
    #tm-progress-btn.loading { opacity: 0.8; cursor: wait; }
    #tm-progress-panel { position: fixed; right: 24px; bottom: 80px; z-index: 99998; width: 960px; max-height: 85vh; background: #fff; border-radius: 16px; box-shadow: 0 8px 40px rgba(0, 0, 0, 0.15); display: none; flex-direction: column; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    #tm-progress-panel.show { display: flex; }
    .tm-panel-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; }
    .tm-panel-header h3 { margin: 0; font-size: 16px; font-weight: 600; }
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

    /* 优化列宽：第一列名称列占28%，2至7列(基础进度)各占8.5%，最后两列质量通过率各占10.5% */
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
    .tm-copy-btn { margin: 0 20px 16px; padding: 8px; border: 1px solid #ddd; border-radius: 8px; background: #fff; cursor: pointer; font-size: 13px; color: #555; text-align: center; transition: all 0.2s;}
    .tm-copy-btn:hover { background: #f0f0f0; }
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
      <div class="tm-panel-header"><h3>📊 任务进度质量汇总</h3><button class="tm-panel-close">✕</button></div>
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
      <button class="tm-copy-btn" id="tm-copy-btn" style="display:none;">📋 复制汇总结果(含质量得分)</button>
    `;
    document.body.appendChild(panel);
    panel.querySelector('.tm-panel-close').addEventListener('click', () => panel.classList.remove('show'));
    btn.addEventListener('click', () => {
      panel.classList.toggle('show');
      if (panel.classList.contains('show') && !btn.classList.contains('loading')) runAggregation();
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

    btn.classList.add('loading'); btn.innerHTML = '<span class="icon">⏳</span><span>查询中...</span>';

    summaryEl.style.display = 'none';
    supTitle.style.display = 'none'; supWrap.style.display = 'none';
    detailTitle.style.display = 'none'; detailWrap.style.display = 'none';
    copyBtn.style.display = 'none';

    detailBody.innerHTML = ''; supBody.innerHTML = '';

    try {
      const result = await aggregateProgress((msg) => { statusEl.textContent = msg; });
      lastResult = result;

      // 1. 渲染各批次明细
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

      // 2. 渲染团队拆解表
      let supHtml = '';
      const sortedIds = Object.entries(result.summary.supplierSummary).sort((a, b) => b[1].total_num - a[1].total_num);

      if (sortedIds.length === 0) {
        supHtml = '<tr><td colspan="7" style="text-align:center; color:#999; padding: 16px;">未获取到团队数据</td></tr>';
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

      // 3. 渲染大盘卡片
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
      copyBtn.style.display = 'block';

      statusEl.textContent = `✅ 完成！共汇总 ${result.tasks.length} 个批次，原始母包已完成首验质量剥离并按任务序号升序重排`;

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
          if (e.target.id === 'tm-copy-btn') {
            if (!lastResult) return;
            const s = lastResult.summary;
            let lines = [`项目进度与质量看板（共 ${lastResult.tasks.length} 个批次）`,`————————————————`,`📦 总量: ${formatNum(s.total_num)}`,`🏷️ 已标: ${formatNum(s.labeled_num)}`,`🛡️ 质检中: ${formatNum(s.qa_checking_num)}`,`🎯 验收中: ${formatNum(s.accepting_num)}`,`❌ 驳回: ${formatNum(s.rejected_num)}`,`✅ 完成: ${formatNum(s.finished_num)}`,`————————————————`,`\n📋 核心批次质量明细：`];

            lastResult.tasks.forEach(t => {
              const qaStr = t.qa_total > 0 ? (t.qa_correct / t.qa_total * 100).toFixed(1) + '%' : '-';
              const accStr = t.acc_total > 0 ? (t.acc_correct / t.acc_total * 100).toFixed(1) + '%' : '-';
              const flag = t.isOrigin ? '[原始包]' : '[拆分包]';
              lines.push(`- ${t.taskName} ${flag} | 状态: ${t.statusCn} | 总量: ${t.total_num} | 首次质检: ${qaStr} | 首次验收: ${accStr}`);
            });

            navigator.clipboard.writeText(lines.join('\n')).then(() => { e.target.textContent = '✅ 已复制含质量大盘的信息！'; setTimeout(() => e.target.textContent = '📋 复制汇总结果(含质量得分)', 2000); });
          }
        });
      }
    } else if (!isProjectPage && document.getElementById('tm-progress-btn')) {
      document.querySelectorAll('#tm-progress-btn, #tm-progress-panel').forEach(el => el.remove());
    }
  }

  setInterval(ensureUI, 1500); ensureUI();
})();