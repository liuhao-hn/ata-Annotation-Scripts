// ==UserScript==
// @name         数据标注平台人员能效汇总器 (开源脱敏版)
// @namespace    https://github.com/yourusername
// @version      2.6.0
// @description  保留验证的稳健双漏斗(质检/验收)算法，适用于通用标注系统的人效数据聚合
// @author       Your Name
// @match        https://*.your-company-domain.com/project/*/task* // [TODO: 请修改为你们实际的标注系统业务域名]
// @grant        none
// ==/UserScript==
// ╔══════════════════════════════════════════════════════════════╗
// ║  ⚠️ 本文件为脱敏版本（Portfolio Version）                    ║
// ║  平台名称、URL、作者信息已做脱敏处理，保留全部工程逻辑。       ║
// ║  原始代码已在实际生产环境中稳定运行数月。                     ║
// ╚══════════════════════════════════════════════════════════════╝

(function () {
  'use strict';

  // ==================== 1. 获取逻辑 ====================
  function getAllTaskIds() {
    const ids = [];
    // [TODO: 根据实际前端 DOM 结构调整选择器]
    const links = document.querySelectorAll('a[href*="/task/"]');
    links.forEach(link => {
      const match = link.href.match(/\/task\/(\d+)/);
      if (match && !ids.includes(match[1])) ids.push(match[1]);
    });
    return ids;
  }

  async function fetchSingleTaskReport(taskId) {
    // [TODO: 修改为实际的后台数据报表接口 API]
    const url = `/api/v1/report/user_working_report`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ task_id: taskId, stat_type: 1, page_id: 1, page_size: 500 })
    });
    const res = await resp.json();
    if (res.data) {
        if (Array.isArray(res.data.data)) return res.data.data;
        if (Array.isArray(res.data.items)) return res.data.items;
        if (Array.isArray(res.data)) return res.data;
    }
    return [];
  }

  function formatNum(n) { return n ? n.toLocaleString('zh-CN') : '0'; }

  // ==================== 2. 双漏斗计算逻辑 ====================
  async function runGlobalAggregation() {
    const btn = document.getElementById('tm-eff-btn');
    const statusEl = document.getElementById('tm-eff-status');
    const summaryEl = document.getElementById('tm-eff-summary');
    const detailBody = document.getElementById('tm-eff-detail-body');
    const copyBtn = document.getElementById('tm-eff-copy-btn');

    const taskIds = getAllTaskIds();
    if (taskIds.length === 0) {
      statusEl.textContent = '❌ 列表未加载或未找到任务 ID，请刷新页面重试';
      return;
    }

    btn.classList.add('loading');
    btn.innerHTML = '<span class="icon">⏳</span><span>正在同步...</span>';
    statusEl.innerHTML = `检测到 <b>${taskIds.length}</b> 个批次，正在拆分双漏斗数据...`;

    summaryEl.style.display = 'none';
    document.getElementById('tm-eff-detail-title').style.display = 'none';
    document.getElementById('tm-eff-detail-wrap').style.display = 'none';
    copyBtn.style.display = 'none';

    const userMap = {};

    for (let i = 0; i < taskIds.length; i++) {
      statusEl.textContent = `进度: ${i + 1}/${taskIds.length} (正在处理 ID: ${taskIds[i]})`;
      try {
        const users = await fetchSingleTaskReport(taskIds[i]);
        users.forEach(u => {
          // [TODO: 根据实际接口返回的字段名进行调整]
          const key = u.user_id || '未知人员';
          if (!userMap[key]) {
            userMap[key] = {
              name: u.nick_name || '未知人员',
              labeled: 0, returned: 0, duration: 0,
              qa_checked: 0, qa_passed: 0,
              acc_checked: 0, acc_passed: 0
            };
          }
          const d = userMap[key];

          // 累加以杜绝因重复id导致的通过率失真
          d.labeled += (u.total_labeled_num || u.first_label_count || 0);
          d.returned += (u.return_num || 0);
          d.duration += (u.labeled_duration_hour || u.first_label_hour || 0);

          if (u.total_check_num !== undefined && u.pass_check_num !== undefined) {
              d.qa_checked += (u.total_check_num || 0);
              d.qa_passed += (u.pass_check_num || 0);
          } else {
              // 兼容极少数没有这两个字段的老批次
              const qa_chk = u.checked_num || 0;
              d.qa_checked += qa_chk;
              d.qa_passed += Math.round(qa_chk * parseFloat(u.check_pass_ratio || '0') / 100);
          }

          const acc_c = u.checked_label_detail_count1 !== undefined ? u.checked_label_detail_count1 : u.algorithm_checked_label_detail_count;
          const acc_r = u.passed_label_detail_ratio1 !== undefined ? u.passed_label_detail_ratio1 : u.algorithm_passed_label_detail_ratio;

          if (acc_c !== undefined) {
              const ac_chk = acc_c || 0;
              d.acc_checked += ac_chk;
              d.acc_passed += Math.round(ac_chk * (acc_r || 0));
          }
        });
      } catch (e) { console.error(`跳过任务 ${taskIds[i]}:`, e); }
    }

    // ==================== 3. 排版和样式 ====================
    detailBody.innerHTML = '';
    const sortedUsers = Object.values(userMap).sort((a, b) => b.labeled - a.labeled);
    const grand = { labeled: 0, qa_checked: 0, qa_passed: 0, acc_checked: 0, acc_passed: 0, returned: 0, duration: 0 };

    sortedUsers.forEach(u => {
      grand.labeled += u.labeled;
      grand.qa_checked += u.qa_checked; grand.qa_passed += u.qa_passed;
      grand.acc_checked += u.acc_checked; grand.acc_passed += u.acc_passed;
      grand.returned += u.returned; grand.duration += u.duration;

      const qaRate = u.qa_checked > 0 ? ((u.qa_passed / u.qa_checked) * 100).toFixed(2) + '%' : '-';
      const accRate = u.acc_checked > 0 ? ((u.acc_passed / u.acc_checked) * 100).toFixed(2) + '%' : '-';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td title="${u.name}"><b>${u.name}</b></td>
        <td style="color:#2563eb; font-weight:700;">${formatNum(u.labeled)}</td>
        <td style="color:#10b981; font-weight:600;">${qaRate}<br><span style="font-size:10px;color:#888;font-weight:400;">(对${u.qa_passed}/查${u.qa_checked})</span></td>
        <td style="color:#f59e0b; font-weight:600;">${accRate}<br><span style="font-size:10px;color:#888;font-weight:400;">(对${u.acc_passed}/查${u.acc_checked})</span></td>
        <td style="color:#dc2626; font-weight:600;">${formatNum(u.returned)}</td>
        <td style="color:#8b5cf6;">${u.duration.toFixed(2)}h</td>
      `;
      detailBody.appendChild(tr);
    });

    const globalQaRate = grand.qa_checked > 0 ? ((grand.qa_passed / grand.qa_checked) * 100).toFixed(2) + '%' : '-';
    const globalAccRate = grand.acc_checked > 0 ? ((grand.acc_passed / grand.acc_checked) * 100).toFixed(2) + '%' : '-';

    summaryEl.innerHTML = `
      <div class="tm-summary-card total"><div class="label">📦 批次标注</div><div class="value">${formatNum(grand.labeled)}</div></div>
      <div class="tm-summary-card finished"><div class="label">🛡️ 大盘质检率</div><div class="value">${globalQaRate}</div></div>
      <div class="tm-summary-card labeled"><div class="label">🎯 大盘验收率</div><div class="value">${globalAccRate}</div></div>
      <div class="tm-summary-card rejected"><div class="label">❌ 累计驳回</div><div class="value">${formatNum(grand.returned)}</div></div>
      <div class="tm-summary-card reviewing"><div class="label">⏱️ 累计总工时</div><div class="value">${grand.duration.toFixed(1)}h</div></div>
      <div class="tm-summary-card pending"><div class="label">👥 参与人数</div><div class="value">${sortedUsers.length}</div></div>
    `;

    statusEl.textContent = `✅ 汇总完毕！共有 ${sortedUsers.length} 位成员的数据`;
    summaryEl.style.display = 'grid';
    document.getElementById('tm-eff-detail-title').style.display = 'block';
    document.getElementById('tm-eff-detail-wrap').style.display = 'block';
    copyBtn.style.display = 'block';

    btn.classList.remove('loading');
    btn.innerHTML = '<span class="icon">📊</span><span>人员能效</span>';
  }

  function setupCopy() {
    document.addEventListener('click', (e) => {
      if (e.target.id === 'tm-eff-copy-btn') {
        const rows = document.querySelectorAll('#tm-eff-detail-body tr');
        let text = "📊 项目人员双轨质量结果\n————————————————\n";
        const summaryValues = document.querySelectorAll('.tm-summary-card .value');
        text += `总标注: ${summaryValues[0].innerText} | 质检通过率: ${summaryValues[1].innerText} | 验收通过率: ${summaryValues[2].innerText}\n————————————————\n`;

        rows.forEach(row => {
          const cells = row.querySelectorAll('td');
          text += `- ${cells[0].innerText}: 标注 ${cells[1].innerText} | 质检 ${cells[2].innerText.replace('\n', '')} | 验收 ${cells[3].innerText.replace('\n', '')} | 工时 ${cells[5].innerText}\n`;
        });

        navigator.clipboard.writeText(text).then(() => {
          e.target.innerText = '✅ 已成功复制到粘贴板';
          setTimeout(() => { e.target.innerText = '📋 复制双轨质量到粘贴板'; }, 2000);
        });
      }
    });
  }

  // ==================== 4. UI (独立ID 防冲突 + 左下角) ====================
  const STYLES = `
    #tm-eff-btn { position: fixed; left: 24px; bottom: 24px; z-index: 2147483647; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; border: none; border-radius: 12px; padding: 12px 20px; font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); transition: all 0.3s ease; display: flex; align-items: center; gap: 8px; }
    #tm-eff-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6); }
    #tm-eff-btn.loading { opacity: 0.8; cursor: wait; }
    #tm-eff-panel { position: fixed; left: 24px; bottom: 80px; z-index: 2147483647; width: 780px; max-height: 80vh; background: #fff; border-radius: 16px; box-shadow: 0 8px 40px rgba(0, 0, 0, 0.15); display: none; flex-direction: column; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    #tm-eff-panel.show { display: flex; }
    .tm-eff-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; }
    .tm-eff-header h3 { margin: 0; font-size: 16px; font-weight: 600; }
    .tm-eff-close { background: rgba(255,255,255,0.2); border: none; color: #fff; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .tm-eff-status { padding: 12px 20px; font-size: 13px; color: #666; border-bottom: 1px solid #f0f0f0; background: #fafbfc; }
    .tm-summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; padding: 16px 20px; border-bottom: 1px solid #f0f0f0; }
    .tm-summary-card { background: #f8f9ff; border-radius: 10px; padding: 12px 14px; text-align: center; }
    .tm-summary-card .label { font-size: 12px; color: #888; margin-bottom: 6px; }
    .tm-summary-card .value { font-size: 20px; font-weight: 700; color: #333; }
    .tm-summary-card.total .value { color: #667eea; }
    .tm-summary-card.labeled .value { color: #f59e0b; }
    .tm-summary-card.reviewing .value { color: #8b5cf6; }
    .tm-summary-card.rejected .value { color: #dc2626; }
    .tm-summary-card.finished .value { color: #10b981; }
    .tm-summary-card.pending .value { color: #475569; }
    .tm-eff-detail-section { padding: 12px 20px 8px; font-size: 13px; font-weight: 600; color: #555; }
    .tm-eff-table-wrap { flex: 1; overflow-y: auto; padding: 0 20px 16px; }
    .tm-eff-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .tm-eff-table th { position: sticky; top: 0; background: #f8f9fa; padding: 8px 6px; text-align: right; color: #666; border-bottom: 2px solid #e9ecef; }
    .tm-eff-table th:first-child { text-align: left; }
    .tm-eff-table td { padding: 7px 6px; text-align: right; border-bottom: 1px solid #f0f0f0; color: #333; }
    .tm-eff-table td:first-child { text-align: left; max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tm-eff-copy-btn { margin: 0 20px 16px; padding: 8px; border: 1px solid #ddd; border-radius: 8px; background: #fff; cursor: pointer; font-size: 13px; color: #555; text-align: center;}
    .tm-eff-copy-btn:hover { background: #f9fafb; }
  `;

  function init() {
    if (document.getElementById('tm-eff-btn')) return;
    const s = document.createElement('style'); s.textContent = STYLES; document.documentElement.appendChild(s);

    const btn = document.createElement('button');
    btn.id = 'tm-eff-btn';
    btn.innerHTML = '<span class="icon">📊</span><span>人员能效</span>';

    const panel = document.createElement('div');
    panel.id = 'tm-eff-panel';
    panel.innerHTML = `
      <div class="tm-eff-header"><h3>📊 质检/验收 双漏斗效能汇总</h3><button class="tm-eff-close">✕</button></div>
      <div class="tm-eff-status" id="tm-eff-status">就绪：检测到任务列表后点击汇总</div>
      <div class="tm-summary-grid" id="tm-eff-summary" style="display:none;"></div>
      <div class="tm-eff-detail-section" id="tm-eff-detail-title" style="display:none;">📋 成员明细 (双漏斗核算)</div>
      <div class="tm-eff-table-wrap" id="tm-eff-detail-wrap" style="display:none;">
        <table class="tm-eff-table">
          <thead><tr><th>标注员</th><th>批次产量</th><th>🛡️质检通过率</th><th>🎯验收通过率</th><th>累计驳回</th><th>累计工时</th></tr></thead>
          <tbody id="tm-eff-detail-body"></tbody>
        </table>
      </div>
      <button class="tm-eff-copy-btn" id="tm-eff-copy-btn" style="display:none;">📋 复制双轨质量汇总到粘贴板</button>
    `;

    document.documentElement.appendChild(btn);
    document.documentElement.appendChild(panel);

    panel.querySelector('.tm-eff-close').addEventListener('click', () => panel.classList.remove('show'));
    btn.addEventListener('click', () => {
      panel.classList.toggle('show');
      if(panel.classList.contains('show') && !btn.classList.contains('loading')) runGlobalAggregation();
    });

    setupCopy();
  }

  setInterval(init, 1000);
})();