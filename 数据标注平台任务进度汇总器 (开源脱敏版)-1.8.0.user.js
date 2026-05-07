// ==UserScript==
// @name         数据标注平台任务进度汇总器 (开源脱敏版)
// @namespace    https://github.com/yourusername
// @version      1.8.0
// @description  按 vendor_id 唯一标识进行汇总，上下表格对齐，增加供列表固定显示高度
// @author       Your Name
// @match        https://*.your-company-domain.com/* // [TODO: 请修改为你们实际的标注系统业务域名]
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // [TODO: 根据实际后台 API 路径进行调整]
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

  async function aggregateProgress(onProgress, onDetail) {
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

    onProgress?.(`共拉取到 ${allBatches.length} 个批次，正在进行工业化汇总...`);

    const summary = {
      total_num: 0, labeled_num: 0, wait_label_num: 0,
      deliver_reviewing_num: 0, rejected_num: 0, finished_num: 0,
      supplierSummary: {}, // 按 vendor_id 存储
      idToNameMap: {}      // 存储 ID 到 名字 的映射关系
    };

    const details = [];

    for (const item of allBatches) {
      // 1. 确定唯一标识 ID
      const vendorId = item.vendor_id || (item.assignee ? `user_${item.assignee}` : "unassigned");

      // 2. 确定展示名字并更新映射表
      const vendorName = item.vendor_name || (item.assignee ? `个人: ${item.assignee}` : "内部团队/未分配");
      if (!summary.idToNameMap[vendorId]) {
        summary.idToNameMap[vendorId] = vendorName;
      }

      const taskName = item.name || `批次 ${item.id}`;
      const total = item.total_count || 0;
      const completed = item.completed_count || 0;
      const status = item.status || '';
      const statusCn = STATUS_MAP[status] || status;

      let finished = 0, reviewing = 0, rejected = 0;
      if (status === 'approved') finished = total;
      else if (status === 'submitted' || status === 'quality_check') reviewing = total;
      else if (status === 'rejected') rejected = total;

      const labeled = completed;
      const wait_label = total - completed;

      // 总盘累加
      summary.total_num += total;
      summary.labeled_num += labeled;
      summary.wait_label_num += wait_label;
      summary.deliver_reviewing_num += reviewing;
      summary.rejected_num += rejected;
      summary.finished_num += finished;

      // 按供应商 ID 进行分类汇总
      if (!summary.supplierSummary[vendorId]) {
        summary.supplierSummary[vendorId] = {
            total_num: 0, labeled_num: 0, wait_label_num: 0,
            deliver_reviewing_num: 0, rejected_num: 0, finished_num: 0
        };
      }
      const s = summary.supplierSummary[vendorId];
      s.total_num += total;
      s.labeled_num += labeled;
      s.wait_label_num += wait_label;
      s.deliver_reviewing_num += reviewing;
      s.rejected_num += rejected;
      s.finished_num += finished;

      details.push({
        taskName, vendorId,
        supplierName: vendorName,
        total_num: total, labeled_num: labeled, wait_label_num: wait_label,
        deliver_reviewing_num: reviewing, rejected_num: rejected,
        finished_num: finished, statusCn: statusCn
      });
    }

    return { tasks: details, summary };
  }

  // ==================== UI 代码 ====================

  const STYLES = `
    #tm-progress-btn { position: fixed; right: 24px; bottom: 24px; z-index: 99999; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; border: none; border-radius: 12px; padding: 12px 20px; font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); transition: all 0.3s ease; display: flex; align-items: center; gap: 8px; }
    #tm-progress-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6); }
    #tm-progress-btn.loading { opacity: 0.8; cursor: wait; }
    #tm-progress-panel { position: fixed; right: 24px; bottom: 80px; z-index: 99998; width: 760px; max-height: 85vh; background: #fff; border-radius: 16px; box-shadow: 0 8px 40px rgba(0, 0, 0, 0.15); display: none; flex-direction: column; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
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
    .tm-summary-card.reviewing .value { color: #8b5cf6; }
    .tm-summary-card.finished .value { color: #10b981; }
    .tm-summary-card.waiting .value { color: #ef4444; }

    .tm-detail-section { padding: 12px 20px 8px; font-size: 13px; font-weight: 600; color: #555; background: #fafbfc; border-bottom: 1px solid #f0f0f0; }

    .tm-detail-table-wrap { overflow-y: auto; padding: 0 20px 16px; }

    /* 核心修复：强迫症级表格对齐 */
    .tm-detail-table { width: 100%; border-collapse: collapse; font-size: 12px; table-layout: fixed; }
    .tm-detail-table th, .tm-detail-table td { padding: 8px 6px; text-align: center; border-bottom: 1px solid #f0f0f0; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    /* 第1列：名字，占40% */
    .tm-detail-table th:first-child, .tm-detail-table td:first-child { text-align: left; width: 40%; }
    /* 后6列数字：各占10% (共60%) */
    .tm-detail-table th:nth-child(n+2), .tm-detail-table td:nth-child(n+2) { width: 10%; }
    .tm-detail-table th { position: sticky; top: 0; background: #f8f9fa; color: #666; font-weight: 600; border-bottom: 2px solid #e9ecef; }

    .tm-status-tag { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 500; background: #e0e7ff; color: #4f46e5; margin-left: 6px; vertical-align: middle;}
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

  function createPanel() {
    if (document.getElementById('tm-progress-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'tm-progress-btn';
    btn.innerHTML = '<span class="icon">📊</span><span>汇总进度</span>';
    document.body.appendChild(btn);

    const panel = document.createElement('div');
    panel.id = 'tm-progress-panel';
    panel.innerHTML = `
      <div class="tm-panel-header"><h3>📊 任务进度汇总</h3><button class="tm-panel-close">✕</button></div>
      <div class="tm-panel-status" id="tm-status">点击「汇总进度」按钮开始</div>
      <div class="tm-summary-grid" id="tm-summary" style="display:none;"></div>

      <div class="tm-detail-section" id="tm-supplier-title" style="display:none;">🏢 团队大盘拆解</div>
      <div class="tm-detail-table-wrap" id="tm-supplier-wrap" style="display:none; min-height: 130px; max-height: 200px; margin-bottom: 10px;">
        <table class="tm-detail-table">
          <thead><tr><th>归属团队名称</th><th>总量</th><th>已标注</th><th>待标注</th><th>审核中</th><th>已驳回</th><th>已完成</th></tr></thead>
          <tbody id="tm-supplier-body"></tbody>
        </table>
      </div>

      <div class="tm-detail-section" id="tm-detail-title" style="display:none;">📋 各批次明细</div>
      <div class="tm-detail-table-wrap" id="tm-detail-wrap" style="display:none; flex: 1;">
        <table class="tm-detail-table">
          <thead><tr><th>批次名称</th><th>总量</th><th>已标注</th><th>待标注</th><th>审核中</th><th>已驳回</th><th>已完成</th></tr></thead>
          <tbody id="tm-detail-body"></tbody>
        </table>
      </div>
      <button class="tm-copy-btn" id="tm-copy-btn" style="display:none;">📋 复制汇总结果</button>
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

    // 隐藏所有面板
    summaryEl.style.display = 'none';
    supTitle.style.display = 'none'; supWrap.style.display = 'none';
    detailTitle.style.display = 'none'; detailWrap.style.display = 'none';
    copyBtn.style.display = 'none';

    detailBody.innerHTML = ''; supBody.innerHTML = '';

    try {
      const result = await aggregateProgress((msg) => { statusEl.textContent = msg; });
      lastResult = result;

      // 1. 渲染明细表
      result.tasks.forEach(p => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td title="${p.taskName}"><span style="color:#888; font-size:10px;">[${p.supplierName}]</span><br/>${p.taskName}<span class="tm-status-tag ${getStatusClass(p.statusCn)}">${p.statusCn}</span></td>
          <td style="color:#667eea;">${formatNum(p.total_num)}</td>
          <td>${formatNum(p.labeled_num)}</td>
          <td>${formatNum(p.wait_label_num)}</td>
          <td>${formatNum(p.deliver_reviewing_num)}</td>
          <td style="color: #dc2626;">${formatNum(p.rejected_num)}</td>
          <td style="color:#10b981;">${formatNum(p.finished_num)}</td>
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
              <td>${formatNum(stats.wait_label_num)}</td>
              <td>${formatNum(stats.deliver_reviewing_num)}</td>
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
        <div class="tm-summary-card waiting"><div class="label">⏳ 待标注</div><div class="value">${formatNum(s.wait_label_num)}</div></div>
        <div class="tm-summary-card reviewing"><div class="label">🔍 审核中</div><div class="value">${formatNum(s.deliver_reviewing_num)}</div></div>
        <div class="tm-summary-card finished"><div class="label">✅ 已完成</div><div class="value">${formatNum(s.finished_num)}</div></div>
      `;

      statusEl.textContent = `✅ 完成！共汇总 ${result.tasks.length} 个批次`;

      summaryEl.style.display = 'grid';
      supTitle.style.display = 'block'; supWrap.style.display = 'block';
      detailTitle.style.display = 'block'; detailWrap.style.display = 'block';
      copyBtn.style.display = 'block';

    } catch (err) { statusEl.textContent = `❌ 出错了: ${err.message}`; }
    finally { btn.classList.remove('loading'); btn.innerHTML = '<span class="icon">📊</span><span>汇总进度</span>'; }
  }

  function ensureUI() {
    const isProjectPage = /\/admin\/projects\/\d+/.test(location.pathname);
    if (isProjectPage && !document.getElementById('tm-progress-btn')) {
      if (!document.getElementById('tm-custom-styles')) {
        const style = document.createElement('style'); style.id = 'tm-custom-styles'; style.textContent = STYLES; document.head.appendChild(style);
      }
      createPanel();
      if (!window.tmCopyBound) {
        window.tmCopyBound = true;
        document.addEventListener('click', (e) => {
          if (e.target.id === 'tm-copy-btn') {
            if (!lastResult) return;
            const s = lastResult.summary;
            let lines = [`项目进度汇总（共 ${lastResult.tasks.length} 个批次）`,`————————————————`,`📦 总量: ${formatNum(s.total_num)}`,`🏷️ 已标: ${formatNum(s.labeled_num)}`,`⏳ 待标: ${formatNum(s.wait_label_num)}`,`🔍 审核: ${formatNum(s.deliver_reviewing_num)}`,`❌ 驳回: ${formatNum(s.rejected_num)}`,`✅ 完成: ${formatNum(s.finished_num)}`,`————————————————`,`\n📊 团队维度拆解：`];
            Object.entries(s.supplierSummary).sort((a,b)=>b[1].total_num - a[1].total_num).forEach(([id, stats]) => {
              lines.push(`- ${s.idToNameMap[id]}: 总量 ${formatNum(stats.total_num)} | 已标 ${formatNum(stats.labeled_num)} | 待标 ${formatNum(stats.wait_label_num)} | 审核中 ${formatNum(stats.deliver_reviewing_num)} | 已驳回 ${formatNum(stats.rejected_num)} | 已完 ${formatNum(stats.finished_num)}`);
            });
            navigator.clipboard.writeText(lines.join('\n')).then(() => { e.target.textContent = '✅ 已复制汇总信息！'; setTimeout(() => e.target.textContent = '📋 复制汇总信息', 2000); });
          }
        });
      }
    } else if (!isProjectPage && document.getElementById('tm-progress-btn')) {
      document.querySelectorAll('#tm-progress-btn, #tm-progress-panel').forEach(el => el.remove());
    }
  }

  setInterval(ensureUI, 1500); ensureUI();
})();