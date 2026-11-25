/* v258 MyLab 匯出：把目前畫面上的清冊下載成 Excel（.xlsx），或用手機／系統的「分享」送出去。
 * 藥品櫃（lab.js）與儀器設備（instruments.js）共用。
 * - 匯出的是「畫面上顯示中的那幾項」（套用目前的篩選與搜尋），檔名會註明；第二張工作表寫匯出時間與條件。
 * - 日期狀態、校正狀態是匯出當下算好的文字，不是公式；之後檔案不會自己更新。
 * - Excel 用頁面已載入的 SheetJS（window.XLSX）；載入失敗時退成 CSV（UTF-8 含 BOM，Excel 直接開不會亂碼）。
 */
(function (root) {
  const REAGENT_COLUMNS = [
    ["code", "編號"], ["name_zh", "中文名稱"], ["name_en", "英文名稱"], ["formula", "化學式"], ["cas", "CAS No."],
    ["brand", "品牌"], ["catalog_no", "貨號"], ["grade", "等級"], ["purity_spec", "純度規格"], ["coa_result", "COA實測"],
    ["lot_no", "批號"], ["purchased_qty", "已知購買量"], ["remaining_qty", "實際餘量"], ["unit", "單位"], ["location", "存放位置"],
    ["opened_date", "開封日期"], ["manufactured_date", "製造日期"], ["released_date", "放行／檢驗日期"], ["expiry_date", "有效期限"],
    ["retest_date", "複驗日期"], ["retest_month", "複驗月份"], ["__status", "日期狀態"], ["used_in", "用於實驗"], ["source", "資料來源"], ["note", "備註"],
  ];
  const INSTRUMENT_COLUMNS = [
    ["code", "編號"], ["name_zh", "中文名稱"], ["name_en", "英文名稱"], ["category", "類別"], ["brand", "品牌"], ["model", "型號"],
    ["serial_no", "序號"], ["asset_no", "財產編號"], ["supplier", "供應商"], ["location", "存放位置"], ["use_status", "使用狀態"],
    ["purchased_date", "購入日期"], ["__required", "需要校正"], ["calibration_cycle_months", "校正週期（月）"], ["last_calibrated_date", "上次校正日期"],
    ["__due", "下次校正日期"], ["__status", "校正狀態"], ["calibration_vendor", "校正單位"], ["source", "資料來源"], ["note", "備註"],
  ];

  function cell(value) { return value === null || value === undefined ? "" : value; }

  /** 藥品列 → 工作表的二維陣列（第一列是表頭） */
  function reagentRows(reagents) {
    const head = REAGENT_COLUMNS.map(([, label]) => label);
    const body = reagents.map((r) => REAGENT_COLUMNS.map(([key]) => {
      if (key === "__status") return [r.status?.text, r.status?.deadline ? `（${r.status.deadline.label} ${r.status.deadline.display}）` : ""].filter(Boolean).join(" ");
      return cell(r[key]);
    }));
    return [head, ...body];
  }

  function instrumentRows(instruments) {
    const head = INSTRUMENT_COLUMNS.map(([, label]) => label);
    const body = instruments.map((r) => INSTRUMENT_COLUMNS.map(([key]) => {
      if (key === "__required") return r.calibration_required === 0 || r.calibration_required === "0" ? "否" : "是";
      if (key === "__due") return r.status?.due ? `${r.status.due.date}${r.status.due.derived ? "（由上次＋週期推算）" : ""}` : "";
      if (key === "__status") return r.status?.text || "";
      return cell(r[key]);
    }));
    return [head, ...body];
  }

  function infoRows({ title, count, total, filterLabel, query, today, extra = [] }) {
    return [
      ["項目", "內容"],
      ["清單", title],
      ["匯出時間", today],
      ["匯出筆數", `${count}／全部 ${total}`],
      ["篩選", filterLabel || "全部"],
      ["搜尋字", query || "（無）"],
      ...extra,
      ["說明", "日期狀態與校正狀態是匯出當天算好的文字，不是公式，之後不會自己更新。要最新狀態請回 MyWiki 查看。"],
    ];
  }

  function columnWidths(rows) {
    const widths = [];
    for (const row of rows) row.forEach((v, i) => {
      const s = String(v ?? "");
      let w = 0;
      for (const ch of s) w += /[⺀-￿]/.test(ch) ? 2 : 1;
      widths[i] = Math.max(widths[i] || 6, Math.min(48, w + 2));
    });
    return widths.map((wch) => ({ wch }));
  }

  function csvEscape(v) {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function toCsv(rows) { return `﻿${rows.map((r) => r.map(csvEscape).join(",")).join("\r\n")}`; }

  /** 檔名：清單名＋日期；有篩選時加上篩選名稱，避免把「需注意」誤當成全部 */
  function fileName(title, today, filterLabel, ext) {
    const tag = filterLabel && filterLabel !== "全部" ? `_${filterLabel}` : "";
    return `${title}_${today}${tag}.${ext}`.replace(/[\\/:*?"<>|]+/g, "_");
  }

  /** 做出 File 物件（xlsx；沒有 SheetJS 時是 csv） */
  function buildFile({ title, sheetName, rows, info, today, filterLabel }) {
    const XLSX = root.XLSX;
    if (XLSX?.utils && XLSX.write) {
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws["!cols"] = columnWidths(rows);
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
      const wsInfo = XLSX.utils.aoa_to_sheet(info);
      wsInfo["!cols"] = columnWidths(info);
      XLSX.utils.book_append_sheet(wb, wsInfo, "匯出說明");
      const bytes = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      return new File([bytes], fileName(title, today, filterLabel, "xlsx"), { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    }
    return new File([toCsv(rows)], fileName(title, today, filterLabel, "csv"), { type: "text/csv;charset=utf-8" });
  }

  function saveFile(file) {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /** 下載 */
  function download(spec) {
    const file = buildFile(spec);
    saveFile(file);
    return file;
  }

  /** 分享：系統有「分享檔案」就用（手機可傳 LINE、Email…）；沒有就退成下載 */
  async function share(spec) {
    const file = buildFile(spec);
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: file.name });
        return { shared: true, file };
      }
    } catch (error) {
      if (error?.name === "AbortError") return { shared: false, cancelled: true, file };
    }
    saveFile(file);
    return { shared: false, file };
  }

  root.LabExport = { reagentRows, instrumentRows, infoRows, columnWidths, toCsv, fileName, buildFile, download, share, REAGENT_COLUMNS, INSTRUMENT_COLUMNS };
})(typeof window !== "undefined" ? window : globalThis);
