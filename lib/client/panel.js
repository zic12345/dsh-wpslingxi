window.__ModuleLoader__.load({
  id: "dsh-wpslingxi",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// plugin-src/client/index.js
var index_exports = {};
__export(index_exports, {
  SETTINGS_TAB_ID: () => SETTINGS_TAB_ID,
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);
var React2 = __toESM(require("react"), 1);

// plugin-src/client/panel.jsx
var React = __toESM(require("react"), 1);

// plugin-src/client/rpc.js
async function callWpsLingxi(connection, method, payload, signal) {
  const result = await connection.rpc.call(
    "/api",
    "wpslingxi",
    { method, payload: payload ?? {} },
    signal
  );
  if (result && result.ok === true) return result.value;
  if (result && result.ok === false) {
    const error = new Error(result.error?.message || "灵犀管理接口请求失败");
    error.code = result.error?.code;
    throw error;
  }
  return result;
}

// plugin-src/client/panel.jsx
var COLORS = {
  primary: "#1a73e8",
  primaryDark: "#1558b0",
  text: "var(--dsh-color-text, #1f2329)",
  sub: "var(--dsh-color-text-secondary, #8a8f99)",
  border: "var(--dsh-color-border, #e5e6eb)",
  bg: "var(--dsh-color-bg, transparent)",
  card: "var(--dsh-color-bg-raised, #f7f8fa)",
  danger: "#d93026",
  warning: "#e8871e",
  success: "#1a9c53"
};
function Card({ children, style }) {
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      style: {
        background: COLORS.card,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 12,
        padding: 16,
        ...style
      }
    },
    children
  );
}
function WpsLingxiPanel({ connection }) {
  const [balance, setBalance] = React.useState(null);
  const [detail, setDetail] = React.useState(null);
  const [checkin, setCheckin] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [claiming, setClaiming] = React.useState(false);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const refresh = React.useCallback(async () => {
    if (!connection) {
      setError("连接服务不可用（connection 缺失），无法与宿主通信。");
      setLoading(false);
      return;
    }
    setError("");
    try {
      const [bal, det, status] = await Promise.all([
        callWpsLingxi(connection, "credits.balance", {}),
        callWpsLingxi(connection, "credits.detail", {}).catch(() => null),
        callWpsLingxi(connection, "checkin.status", {})
      ]);
      setBalance(bal);
      setDetail(det);
      setCheckin(status);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  }, [connection]);
  React.useEffect(() => {
    refresh();
  }, [refresh]);
  const onClaim = React.useCallback(async () => {
    setClaiming(true);
    setError("");
    setNotice("");
    try {
      const result = await callWpsLingxi(connection, "checkin.claim", {});
      if (result.alreadyClaimed) {
        setNotice(`今天已经签到过了（连签第 ${result.todayDay} 天），本次不重复领取。`);
      } else {
        setNotice(`签到成功！获得 ${result.rewardAmount} 智点（连签第 ${result.todayDay} 天）。`);
      }
      await refresh();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setClaiming(false);
    }
  }, [connection, refresh]);
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      style: {
        // 设置页 Tab 容器自带标题与滚动；这里不锁死高度，避免双滚动条。
        maxWidth: 620,
        padding: "4px 0 24px",
        color: COLORS.text,
        fontSize: 14,
        lineHeight: 1.6,
        boxSizing: "border-box"
      }
    },
    /* @__PURE__ */ React.createElement("div", { style: { color: COLORS.sub, marginBottom: 16 } }, "数据来自 Windows 宿主上已登录的「WPS 灵犀」桌面版，模型对话也使用同一份登录态。"),
    loading && /* @__PURE__ */ React.createElement(Card, null, "正在读取灵犀账号信息…"),
    !loading && error && /* @__PURE__ */ React.createElement(Card, { style: { borderColor: COLORS.danger, color: COLORS.danger } }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 600, marginBottom: 4 } }, "暂时无法连接灵犀"), /* @__PURE__ */ React.createElement("div", { style: { color: COLORS.text, whiteSpace: "pre-wrap" } }, error), /* @__PURE__ */ React.createElement("button", { style: buttonStyle("secondary"), onClick: refresh }, "重试")),
    !loading && !error && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Card, { style: { marginBottom: 14 } }, /* @__PURE__ */ React.createElement("div", { style: { color: COLORS.sub, fontSize: 12 } }, "当前智点余额"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 34, fontWeight: 700, margin: "2px 0" } }, balance ? formatNumber(balance.totalBalance) : "—"), balance && balance.totalPurchased > 0 && /* @__PURE__ */ React.createElement("div", { style: { color: COLORS.sub, fontSize: 12 } }, "其中赠送 ", formatNumber(balance.totalBonus), " · 购买 ", formatNumber(balance.totalPurchased)), detail && detail.expiringSoonTotal > 0 && /* @__PURE__ */ React.createElement(
      "div",
      {
        style: {
          marginTop: 10,
          padding: "8px 10px",
          borderRadius: 8,
          background: "rgba(232,135,30,0.1)",
          color: COLORS.warning,
          fontSize: 13
        }
      },
      "⚠️ 近 ",
      detail.expiringWindowDays,
      " 天将到期智点：",
      /* @__PURE__ */ React.createElement("strong", null, " ", formatNumber(detail.expiringSoonTotal)),
      "（",
      detail.expiringSoon.length,
      " 笔），请及时使用。"
    )), /* @__PURE__ */ React.createElement(Card, { style: { marginBottom: 14 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 600 } }, "每日签到"), checkin && /* @__PURE__ */ React.createElement("div", { style: { color: COLORS.sub, fontSize: 12, marginTop: 2 } }, "已连签 ", checkin.consecutiveDays, " 天 · 今日奖励 ", checkin.todayReward, " 智点")), /* @__PURE__ */ React.createElement(
      "button",
      {
        style: buttonStyle(checkin?.claimedToday ? "secondary" : "primary"),
        disabled: claiming,
        onClick: onClaim
      },
      claiming ? "查询中…" : checkin?.claimedToday ? "今日已签到（点击刷新）" : "一键签到"
    )), notice && /* @__PURE__ */ React.createElement(
      "div",
      {
        style: {
          marginTop: 10,
          padding: "8px 10px",
          borderRadius: 8,
          background: "rgba(26,156,83,0.1)",
          color: COLORS.success,
          fontSize: 13
        }
      },
      notice
    ), checkin?.days?.length > 0 && /* @__PURE__ */ React.createElement(CheckInDays, { days: checkin.days })), detail && detail.bonusPools.length > 0 && /* @__PURE__ */ React.createElement(Card, { style: { marginBottom: 14 } }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 600, marginBottom: 8 } }, "赠送智点明细（", detail.bonusPools.length, " 笔，按到期先后排序）"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, detail.bonusPools.map((pool, idx) => /* @__PURE__ */ React.createElement(PoolRow, { key: idx, pool, windowDays: detail.expiringWindowDays })))), detail && detail.recentTransactions.length > 0 && /* @__PURE__ */ React.createElement(Card, { style: { marginBottom: 14 } }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 600, marginBottom: 8 } }, "最近积分流水"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, detail.recentTransactions.slice(0, 12).map((tx, idx) => /* @__PURE__ */ React.createElement(TxRow, { key: idx, tx })))), /* @__PURE__ */ React.createElement("button", { style: buttonStyle("secondary"), onClick: refresh }, "刷新"))
  );
}
function PoolRow({ pool, windowDays }) {
  const soon = pool.balance > 0 && daysUntil(pool.expireTime) <= windowDays;
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      style: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        fontSize: 13,
        padding: "6px 8px",
        borderRadius: 6,
        background: soon ? "rgba(232,135,30,0.08)" : "transparent"
      }
    },
    /* @__PURE__ */ React.createElement("div", { style: { minWidth: 0, flex: 1 } }, /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 600, color: soon ? COLORS.warning : COLORS.text } }, formatNumber(pool.balance), " 智点"), /* @__PURE__ */ React.createElement("div", { style: { color: COLORS.sub, fontSize: 12 } }, "入账 ", formatShortDate(pool.effectTime), " · 到期 ", formatShortDate(pool.expireTime), soon && pool.balance > 0 ? `（${daysUntil(pool.expireTime)} 天后到期）` : "", pool.balance <= 0 ? "（已用完）" : ""))
  );
}
function TxRow({ tx }) {
  const isIncome = tx.amount >= 0;
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 } }, /* @__PURE__ */ React.createElement("div", { style: { minWidth: 0, flex: 1, paddingRight: 12 } }, /* @__PURE__ */ React.createElement(
    "div",
    {
      style: {
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      },
      title: tx.taskName
    },
    tx.taskName || tx.remark || (isIncome ? "智点赠送" : "消费")
  ), /* @__PURE__ */ React.createElement("div", { style: { color: COLORS.sub, fontSize: 12 } }, formatDateTime(tx.time), tx.source ? ` · ${tx.source}` : "")), /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 600, color: isIncome ? COLORS.success : COLORS.text } }, isIncome ? "+" : "", formatNumber(tx.amount)));
}
function CheckInDays({ days }) {
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 6, marginTop: 14, flexWrap: "wrap" } }, days.map((day) => /* @__PURE__ */ React.createElement(
    "div",
    {
      key: day.day,
      title: `${day.date} · ${day.reward} 智点`,
      style: {
        width: 40,
        padding: "6px 0",
        textAlign: "center",
        borderRadius: 8,
        border: `1px solid ${day.status === "claimed" ? COLORS.success : COLORS.border}`,
        background: day.status === "claimed" ? "rgba(26,156,83,0.08)" : "transparent",
        color: day.status === "locked" ? COLORS.sub : COLORS.text,
        fontSize: 12
      }
    },
    /* @__PURE__ */ React.createElement("div", null, "第", day.day, "天"),
    /* @__PURE__ */ React.createElement("div", { style: { fontWeight: 600 } }, day.reward)
  )));
}
function buttonStyle(kind) {
  const base = {
    border: "none",
    borderRadius: 8,
    padding: "8px 16px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    marginTop: 10
  };
  if (kind === "primary") {
    return { ...base, background: COLORS.primary, color: "#fff" };
  }
  return {
    ...base,
    background: "transparent",
    color: COLORS.sub,
    border: `1px solid ${COLORS.border}`
  };
}
function formatNumber(value) {
  try {
    return Number(value).toLocaleString("zh-CN");
  } catch {
    return String(value);
  }
}
function formatDateTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return iso;
  }
}
function formatShortDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  } catch {
    return iso;
  }
}
function daysUntil(iso) {
  if (!iso) return Infinity;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return Infinity;
  return Math.floor((ms - Date.now()) / (24 * 60 * 60 * 1e3));
}
function friendlyError(err) {
  const code = err?.code || "";
  const message = err?.message || String(err);
  if (code === "UNAUTHORIZED") {
    return "灵犀登录态已失效，请在 Windows 宿主打开「WPS 灵犀」桌面版重新登录后再点刷新。";
  }
  if (code === "NOT_WSL" || /not.*wsl|非 WSL/i.test(message)) {
    return "当前 DSH 不在 WSL 中运行，无法读取 Windows 宿主的灵犀登录态。";
  }
  if (code === "NETWORK") {
    return `网络不可达：${message}
请确认 WSL 能访问 https://lingxi.wps.cn 且宿主联网。`;
  }
  if (/cookie|DPAPI|Cookies|encrypted/i.test(message)) {
    return `读取桌面登录态失败：${message}
请确认已安装并登录「WPS 灵犀」桌面版。`;
  }
  return message;
}

// plugin-src/client/index.js
var name = "dsh-wpslingxi-client";
var inject = ["slots", "connection"];
var SETTINGS_TAB_ID = "dsh-wpslingxi";
var TAB_ORDER = 100;
function WpsLingxiSettingsPage({ connection }) {
  return /* @__PURE__ */ React2.createElement(WpsLingxiPanel, { connection });
}
function apply(ctx) {
  const slots = ctx.slots;
  slots.inject(
    "settings.plugins.tab",
    () => slots.register(
      {
        name: "settings.plugins.tab",
        id: SETTINGS_TAB_ID,
        order: TAB_ORDER,
        label: () => "WPS 灵犀",
        inject: () => ({ connection: ctx.connection })
      },
      WpsLingxiSettingsPage
    )
  );
}

    return module.exports;
  }
});
