#!/usr/bin/env python3
"""
项目大盘进度与质量日报生成器
用法：双击运行，或 python3 生成日报.py
自动比较最新两份"项目大盘进度与质量统计表"文件，输出团队级进度/质量波动日报。
"""

import os
import re
import sys
from datetime import datetime
import pandas as pd

# ==================== 配置 ====================
DATA_DIR = os.path.dirname(os.path.abspath(__file__))
FILE_PATTERN = re.compile(r"项目大盘进度与质量统计表_历史全量_(\d{4})_(\d{1,2})_(\d{1,2})\.xls")
WARN_THRESHOLD = 10.0  # 波动率超过 10% 触发标记

# ==================== 辅助函数 ====================

def parse_date_from_filename(filename: str):
    m = FILE_PATTERN.search(filename)
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    return (datetime(y, mo, d).date(), f"{y}_{mo}_{d}")


def parse_quality_cell(val):
    """从 '90.9% (10/11)' 中提取 (通过数, 总量)，无数据返回 (0, 0)"""
    if pd.isna(val) or str(val).strip() == "-":
        return (0, 0)
    m = re.match(r"[\d.]+%\s*\((\d+)/(\d+)\)", str(val).strip())
    if m:
        return (int(m.group(1)), int(m.group(2)))
    return (0, 0)


def read_file(filepath: str) -> tuple:
    """
    读取一个 .xls (HTML 格式) 文件，返回 (team_df, quality_summary)
    team_df: table 1 团队进度汇总
    quality_summary: dict {team: {质检_pass, 质检_total, 验收_pass, 验收_total}}
    """
    tables = pd.read_html(filepath)

    # Table 1: 团队进度汇总
    team_df = tables[1].copy()
    team_df["归属团队名称"] = team_df["归属团队名称"].astype(str).str.strip()
    team_df = team_df[team_df["归属团队名称"] != "内部团队/未分配"].copy()
    for col in ["总量", "已标注", "质检中", "验收中", "已驳回", "已完成"]:
        team_df[col] = pd.to_numeric(team_df[col], errors="coerce").fillna(0).astype(int)

    # Table 0: 批次明细 → 按团队聚合质量
    batch_df = tables[0].copy()
    # 提取团队名（第一个 [] 中的内容）
    batch_df["团队"] = batch_df["批次名称"].astype(str).str.extract(r"\[([^\]]+)\]")
    batch_df["团队"] = batch_df["团队"].fillna("未知团队")

    # 解析质量数据
    qc_parsed = batch_df["🛡️首次质检"].apply(parse_quality_cell)
    ac_parsed = batch_df["🎯首次验收"].apply(parse_quality_cell)
    batch_df["质检_pass"] = qc_parsed.apply(lambda x: x[0])
    batch_df["质检_total"] = qc_parsed.apply(lambda x: x[1])
    batch_df["验收_pass"] = ac_parsed.apply(lambda x: x[0])
    batch_df["验收_total"] = ac_parsed.apply(lambda x: x[1])

    quality_by_team = {}
    for team, grp in batch_df.groupby("团队"):
        quality_by_team[team] = {
            "质检_pass": int(grp["质检_pass"].sum()),
            "质检_total": int(grp["质检_total"].sum()),
            "验收_pass": int(grp["验收_pass"].sum()),
            "验收_total": int(grp["验收_total"].sum()),
        }

    return team_df, quality_by_team


def calc_rate(pass_cnt, total_cnt):
    """计算百分比"""
    if total_cnt == 0:
        return None
    return round(pass_cnt / total_cnt * 100, 1)


def calc_fluctuation(new_val, old_val):
    """计算波动率 (%)"""
    if old_val is None or new_val is None:
        return None
    if old_val == 0:
        return None
    return round((new_val - old_val) / old_val * 100, 2)


def flag_warn(rate):
    """正向→优秀，负向→警告"""
    if rate is None:
        return ""
    if rate > WARN_THRESHOLD:
        return "🌟 优秀"
    if rate < -WARN_THRESHOLD:
        return "⚠️ 异常"
    return ""


# ==================== 主流程 ====================

def main():
    # 1. 扫描文件
    files_info = []
    for fname in os.listdir(DATA_DIR):
        result = parse_date_from_filename(fname)
        if result:
            date_obj, date_str = result
            files_info.append((date_obj, date_str, os.path.join(DATA_DIR, fname)))

    if len(files_info) < 2:
        print(f"[错误] 至少需要 2 个历史文件，当前找到 {len(files_info)} 个。")
        sys.exit(1)

    files_info.sort(key=lambda x: x[0])
    old_info = files_info[-2]
    new_info = files_info[-1]

    old_date_obj, old_date_str, old_path = old_info
    new_date_obj, new_date_str, new_path = new_info

    print(f"📊 对比：{new_date_str}（最新） vs {old_date_str}（上期）")
    print()

    # 2. 读取文件
    team_old, qc_old = read_file(old_path)
    team_new, qc_new = read_file(new_path)

    # ==================== 进度模块 ====================
    progress_cols = ["总量", "已标注", "质检中", "验收中", "已驳回", "已完成"]

    # 合并团队进度
    p_old = team_old[["归属团队名称"] + progress_cols].copy()
    p_old.columns = ["团队"] + [f"{c}_old" for c in progress_cols]
    p_new = team_new[["归属团队名称"] + progress_cols].copy()
    p_new.columns = ["团队"] + [f"{c}_new" for c in progress_cols]
    progress = p_old.merge(p_new, on="团队", how="outer")

    for col in progress_cols:
        progress[f"{col}_old"] = progress[f"{col}_old"].fillna(0).astype(int)
        progress[f"{col}_new"] = progress[f"{col}_new"].fillna(0).astype(int)
        progress[f"{col}_差值"] = progress[f"{col}_new"] - progress[f"{col}_old"]
        progress[f"{col}_波动率"] = progress.apply(
            lambda r, c=col: calc_fluctuation(r[f"{c}_new"], r[f"{c}_old"]), axis=1
        )
        progress[f"{col}_标记"] = progress[f"{col}_波动率"].apply(flag_warn)

    # ==================== 质量模块 ====================
    # 按团队聚合质量
    all_teams = sorted(set(list(qc_old.keys()) + list(qc_new.keys())))

    quality_rows = []
    for team in all_teams:
        if "未分配" in team:
            continue
        o = qc_old.get(team, {"质检_pass": 0, "质检_total": 0, "验收_pass": 0, "验收_total": 0})
        n = qc_new.get(team, {"质检_pass": 0, "质检_total": 0, "验收_pass": 0, "验收_total": 0})

        qc_rate_old = calc_rate(o["质检_pass"], o["质检_total"])
        qc_rate_new = calc_rate(n["质检_pass"], n["质检_total"])
        ac_rate_old = calc_rate(o["验收_pass"], o["验收_total"])
        ac_rate_new = calc_rate(n["验收_pass"], n["验收_total"])

        qc_diff = round(qc_rate_new - qc_rate_old, 1) if qc_rate_old is not None and qc_rate_new is not None else None
        ac_diff = round(ac_rate_new - ac_rate_old, 1) if ac_rate_old is not None and ac_rate_new is not None else None
        qc_fluct = calc_fluctuation(qc_rate_new, qc_rate_old)
        ac_fluct = calc_fluctuation(ac_rate_new, ac_rate_old)

        quality_rows.append({
            "团队": team,
            "质检_pass_old": o["质检_pass"], "质检_total_old": o["质检_total"],
            "质检_pass_new": n["质检_pass"], "质检_total_new": n["质检_total"],
            "质检通过率_old": qc_rate_old, "质检通过率_new": qc_rate_new,
            "质检差值": qc_diff, "质检波动率": qc_fluct, "质检标记": flag_warn(qc_fluct),
            "验收_pass_old": o["验收_pass"], "验收_total_old": o["验收_total"],
            "验收_pass_new": n["验收_pass"], "验收_total_new": n["验收_total"],
            "验收通过率_old": ac_rate_old, "验收通过率_new": ac_rate_new,
            "验收差值": ac_diff, "验收波动率": ac_fluct, "验收标记": flag_warn(ac_fluct),
        })

    quality = pd.DataFrame(quality_rows)

    # ==================== 输出日报 ====================
    lines = []
    lines.append("=" * 80)
    lines.append(f"  项目大盘进度与质量日报")
    lines.append(f"  最新数据：{new_date_str.replace('_', '/')}    上期数据：{old_date_str.replace('_', '/')}")
    lines.append(f"  生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append("=" * 80)
    lines.append("")

    # ---- 进度部分 ----
    lines.append("━" * 80)
    lines.append("  【一、团队进度波动】")
    lines.append("━" * 80)
    lines.append("")

    has_any_warn = False
    has_any_excellent = False

    for _, row in progress.iterrows():
        team = row["团队"]
        lines.append(f"  ▸ {team}")
        for col, label in [
            ("已标注", "📦 已标注"),
            ("质检中", "🔍 质检中"),
            ("验收中", "📋 验收中"),
            ("已驳回", "↩️  已驳回"),
            ("已完成", "✅ 已完成"),
        ]:
            old_v = int(row[f"{col}_old"])
            new_v = int(row[f"{col}_new"])
            diff = int(row[f"{col}_差值"])
            rate = row[f"{col}_波动率"]
            flag = row[f"{col}_标记"]
            if flag == "⚠️ 异常":
                has_any_warn = True
            elif flag == "🌟 优秀":
                has_any_excellent = True
            dir_sign = "+" if diff >= 0 else ""
            rate_str = f"{rate:+.1f}%" if rate is not None else "N/A"
            lines.append(f"     {label:12s}: {old_v:5d} → {new_v:5d}  ({dir_sign}{diff} 条, 波动 {rate_str})  {flag}")
        lines.append("")

    # ---- 质量部分 ----
    lines.append("━" * 80)
    lines.append("  【二、团队质量波动】")
    lines.append("  （注：质量通过率 = 各批次通过数之和 / 各批次总量之和）")
    lines.append("━" * 80)
    lines.append("")

    for _, row in quality.iterrows():
        team = row["团队"]
        lines.append(f"  ▸ {team}")

        # 质检
        qc_old_val = row['质检通过率_old']
        qc_new_val = row['质检通过率_new']
        qc_diff = row["质检差值"]
        qc_rate = row["质检波动率"]
        qc_flag = row["质检标记"]
        if qc_flag == "⚠️ 异常":
            has_any_warn = True
        elif qc_flag == "🌟 优秀":
            has_any_excellent = True

        if qc_old_val is not None and qc_new_val is not None:
            qc_old_str = f"{qc_old_val}% ({int(row['质检_pass_old'])}/{int(row['质检_total_old'])})"
            qc_new_str = f"{qc_new_val}% ({int(row['质检_pass_new'])}/{int(row['质检_total_new'])})"
            dir_q = "+" if qc_diff >= 0 else ""
            rate_q_str = f"{qc_rate:+.1f}%" if qc_rate is not None else "N/A"
            lines.append(f"     🛡️ 质检通过率:  {qc_old_str} → {qc_new_str}")
            lines.append(f"                  差值 {dir_q}{qc_diff}pp, 波动 {rate_q_str}  {qc_flag}")
        else:
            lines.append(f"     🛡️ 质检通过率:  暂无质量数据")

        # 验收
        ac_old_val = row['验收通过率_old']
        ac_new_val = row['验收通过率_new']
        ac_diff = row["验收差值"]
        ac_rate = row["验收波动率"]
        ac_flag = row["验收标记"]
        if ac_flag == "⚠️ 异常":
            has_any_warn = True
        elif ac_flag == "🌟 优秀":
            has_any_excellent = True

        if ac_old_val is not None and ac_new_val is not None:
            ac_old_str = f"{ac_old_val}% ({int(row['验收_pass_old'])}/{int(row['验收_total_old'])})"
            ac_new_str = f"{ac_new_val}% ({int(row['验收_pass_new'])}/{int(row['验收_total_new'])})"
            dir_a = "+" if ac_diff >= 0 else ""
            rate_a_str = f"{ac_rate:+.1f}%" if ac_rate is not None else "N/A"
            lines.append(f"     🎯 验收通过率:  {ac_old_str} → {ac_new_str}")
            lines.append(f"                  差值 {dir_a}{ac_diff}pp, 波动 {rate_a_str}  {ac_flag}")
        else:
            lines.append(f"     🎯 验收通过率:  暂无质量数据")
        lines.append("")

    # ---- 汇总 ----
    lines.append("=" * 80)
    if has_any_warn:
        lines.append("⚠️  存在负向波动超 10% 的指标，请关注！")
    if has_any_excellent:
        lines.append("🌟 存在正向波动超 10% 的优秀指标，请继续保持！")
    if not has_any_warn and not has_any_excellent:
        lines.append("✅ 所有指标波动率均在 10% 以内。")
    lines.append("=" * 80)

    report_text = "\n".join(lines)
    print(report_text)

    # ---- 保存文本日报 ----
    txt_path = os.path.join(DATA_DIR, f"日报_{new_date_str}.txt")
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(report_text)
    print(f"\n📄 文本日报已保存: {txt_path}")

    # ---- 保存 Excel 日报 ----
    xlsx_path = os.path.join(DATA_DIR, f"日报_{new_date_str}.xlsx")
    with pd.ExcelWriter(xlsx_path, engine="xlsxwriter") as writer:
        # Sheet 1: 进度
        prog_out_cols = ["团队"]
        for col in progress_cols:
            prog_out_cols += [f"{col}_old", f"{col}_new", f"{col}_差值", f"{col}_波动率", f"{col}_标记"]
        prog_out = progress[prog_out_cols].copy()
        rename_map = {"团队": "团队"}
        for col in progress_cols:
            rename_map[f"{col}_old"] = f"{col}({old_date_str})"
            rename_map[f"{col}_new"] = f"{col}({new_date_str})"
            rename_map[f"{col}_差值"] = f"{col}差值"
            rename_map[f"{col}_波动率"] = f"{col}波动率(%)"
            rename_map[f"{col}_标记"] = f"{col}标记"
        prog_out = prog_out.rename(columns=rename_map)
        prog_out.to_excel(writer, sheet_name="团队进度波动", index=False)

        # Sheet 2: 质量
        qual_out = quality[[
            "团队",
            "质检_pass_old", "质检_total_old", "质检通过率_old",
            "质检_pass_new", "质检_total_new", "质检通过率_new",
            "质检差值", "质检波动率", "质检标记",
            "验收_pass_old", "验收_total_old", "验收通过率_old",
            "验收_pass_new", "验收_total_new", "验收通过率_new",
            "验收差值", "验收波动率", "验收标记",
        ]].copy()
        q_rename = {
            "团队": "团队",
            "质检_pass_old": f"质检通过数({old_date_str})", "质检_total_old": f"质检总量({old_date_str})",
            "质检通过率_old": f"质检通过率({old_date_str})",
            "质检_pass_new": f"质检通过数({new_date_str})", "质检_total_new": f"质检总量({new_date_str})",
            "质检通过率_new": f"质检通过率({new_date_str})",
            "质检差值": "质检差值(pp)", "质检波动率": "质检波动率(%)", "质检标记": "质检标记",
            "验收_pass_old": f"验收通过数({old_date_str})", "验收_total_old": f"验收总量({old_date_str})",
            "验收通过率_old": f"验收通过率({old_date_str})",
            "验收_pass_new": f"验收通过数({new_date_str})", "验收_total_new": f"验收总量({new_date_str})",
            "验收通过率_new": f"验收通过率({new_date_str})",
            "验收差值": "验收差值(pp)", "验收波动率": "验收波动率(%)", "验收标记": "验收标记",
        }
        qual_out = qual_out.rename(columns=q_rename)
        qual_out.to_excel(writer, sheet_name="团队质量波动", index=False)

        # 条件格式
        warn_fmt = writer.book.add_format({"bg_color": "#FFC7CE", "font_color": "#9C0006"})
        excel_fmt = writer.book.add_format({"bg_color": "#FFD700", "font_color": "#7B5800"})
        ok_fmt = writer.book.add_format({"bg_color": "#C6EFCE", "font_color": "#006100"})

        for ws_name in ["团队进度波动", "团队质量波动"]:
            ws = writer.sheets[ws_name]
            df_sheet = prog_out if ws_name == "团队进度波动" else qual_out
            for col_idx, col_name in enumerate(df_sheet.columns):
                if "标记" in col_name:
                    for row_idx in range(1, len(df_sheet) + 1):
                        val = df_sheet.iloc[row_idx - 1][col_name]
                        if val == "⚠️ 异常":
                            ws.write(row_idx, col_idx, val, warn_fmt)
                        elif val == "🌟 优秀":
                            ws.write(row_idx, col_idx, val, excel_fmt)
                        else:
                            ws.write(row_idx, col_idx, val, ok_fmt)
            ws.autofit()

    print(f"📊 Excel 日报已保存: {xlsx_path}")

    # 末尾汇总
    print()
    warn_count = 0
    excel_count = 0
    for df_sheet in [prog_out, qual_out]:
        for c in df_sheet.columns:
            if "标记" in c:
                warn_count += (df_sheet[c] == "⚠️ 异常").sum()
                excel_count += (df_sheet[c] == "🌟 优秀").sum()
    if warn_count > 0 and excel_count > 0:
        print(f"⚠️  共 {warn_count} 项指标出现负向异常  |  🌟 共 {excel_count} 项指标表现优秀")
    elif warn_count > 0:
        print(f"⚠️  共 {warn_count} 项指标出现负向异常，请关注！")
    elif excel_count > 0:
        print(f"🌟 共 {excel_count} 项指标表现优秀！")
    else:
        print("✅ 所有指标波动率均在 10% 以内。")


if __name__ == "__main__":
    main()
