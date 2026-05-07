// ==UserScript==
// @name         数据标注平台任务进度汇总器 (开源脱敏版)
// @namespace    https://github.com/yourusername
// @version      3.8.0
// @description  强制表格列宽对齐，增加拆解表固定显示高度，引入双层 ID 唯一映射架构，杜绝重名合并风险
// @author       Your Name
// @match        https://*.your-company-domain.com/project/* // [TODO: 请修改为你们实际的标注系统业务域名]
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // [TODO: 根据实际后台 API 路径进行调整]
  const CONFIG = {
    LIST_API: '/api/v1/taskflow/task/query/list',
    PROGRESS_API: '/api/v1/taskflow/task/stat_task_progress',
    SUPPLIER_API: '/api/v1/supplier/list_supplier',
    STAT_OBJECTS: ['total_num', 'labeled_num', 'deliver_reviewing_num', 'finished_num'],
    CONCURRENCY: 5,
    PAGE_SIZE: 50,
  };

  function getProjectId() {
    const match = location.pathname.match(/\/project\/(\d+)\//);
    return match ? match[1] : null;
  }

  async function post(url, body) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
      },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    return resp.json();
  }

  async function batchRequest(tasks, concurrency, fn) {
    const results = [];
    let index = 0;
    async function worker() {
      while (index < tasks.length) {
        const i = index++;
        try { results[i] = await fn(tasks[i], i); }
        catch (err) { results[i] = { error: err.message, task: tasks[i] }; }
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  async function fetchSupplierDict(projectId) {
    const dict = {};
    try {
      const res = await post(CONFIG.SUPPLIER_API, {
        page_id: 1, page_size: 100, project_id: [projectId]
      });
      if (res.code === 0 && res.data && res.data.items) {
        res.data.items.forEach(item => { dict[String(item.id)] = item.name; });
      }
    } catch (err) { console.warn("[标注平台] 获取动态字典失败", err); }
    return dict;
  }

  // 【核心】：ID 双轨映射引擎
  function getSupplierInfo(taskInfo, lt, dynamicDict) {
    const possibleSupIds = [
      lt.supplier_id, taskInfo.supplier_id, lt.company_id, taskInfo.company_id,
      ...(lt.supplier_ids || []), ...(taskInfo.supplier_ids || [])
    ];

    // 1. 优先查供应商
    for (const id of possibleSupIds) {
      if (!id || String(id) === "1" || String(id) === "0") continue;
      const strId = String(id);
      // [TODO: 如果你们系统有默认的无意义企业占位符，替换掉下面的 'XX公司']
      if (dynamicDict[strId] && dynamicDict[strId] !== 'XX公司') {
        return { id: `sup_${strId}`, name: dynamicDict[strId] };
      }
    }

    const possibleNames = [lt.supplier_name, taskInfo.supplier_name, taskInfo.company_name];
    for (const name of possibleNames) {
      if (name && name !== 'XX公司' && name !== '默认团队') {
         const validId = possibleSupIds.find(id => id && String(id) !== "1" && String(id) !== "0");
         if (validId) return { id: `sup_${validId}`, name: name };
      }
    }

    // 2. 穿透抓取 Team
    const teamId = lt.team_id || taskInfo.team_id;
    const teamName = lt.team_name || taskInfo.team_name;
    if (teamId && String(teamId) !== "0" && teamName && teamName !== '默认团队') {
      return { id: `team_${teamId}`, name: teamName };
    }

    return { id: "unassigned", name: "内部团队/未分配" };
  }

  async function fetchAllTaskIds(projectId, onProgress, supplierDict) {
    const allTasks = [];
    let pageId = 1;
    while (true) {
      onProgress?.(`正在获取任务列表第 ${pageId} 页...`);
      const res = await post(CONFIG.LIST_API, {
        task_creator: '', order_creator: '', import_task_id: '', supplier_id: '',
        task_status_list: [], order_task_id_list: [], team_id: null,
        submit: Date.now(), project_id: projectId, task_type: 2,
        page_id: pageId, page_size: CONFIG.PAGE_SIZE, task_id_list: [], task_name_list: [],
      });
      if (res.code !== 0) throw new Error(`获取列表失败: ${res.message}`);
      const taskInfoList = res.data?.task_info_list || [];
      if (taskInfoList.length === 0) break;
      for (const taskInfo of taskInfoList) {
        const labelTasks = taskInfo.label_task_list || [];
        for (const lt of labelTasks) {
          // 获取双轨 ID 信息
          const supInfo = getSupplierInfo(taskInfo, lt, supplierDict);

          allTasks.push({
            taskId: lt.task_id,
            taskName: lt.task_name,
            supplierId: supInfo.id,     // 存入唯一 ID
            supplierName: supInfo.name, // 存入展示名字
            projectTaskId: lt.project_task_id,
          });
        }
      }
      if (taskInfoList.length < CONFIG.PAGE_SIZE) break;
      pageId++;
    }
    return allTasks;
  }

  async function fetchTaskProgress(task, projectId) {
    const res = await post(CONFIG.PROGRESS_API, {
      project_id: projectId, task_id: task.taskId, stat_object: CONFIG.STAT_OBJECTS,
    });
    if (res.code !== 0) throw new Error(`获取进度失败: ${res.message}`);
    return res.data;
  }

  async function aggregateProgress(onProgress, onDetail) {
    const projectId = getProjectId();
    if (!projectId) throw new Error('无法从 URL 提取 project_id');

    onProgress?.('正在同步项目动态字典...');
    const supplierDict = await fetchSupplierDict(projectId);

    onProgress?.('正在获取任务列表...');
    const tasks = await fetchAllTaskIds(projectId, onProgress, supplierDict);
    onProgress?.(`共获取到 ${tasks.length} 个子任务，开始查询进度...`);

    if (tasks.length === 0) return { tasks: [], summary: {}, supplierSummary: {}, details: [], errorCount: 0 };

    let completed = 0;
    const details = await batchRequest(tasks, CONFIG.CONCURRENCY, async (task, idx) => {
      const progress = await fetchTaskProgress(task, projectId);
      completed++;
      onProgress?.(`进度查询中... ${completed}/${tasks.length}`);
      onDetail?.(task, progress, idx);
      return { task, progress };
    });

    const summary = {
        total_num: 0, labeled_num: 0, wait_label_num: 0, deliver_reviewing_num: 0, finished_num: 0,
        idToNameMap: {} // 映射表
    };
    const supplierSummary = {};
    let errorCount = 0;

    for (const item of details) {
      if (item.error) { errorCount++; continue; }
      const p = item.progress;

      const supId = item.task.supplierId;
      const supName = item.task.supplierName;

      // 登记 ID -> 名字 映射
      if (!summary.idToNameMap[supId]) {
          summary.idToNameMap[supId] = supName;
      }

      summary.total_num += p.total_num || 0;
      summary.labeled_num += p.labeled_num || 0;
      summary.wait_label_num += p.wait_label_num || 0;
      summary.deliver_reviewing_num += p.deliver_reviewing_num || 0;
      summary.finished_num += p.finished_num || 0;

      // 按照唯一 ID 进行合并
      if (!supplierSummary[supId]) {
        supplierSummary[supId] = { total_num: 0, labeled_num: 0, wait_label_num: 0, deliver_reviewing_num: 0, finished_num: 0 };
      }
      supplierSummary[supId].total_num += p.total_num || 0;
      supplierSummary[supId].labeled_num += p.labeled_num || 0;
      supplierSummary[supId].wait_label_num += p.wait_label_num || 0;
      supplierSummary[supId].deliver_reviewing_num += p.deliver_reviewing_num || 0;
      supplierSummary[supId].finished_num += p.finished_num || 0;
    }

    return { tasks, summary, supplierSummary, details, errorCount };
  }

  // ==================== UI 样式 ====================
  const STYLES = `
    .tm-progress-btn { position: fixed; right: 24px; bottom: 24px; z-index: 2147483647; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; border: none; border-radius: 12px; padding: 12px 20px; font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); display: flex; align-items: center; gap: 8px; transition: all 0.2s; }
    .tm-progress-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6); }
    .tm-progress-btn.loading { opacity: 0.8; cursor: wait; }
    .tm-progress-panel { position: fixed; right: 24px; bottom: 80px; z-index: 2147483647; width: 720px; max-height: 85vh; background: #fff; border-radius: 16px; box-shadow: 0 8px 40px rgba(0, 0, 0, 0.15); display: none; flex-direction: column; overflow: hidden; font-family: -apple-system, sans-serif; }
    .tm-progress-panel.show { display: flex; }
    .tm-panel-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; }
    .tm-panel-header h3 { margin: 0; font-size: 16px; font-weight: 600; }
    .tm-panel-close { background: rgba(255,255,255,0.2); border: none; color: #fff; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; }
    .tm-panel-status { padding: 12px 20px; font-size: 13px; color: #666; border-bottom: 1px solid #f0f0f0; background: #fafbfc; }
    .tm-summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; padding: 16px 20px; border-bottom: 1px solid #f0f0f0; }
    .tm-summary-card { background: #f8f9ff; border-radius: 10px; padding: 12px 10px; text-align: center; }
    .tm-summary-card .label { font-size: 12px; color: #888; margin-bottom: 4px; white-space: nowrap;}
    .tm-summary-card .value { font-size: 20px; font-weight: 700; color: #333; }
    .tm-summary-card.supplier .value { color: #2563eb; font-size: 16px; padding-top:2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;}
    .tm-summary-card.total .value { color: #667eea; }
    .tm-summary-card.labeled .value { color: #f59e0b; }
    .tm-summary-card.reviewing .value { color: #8b5cf6; }
    .tm-summary-card.finished .value { color: #10b981; }
    .tm-summary-card.waiting .value { color: #ef4444; }
    .tm-detail-section { padding: 12px 20px 8px; font-size: 13px; font-weight: 600; color: #555; background: #fafbfc; border-bottom: 1px solid #f0f0f0;}
    .tm-detail-table-wrap { overflow-y: auto; padding: 0 20px 16px; }

    /* 强迫症狂喜：强制表格固定列宽，完美垂直对齐 */
    .tm-detail-table { width: 100%; border-collapse: collapse; font-size: 12px; table-layout: fixed; }
    .tm-detail-table th, .tm-detail-table td { padding: 8px 6px; text-align: center; border-bottom: 1px solid #f0f0f0; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tm-detail-table th:first-child, .tm-detail-table td:first-child { text-align: left; width: 40%; }
    .tm-detail-table th:nth-child(2), .tm-detail-table td:nth-child(2) { width: 12%; }
    .tm-detail-table th:nth-child(3), .tm-detail-table td:nth-child(3) { width: 12%; }
    .tm-detail-table th:nth-child(4), .tm-detail-table td:nth-child(4) { width: 12%; }
    .tm-detail-table th:nth-child(5), .tm-detail-table td:nth-child(5) { width: 12%; }
    .tm-detail-table th:nth-child(6), .tm-detail-table td:nth-child(6) { width: 12%; }
    .tm-detail-table th { position: sticky; top: 0; background: #f8f9fa; color: #666; font-weight: 600; border-bottom: 2px solid #e9ecef; z-index: 2; }

    .tm-error-row td { color: #ef4444 !important; }
    .tm-copy-btn { margin: 0 20px 16px; padding: 8px; border: 1px solid #ddd; border-radius: 8px; background: #fff; cursor: pointer; font-size: 13px; color: #555; text-align: center; transition: all 0.2s;}
    .tm-copy-btn:hover { background: #f0f0f0; }
  `;

  function formatNum(n) { return n.toLocaleString('zh-CN'); }

  let lastResult = null;

  function init() {
    // 暴力清理旧 DOM
    document.querySelectorAll('.tm-progress-btn, .tm-progress-panel, style[id^="tm-style-"]').forEach(el => el.remove());

    const style = document.createElement('style');
    style.id = 'tm-style-' + Date.now();
    style.textContent = STYLES;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.className = 'tm-progress-btn';
    btn.innerHTML = '<span class="icon">📊</span><span>汇总进度</span>';
    document.body.appendChild(btn);

    const panel = document.createElement('div');
    panel.className = 'tm-progress-panel';
    panel.innerHTML = `
      <div class="tm-panel-header"><h3>📊 任务进度汇总</h3><button class="tm-panel-close">✕</button></div>
      <div class="tm-panel-status">点击「汇总进度」按钮开始</div>
      <div class="tm-summary-grid" style="display:none;"></div>

      <div class="tm-detail-section tm-supplier-title" style="display:none;">🏢 团队大盘拆解</div>
      <div class="tm-detail-table-wrap tm-supplier-wrap" style="display:none; height: 120px; margin-bottom: 10px;">
        <table class="tm-detail-table">
          <thead><tr><th>归属团队名称</th><th>总量</th><th>已标注</th><th>待标注</th><th>审核中</th><th>已完成</th></tr></thead>
          <tbody class="tm-supplier-body"></tbody>
        </table>
      </div>

      <div class="tm-detail-section tm-detail-title" style="display:none;">📋 各任务明细</div>
      <div class="tm-detail-table-wrap tm-detail-wrap" style="display:none; flex: 1;">
        <table class="tm-detail-table">
          <thead><tr><th>任务名称</th><th>总量</th><th>已标注</th><th>待标注</th><th>审核中</th><th>已完成</th></tr></thead>
          <tbody class="tm-detail-body"></tbody>
        </table>
      </div>
      <button class="tm-copy-btn" style="display:none;">📋 复制汇总数据</button>
    `;
    document.body.appendChild(panel);

    const ui = {
      btn, panel,
      status: panel.querySelector('.tm-panel-status'),
      summary: panel.querySelector('.tm-summary-grid'),
      supTitle: panel.querySelector('.tm-supplier-title'),
      supWrap: panel.querySelector('.tm-supplier-wrap'),
      supBody: panel.querySelector('.tm-supplier-body'),
      detailTitle: panel.querySelector('.tm-detail-title'),
      detailWrap: panel.querySelector('.tm-detail-wrap'),
      detailBody: panel.querySelector('.tm-detail-body'),
      copyBtn: panel.querySelector('.tm-copy-btn')
    };

    panel.querySelector('.tm-panel-close').addEventListener('click', () => panel.classList.remove('show'));

    btn.addEventListener('click', async () => {
      panel.classList.toggle('show');
      if (panel.classList.contains('show') && !btn.classList.contains('loading')) {
        await runAggregation(ui);
      }
    });

    ui.copyBtn.addEventListener('click', () => {
        if (!lastResult) return;
        const s = lastResult.summary;
        const supSum = lastResult.supplierSummary;

        const supplierNames = Object.values(s.idToNameMap).filter(name => !name.includes('内部团队') && !name.includes('个人:'));
        let supplierText = supplierNames.length > 0 ? `${supplierNames.length} 支 (${supplierNames.join('、')})` : '仅内部团队参与';

        let lines = [
          `项目进度大盘汇总（共 ${lastResult.tasks.length} 个子任务）`,
          `————————————————`,
          `🏢 标注团队 (Team):  ${supplierText}`,
          `📦 总量 (total):     ${formatNum(s.total_num)}`,
          `🏷️ 已标注 (labeled): ${formatNum(s.labeled_num)}`,
          `⏳ 待标注 (waiting): ${formatNum(s.wait_label_num)}`,
          `🔍 审核中 (review):  ${formatNum(s.deliver_reviewing_num)}`,
          `✅ 已完成 (finished):${formatNum(s.finished_num)}`,
          ``,
          `标注进度: ${(s.total_num > 0 ? (s.labeled_num / s.total_num * 100).toFixed(2) : 0)}%`,
          `完成进度: ${(s.total_num > 0 ? (s.finished_num / s.total_num * 100).toFixed(2) : 0)}%`,
          `\n📊 团队进度拆解：`,
          `————————————————`
        ];

        const sortedIds = Object.entries(supSum).sort((a, b) => b[1].total_num - a[1].total_num);
        for (const [vId, stats] of sortedIds) {
           const dName = s.idToNameMap[vId];
           lines.push(`- ${dName}: 总量 ${formatNum(stats.total_num)} | 已标 ${formatNum(stats.labeled_num)} | 待标 ${formatNum(stats.wait_label_num)} | 审核中 ${formatNum(stats.deliver_reviewing_num)} | 已完 ${formatNum(stats.finished_num)}`);
        }

        navigator.clipboard.writeText(lines.join('\n')).then(() => {
          ui.copyBtn.textContent = '✅ 已复制数据！';
          setTimeout(() => { ui.copyBtn.textContent = '📋 复制汇总数据'; }, 2000);
        });
    });
  }

  async function runAggregation(ui) {
    ui.btn.classList.add('loading');
    ui.btn.innerHTML = '<span class="icon">⏳</span><span>查询中...</span>';
    ui.summary.style.display = 'none'; ui.supTitle.style.display = 'none'; ui.supWrap.style.display = 'none';
    ui.detailTitle.style.display = 'none'; ui.detailWrap.style.display = 'none'; ui.copyBtn.style.display = 'none';

    let taskHtml = '';
    let supHtml = '';

    try {
      const result = await aggregateProgress(
        (msg) => { ui.status.textContent = msg; },
        (task, progress) => {
          if (progress.error) {
            taskHtml += `<tr class="tm-error-row"><td title="${task.taskName}">${task.taskName}</td><td colspan="5">❌ 请求失败</td></tr>`;
          } else {
            taskHtml += `
              <tr>
                <td title="${task.taskName}"><span style="color:#888; font-size:10px;">[${task.supplierName}]</span><br/>${task.taskName}</td>
                <td style="color:#667eea;">${formatNum(progress.total_num || 0)}</td>
                <td style="color:#f59e0b;">${formatNum(progress.labeled_num || 0)}</td>
                <td style="color:#ef4444;">${formatNum(progress.wait_label_num || 0)}</td>
                <td style="color:#8b5cf6;">${formatNum(progress.deliver_reviewing_num || 0)}</td>
                <td style="color:#10b981;">${formatNum(progress.finished_num || 0)}</td>
              </tr>
            `;
          }
        }
      );

      lastResult = result;
      const s = result.summary;
      const supSum = result.supplierSummary;

      ui.detailBody.innerHTML = taskHtml;

      const sortedIds = Object.entries(supSum).sort((a, b) => b[1].total_num - a[1].total_num);

      if (sortedIds.length === 0) {
         supHtml = '<tr><td colspan="6" style="text-align:center; color:#999; padding: 16px;">未获取到团队数据</td></tr>';
      } else {
         for (const [vId, stats] of sortedIds) {
           const dName = s.idToNameMap[vId];
           supHtml += `
             <tr>
               <td title="${dName}"><b>${dName}</b></td>
               <td style="color:#667eea;">${formatNum(stats.total_num)}</td>
               <td style="color:#f59e0b;">${formatNum(stats.labeled_num)}</td>
               <td style="color:#ef4444;">${formatNum(stats.wait_label_num)}</td>
               <td style="color:#8b5cf6;">${formatNum(stats.deliver_reviewing_num)}</td>
               <td style="color:#10b981;">${formatNum(stats.finished_num)}</td>
             </tr>
           `;
         }
      }
      ui.supBody.innerHTML = supHtml;

      const supplierNames = Object.values(s.idToNameMap).filter(name => !name.includes('内部团队') && !name.includes('个人:'));
      let supplierText = '仅内部团队';
      if (supplierNames.length === 1) supplierText = supplierNames[0];
      else if (supplierNames.length > 1) supplierText = `${supplierNames.length} 支团队`;

      ui.summary.innerHTML = `
        <div class="tm-summary-card supplier" title="${supplierNames.join('、')}"><div class="label">🏢 标注团队</div><div class="value">${supplierText}</div></div>
        <div class="tm-summary-card total"><div class="label">📦 总量</div><div class="value">${formatNum(s.total_num)}</div></div>
        <div class="tm-summary-card labeled"><div class="label">🏷️ 已标注</div><div class="value">${formatNum(s.labeled_num)}</div></div>
        <div class="tm-summary-card waiting"><div class="label">⏳ 待标注</div><div class="value">${formatNum(s.wait_label_num)}</div></div>
        <div class="tm-summary-card reviewing"><div class="label">🔍 审核中</div><div class="value">${formatNum(s.deliver_reviewing_num)}</div></div>
        <div class="tm-summary-card finished"><div class="label">✅ 已完成</div><div class="value">${formatNum(s.finished_num)}</div></div>
      `;

      const errorMsg = result.errorCount > 0 ? `（${result.errorCount} 个任务失败）` : '';
      ui.status.textContent = `✅ 完成！共 ${result.tasks.length} 个子任务 ${errorMsg}`;

      ui.summary.style.display = 'grid';
      ui.supTitle.style.display = 'block'; ui.supWrap.style.display = 'block';
      ui.detailTitle.style.display = 'block'; ui.detailWrap.style.display = 'block';
      ui.copyBtn.style.display = 'block';

    } catch (err) {
      ui.status.textContent = `❌ 出错了: ${err.message}`;
    } finally {
      ui.btn.classList.remove('loading'); ui.btn.innerHTML = '<span class="icon">📊</span><span>汇总进度</span>';
    }
  }

  // SPA 路由监听防丢机制
  function ensureUI() {
    const isProjectPage = /\/project\/\d+/.test(location.pathname);
    const panelExists = document.querySelector('.tm-progress-panel');

    if (isProjectPage && !panelExists) {
      init();
    } else if (!isProjectPage && panelExists) {
      document.querySelectorAll('.tm-progress-btn, .tm-progress-panel, style[id^="tm-style-"]').forEach(el => el.remove());
    }
  }

  ensureUI();
  setInterval(ensureUI, 1500);

})();