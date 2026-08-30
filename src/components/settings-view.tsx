"use client";

import { AlertTriangle, Download, KeyRound, Plus, RotateCcw, Save, ShieldCheck, Trash2, Upload, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { BackLink } from "./back-link";
import { CatIcon } from "./cat-icon";

type DaySegment = "morning" | "afternoon" | "evening";
type EnergyLevel = "low" | "medium" | "high";
type RoutineTimeSegment = "morning" | "afternoon" | "evening" | "specific_window";

type Routine = {
  id: string;
  title: string;
  defaultTimeSegment: RoutineTimeSegment;
  defaultStartTime: string | null;
  defaultEndTime: string | null;
  weekdayPattern: string;
  estimatedMinutes: number;
  energyLevel: EnergyLevel;
};

type SegmentEnergySetting = {
  segment: DaySegment;
  energyLevel: EnergyLevel;
};

type McpPermission = "read_only" | "review_only" | "read_write";

type McpToken = {
  id: string;
  name: string;
  permission: McpPermission;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

type McpConnection = {
  url: string;
  codexConfig: string;
};

type McpTokensResponse = {
  workspaceId: string;
  tokens: McpToken[];
  mcp: McpConnection;
};

type ClaudeConnectorAuthorization = {
  id: string;
  clientName: string;
  permission: McpPermission;
  scope: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

type ClaudeConnectorResponse = {
  mcpUrl: string;
  protectedResourceMetadataUrl: string;
  authorizationServerMetadataUrl: string;
  authorizations: ClaudeConnectorAuthorization[];
};

const staticClaudeOAuthClientId = "pawplan_claude_custom_connector";

type MetadataStatus = "idle" | "verified" | "failed";

type TokenForm = {
  name: string;
  permission: McpPermission;
  expiresInDays: number | null;
};

type SettingsResponse = {
  routines: Routine[];
  segmentEnergySettings: SegmentEnergySetting[];
  agentRuns: AgentRunSummary[];
  recoveryTarget: {
    minutes: number;
    editable: false;
    source: "system_default";
  };
};

type AgentRunSummary = {
  id: string;
  kind: "morning_rebalance" | "evening_review" | "weekly_rebalance";
  status: "started" | "draft_created" | "no_change" | "duplicate" | "failed";
  patchId: string | null;
  reason: string;
  createdAt: string;
  warningCount: number;
  errorMessage: string | null;
};

type TemplateImportResult = {
  planId: string;
  tasksCreated: number;
  routinesCreated: number;
  timeBlocksCreated: number;
};

type RoutineForm = Omit<Routine, "id"> & { id?: string };

const segmentLabels: Record<DaySegment | RoutineTimeSegment, string> = {
  morning: "上午",
  afternoon: "下午",
  evening: "晚上",
  specific_window: "指定时间",
};

const energyLabels: Record<EnergyLevel, string> = {
  low: "低",
  medium: "中",
  high: "高",
};

const mcpPermissionLabels: Record<McpPermission, string> = {
  read_only: "只读",
  review_only: "仅审核",
  read_write: "读写",
};

const agentRunKindLabels: Record<AgentRunSummary["kind"], string> = {
  morning_rebalance: "Morning rebalance",
  evening_review: "Evening review",
  weekly_rebalance: "Weekly rebalance",
};

const agentRunStatusLabels: Record<AgentRunSummary["status"], string> = {
  started: "started",
  draft_created: "draft created",
  no_change: "no change",
  duplicate: "duplicate",
  failed: "failed",
};

const defaultEnergySettings: SegmentEnergySetting[] = [
  { segment: "morning", energyLevel: "high" },
  { segment: "afternoon", energyLevel: "medium" },
  { segment: "evening", energyLevel: "low" },
];

const emptyRoutineForm: RoutineForm = {
  title: "",
  defaultTimeSegment: "morning",
  defaultStartTime: null,
  defaultEndTime: null,
  weekdayPattern: "daily",
  estimatedMinutes: 30,
  energyLevel: "low",
};

const recoveryTarget = {
  minutes: 480,
  editable: false,
  source: "system_default" as const,
};

const emptyTokenForm: TokenForm = {
  name: "Codex local",
  permission: "review_only",
  expiresInDays: null,
};

function formatHours(minutes: number) {
  return `${Math.round(minutes / 60)} 小时`;
}

function formatDateTime(value: string | null) {
  if (!value) return "不过期";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function routinePayload(form: RoutineForm) {
  return {
    ...form,
    title: form.title.trim(),
    weekdayPattern: form.weekdayPattern.trim(),
    defaultStartTime: form.defaultStartTime || null,
    defaultEndTime: form.defaultEndTime || null,
  };
}

function metadataStatusLabel(status: MetadataStatus) {
  if (status === "verified") return "Metadata verified";
  if (status === "failed") return "Metadata failed";
  return "Checking metadata";
}

export function SettingsView() {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [energySettings, setEnergySettings] = useState<SegmentEnergySetting[]>(defaultEnergySettings);
  const [routineForm, setRoutineForm] = useState<RoutineForm>(emptyRoutineForm);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [dataUnavailable, setDataUnavailable] = useState(false);
  const [mcpWorkspaceId, setMcpWorkspaceId] = useState<string | null>(null);
  const [mcpConnection, setMcpConnection] = useState<McpConnection | null>(null);
  const [mcpTokens, setMcpTokens] = useState<McpToken[]>([]);
  const [tokenForm, setTokenForm] = useState<TokenForm>(emptyTokenForm);
  const [rawToken, setRawToken] = useState<string | null>(null);
  const [mcpMessage, setMcpMessage] = useState<string | null>(null);
  const [claudeConnector, setClaudeConnector] = useState<ClaudeConnectorResponse | null>(null);
  const [claudeConnectorMessage, setClaudeConnectorMessage] = useState<string | null>(null);
  const [metadataStatus, setMetadataStatus] = useState<{
    protectedResource: MetadataStatus;
    authorizationServer: MetadataStatus;
  }>({ protectedResource: "idle", authorizationServer: "idle" });
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceDeleteConfirmation, setWorkspaceDeleteConfirmation] = useState("");
  const [workspaceDeleteMessage, setWorkspaceDeleteMessage] = useState<string | null>(null);
  const [templateMessage, setTemplateMessage] = useState<string | null>(null);
  const [agentRuns, setAgentRuns] = useState<AgentRunSummary[]>([]);

  const isEditing = Boolean(routineForm.id);
  const activeRecoveryTarget = useMemo(() => recoveryTarget, []);
  const trimmedWorkspaceName = workspaceName.trim();
  const expectedWorkspaceDeleteConfirmation = trimmedWorkspaceName ? `DELETE ${trimmedWorkspaceName}` : "";
  const canDeleteWorkspace =
    Boolean(expectedWorkspaceDeleteConfirmation) && workspaceDeleteConfirmation === expectedWorkspaceDeleteConfirmation;
  const activeClaudeAuthorizations = claudeConnector?.authorizations.filter((authorization) => !authorization.revokedAt) ?? [];

  useEffect(() => {
    let active = true;

    async function loadSettings() {
      try {
        const response = await fetch("/api/settings");
        if (!response.ok) {
          if (active) {
            setDataUnavailable(true);
            setMessage("当前数据源未配置，设置页会显示默认值但无法保存。");
          }
          return;
        }

        const data = (await response.json()) as SettingsResponse;
        if (!active) return;
        setRoutines(data.routines ?? []);
        setEnergySettings(data.segmentEnergySettings ?? defaultEnergySettings);
        setAgentRuns(data.agentRuns ?? []);
        setDataUnavailable(false);
      } catch {
        if (!active) return;
        setDataUnavailable(true);
        setMessage("设置读取失败，请稍后重试。");
      }
    }

    void loadSettings();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!claudeConnector) return;
    const connector = claudeConnector;
    let active = true;

    async function verifyMetadata() {
      setMetadataStatus({ protectedResource: "idle", authorizationServer: "idle" });
      const [protectedResource, authorizationServer] = await Promise.all([
        fetch(connector.protectedResourceMetadataUrl)
          .then(async (response) => {
            if (!response.ok) return "failed" as const;
            const body = (await response.json()) as { resource?: string };
            return body.resource === connector.mcpUrl ? ("verified" as const) : ("failed" as const);
          })
          .catch(() => "failed" as const),
        fetch(connector.authorizationServerMetadataUrl)
          .then(async (response) => {
            if (!response.ok) return "failed" as const;
            const body = (await response.json()) as { scopes_supported?: string[] };
            return body.scopes_supported?.includes("mcp") ? ("verified" as const) : ("failed" as const);
          })
          .catch(() => "failed" as const),
      ]);
      if (active) setMetadataStatus({ protectedResource, authorizationServer });
    }

    void verifyMetadata();
    return () => {
      active = false;
    };
  }, [claudeConnector]);

  useEffect(() => {
    let active = true;

    async function loadClaudeConnector() {
      try {
        const response = await fetch("/api/oauth/authorizations");
        if (!response.ok) {
          if (active) setClaudeConnectorMessage("Claude connector 状态读取失败。");
          return;
        }
        const data = (await response.json()) as ClaudeConnectorResponse;
        if (!active) return;
        setClaudeConnector(data);
        setClaudeConnectorMessage(null);
      } catch {
        if (active) setClaudeConnectorMessage("Claude connector 状态读取失败。");
      }
    }

    void loadClaudeConnector();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    async function loadMcpTokens() {
      try {
        const response = await fetch("/api/mcp-tokens");
        if (!response.ok) {
          if (active) setMcpMessage("MCP 连接信息读取失败。");
          return;
        }
        const data = (await response.json()) as McpTokensResponse;
        if (!active) return;
        setMcpWorkspaceId(data.workspaceId);
        setMcpTokens(data.tokens ?? []);
        setMcpConnection(data.mcp);
        setMcpMessage(null);
      } catch {
        if (active) setMcpMessage("MCP 连接信息读取失败。");
      }
    }

    void loadMcpTokens();
    return () => {
      active = false;
    };
  }, []);

  function updateEnergy(segment: DaySegment, energyLevel: EnergyLevel) {
    setEnergySettings((current) =>
      current.map((setting) => (setting.segment === segment ? { ...setting, energyLevel } : setting)),
    );
  }

  async function saveEnergy() {
    setPending("energy");
    const response = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save_energy", settings: energySettings }),
    });
    setPending(null);

    if (!response.ok) {
      setMessage("能量规则保存失败。");
      return;
    }
    setMessage("能量规则已保存。");
  }

  async function saveRoutine(event: React.FormEvent) {
    event.preventDefault();
    if (!routineForm.title.trim()) {
      setMessage("日常事项需要标题。");
      return;
    }

    setPending("routine");
    const response = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "upsert_routine", routine: routinePayload(routineForm) }),
    });
    const data = (await response.json()) as { routine?: Routine; error?: string };
    setPending(null);

    if (!response.ok || !data.routine) {
      setMessage(data.error ?? "日常事项保存失败。");
      return;
    }

    setRoutines((current) => {
      if (!routineForm.id) return [...current, data.routine as Routine];
      return current.map((routine) => (routine.id === data.routine?.id ? (data.routine as Routine) : routine));
    });
    setRoutineForm(emptyRoutineForm);
    setMessage("日常事项已保存。");
  }

  async function deleteExistingRoutine(id: string) {
    setPending(id);
    const response = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete_routine", id }),
    });
    setPending(null);

    if (!response.ok) {
      setMessage("日常事项删除失败。");
      return;
    }

    setRoutines((current) => current.filter((routine) => routine.id !== id));
    if (routineForm.id === id) setRoutineForm(emptyRoutineForm);
    setMessage("日常事项已删除。");
  }

  async function createToken(event: React.FormEvent) {
    event.preventDefault();
    if (!tokenForm.name.trim()) {
      setMcpMessage("Token 名称不能为空。");
      return;
    }

    setPending("mcp-token");
    setRawToken(null);
    const response = await fetch("/api/mcp-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...tokenForm, name: tokenForm.name.trim() }),
    });
    const data = (await response.json()) as { token?: McpToken; rawToken?: string; error?: string };
    setPending(null);

    if (!response.ok || !data.token || !data.rawToken) {
      setMcpMessage(data.error ?? "MCP token 创建失败。");
      return;
    }

    setMcpTokens((current) => [data.token as McpToken, ...current]);
    setRawToken(data.rawToken);
    setTokenForm(emptyTokenForm);
    setMcpMessage("Token 已创建。raw token 只会显示这一次。");
  }

  async function revokeToken(token: McpToken) {
    setPending(token.id);
    const response = await fetch("/api/mcp-tokens", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "revoke", id: token.id }),
    });
    setPending(null);

    if (!response.ok) {
      setMcpMessage("MCP token 撤销失败。");
      return;
    }

    setMcpTokens((current) =>
      current.map((item) => (item.id === token.id ? { ...item, revokedAt: item.revokedAt ?? new Date().toISOString() } : item)),
    );
    setMcpMessage("MCP token 已撤销。");
  }

  async function revokeClaudeAuthorization(authorization: ClaudeConnectorAuthorization) {
    setPending(authorization.id);
    const response = await fetch("/api/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorizationId: authorization.id }),
    });
    setPending(null);

    if (!response.ok) {
      setClaudeConnectorMessage("Claude connector 撤销失败。");
      return;
    }

    setClaudeConnector((current) => {
      if (!current) return current;
      return {
        ...current,
        authorizations: current.authorizations.map((item) =>
          item.id === authorization.id ? { ...item, revokedAt: item.revokedAt ?? new Date().toISOString() } : item,
        ),
      };
    });
    setClaudeConnectorMessage("Claude connector 已撤销。");
  }

  async function exportTemplate() {
    setPending("template-export");
    setTemplateMessage(null);
    const response = await fetch("/api/templates/export");
    setPending(null);

    if (!response.ok) {
      setTemplateMessage("模板导出失败。");
      return;
    }

    const template = await response.json();
    const blob = new Blob([JSON.stringify(template, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `pawplan-template-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setTemplateMessage("计划空间模板已导出。");
  }

  async function importTemplate(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setPending("template-import");
    setTemplateMessage(null);
    try {
      const template = JSON.parse(await file.text());
      const response = await fetch("/api/templates/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template, mode: "new_plan" }),
      });
      const data = (await response.json()) as TemplateImportResult & { error?: string };
      if (!response.ok) {
        setTemplateMessage(data.error ?? "模板导入失败。");
        return;
      }
      setTemplateMessage(
        `模板已导入：${data.tasksCreated} 个任务、${data.routinesCreated} 项日常安排、${data.timeBlocksCreated} 个固定日程。`,
      );
    } catch {
      setTemplateMessage("模板导入失败。");
    } finally {
      setPending(null);
    }
  }

  async function deleteWorkspace(event: React.FormEvent) {
    event.preventDefault();
    if (!canDeleteWorkspace) {
      setWorkspaceDeleteMessage("请输入完整确认短语。");
      return;
    }

    setPending("workspace-delete");
    const response = await fetch("/api/workspace", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: workspaceDeleteConfirmation }),
    });
    const data = (await response.json()) as { deleted?: boolean; error?: string };
    setPending(null);

    if (!response.ok || !data.deleted) {
      setWorkspaceDeleteMessage(data.error ?? "计划空间删除失败。");
      return;
    }

    window.location.replace("/login");
  }

  return (
    <div className="paw-page">
      <section className="paw-page-header">
        <BackLink />
        <h1 className="paw-page-date">设置</h1>
        <div className="paw-agent-row">
          <CatIcon size={40} mood="sleep" />
          <p className="paw-agent-msg">不常改的规则放这里，Today 保持干净。</p>
        </div>
        <div className="paw-status-pills">
          <span className="paw-status-pill">恢复时间：系统默认 {formatHours(activeRecoveryTarget.minutes)}</span>
          {dataUnavailable ? <span className="paw-status-pill warn">数据源未配置</span> : null}
          {message ? <span className="paw-status-pill link">{message}</span> : null}
        </div>
      </section>

      <section className="paw-list-card mb-4">
        <div className="paw-list-header">
          <div>
            <h2 className="paw-list-title">助手运行记录</h2>
            <p className="paw-list-subtitle">最近无人值守运行历史；不代表外部连接当前在线。</p>
          </div>
          <span className="paw-status-pill">最近 {agentRuns.length} 条</span>
        </div>

        <div className="paw-list mt-4">
          {agentRuns.length === 0 ? (
            <div className="paw-empty">
              <h3>还没有助手运行记录</h3>
              <p>早间调整、晚间审核或每周调整运行后会显示在这里。</p>
            </div>
          ) : (
            agentRuns.map((run) => (
              <div key={run.id} className="paw-list-row">
                <div className="min-w-0">
                  <p className="paw-row-title">
                    {agentRunStatusLabels[run.status]} · {agentRunKindLabels[run.kind]}
                  </p>
                  <p className="paw-row-meta paw-wrap-anywhere">
                    {formatDateTime(run.createdAt)} · {run.reason} · 提醒 {run.warningCount}
                  </p>
                  {run.status === "failed" && run.errorMessage ? (
                    <p className="paw-row-meta paw-wrap-anywhere text-[var(--app-danger)]">{run.errorMessage}</p>
                  ) : null}
                </div>
                <div className="paw-row-actions">
                  <span className={run.status === "failed" ? "paw-status-pill warn" : "paw-status-pill link"}>{run.status}</span>
                  {run.patchId ? (
                    <a href="/review" className="paw-secondary-btn !px-3 !py-2 !text-xs">
                      审核
                    </a>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="paw-list-card mb-4">
        <div className="paw-list-header">
          <div>
            <h2 className="paw-list-title">计划空间模板</h2>
            <p className="paw-list-subtitle">导出可复用的计划结构，不包含令牌、收工反馈或进度历史。</p>
          </div>
          <span className="paw-more-icon">
            <Download size={18} />
          </span>
        </div>

        <div className="paw-save-row !mt-4">
          <button
            type="button"
            disabled={pending === "template-export"}
            onClick={() => void exportTemplate()}
            className="paw-primary-btn !px-4 !py-2 !text-sm"
          >
            <Download size={15} />
            {pending === "template-export" ? "正在导出" : "导出计划空间模板"}
          </button>
          <label className="paw-secondary-btn !px-4 !py-2 !text-sm">
            <Upload size={15} />
            导入模板
            <input
              type="file"
              accept="application/json,.json"
              disabled={pending === "template-import"}
              onChange={(event) => void importTemplate(event)}
              className="sr-only"
            />
          </label>
          {templateMessage ? <span className="paw-status-pill link">{templateMessage}</span> : null}
        </div>
      </section>

      <section className="paw-list-card mb-4">
        <div className="paw-list-header">
          <div>
            <h2 className="paw-list-title">Codex bearer token 连接配置</h2>
            <p className="paw-list-subtitle">生成可撤销的计划空间令牌，用托管 MCP 连接 PawPlan。</p>
          </div>
          <span className="paw-more-icon">
            <KeyRound size={18} />
          </span>
        </div>

        <div className="paw-mcp-grid mt-4">
          <div className="paw-mcp-info">
            <p className="paw-field-label">计划空间 ID</p>
            <p className="paw-mcp-value">{mcpWorkspaceId ?? "读取中"}</p>
          </div>
          <div className="paw-mcp-info">
            <p className="paw-field-label">托管 MCP 地址</p>
            <p className="paw-mcp-value">{mcpConnection?.url ?? "读取中"}</p>
          </div>
        </div>

        <form onSubmit={createToken} className="mt-4 grid gap-3 border-y border-[var(--app-line)] py-4">
          <div className="grid gap-3 md:grid-cols-[1fr_180px_160px]">
            <label>
              <span className="paw-field-label">Token 名称</span>
              <input
                value={tokenForm.name}
                onChange={(event) => setTokenForm((current) => ({ ...current, name: event.target.value }))}
                className="paw-input"
                placeholder="Codex local"
              />
            </label>
            <label>
              <span className="paw-field-label">权限</span>
              <select
                value={tokenForm.permission}
                onChange={(event) =>
                  setTokenForm((current) => ({ ...current, permission: event.target.value as McpPermission }))
                }
                className="paw-input"
              >
                <option value="read_only">只读</option>
                <option value="review_only">仅审核</option>
                <option value="read_write">读写</option>
              </select>
            </label>
            <label>
              <span className="paw-field-label">有效期</span>
              <select
                value={tokenForm.expiresInDays ?? "never"}
                onChange={(event) =>
                  setTokenForm((current) => ({
                    ...current,
                    expiresInDays: event.target.value === "never" ? null : Number(event.target.value),
                  }))
                }
                className="paw-input"
              >
                <option value="never">不过期</option>
                <option value="30">30 天</option>
                <option value="90">90 天</option>
              </select>
            </label>
          </div>
          <div className="paw-save-row !mt-0">
            <button type="submit" disabled={pending === "mcp-token"} className="paw-primary-btn !px-4 !py-2 !text-sm">
              <KeyRound size={15} />
              {pending === "mcp-token" ? "创建中" : "创建 token"}
            </button>
            {mcpMessage ? <span className="paw-status-pill link">{mcpMessage}</span> : null}
          </div>
        </form>

        {rawToken ? (
          <div className="paw-token-once mt-4" role="status">
            <div>
              <h3 className="paw-more-label">Raw token</h3>
              <p className="paw-more-text">只显示这一次。关闭或刷新页面后，Settings 只保留 token 元数据。</p>
            </div>
            <code>{rawToken}</code>
          </div>
        ) : null}

        <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_0.85fr]">
          <div>
            <h3 className="paw-more-label">Codex config</h3>
            <pre className="paw-code-block">{mcpConnection?.codexConfig ?? "读取中"}</pre>
            <p className="paw-more-text mt-2">本地启动 Codex 前设置环境变量 PAWPLAN_MCP_TOKEN，值使用刚创建的 raw token。</p>
          </div>
          <div>
            <h3 className="paw-more-label">Bearer token 边界</h3>
            <p className="paw-more-text">
              这里的 raw token 只给 Codex/local MCP secret 使用。Claude Custom Connector 使用下面的 OAuth connector，不要把 raw token
              放进 URL、query 或聊天记录。
            </p>
          </div>
        </div>

        <div className="paw-list mt-4">
          {mcpTokens.length === 0 ? (
            <div className="paw-empty">
              <h3>还没有 MCP token</h3>
              <p>按实际用途选择“读取”或“仅审核”；只有可信、明确授权的直接写入流程才使用“读写”。</p>
            </div>
          ) : (
            mcpTokens.map((token) => (
              <div key={token.id} className="paw-list-row">
                <div className="min-w-0">
                  <p className="paw-row-title">{token.name}</p>
                  <p className="paw-row-meta">
                    {mcpPermissionLabels[token.permission]} · 创建 {formatDateTime(token.createdAt)} · 到期{" "}
                    {formatDateTime(token.expiresAt)}
                  </p>
                </div>
                <div className="paw-row-actions">
                  {token.revokedAt ? <span className="paw-status-pill warn">已撤销</span> : null}
                  <button
                    type="button"
                    disabled={Boolean(token.revokedAt) || pending === token.id}
                    onClick={() => void revokeToken(token)}
                    aria-label={`撤销 ${token.name}`}
                    className="paw-secondary-btn !px-3 !py-2 !text-xs text-[var(--app-danger)]"
                  >
                    <Trash2 size={13} />
                    撤销
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="paw-list-card mb-4">
        <div className="paw-list-header">
          <div>
            <h2 className="paw-list-title">Claude Custom Connector</h2>
            <p className="paw-list-subtitle">Claude 通过 OAuth authorization code + PKCE 授权，不需要复制 raw bearer token。</p>
          </div>
          <span className="paw-more-icon">
            <KeyRound size={18} />
          </span>
        </div>

        <div className="paw-mcp-grid mt-4">
          <div className="paw-mcp-info">
            <p className="paw-field-label">Claude Connector URL</p>
            <p className="paw-mcp-value">{claudeConnector?.mcpUrl ?? "读取中"}</p>
          </div>
          <div className="paw-mcp-info">
            <p className="paw-field-label">OAuth Client ID</p>
            <p className="paw-mcp-value">{staticClaudeOAuthClientId}</p>
          </div>
          <div className="paw-mcp-info">
            <p className="paw-field-label">OAuth 状态</p>
            <p className="paw-mcp-value">{activeClaudeAuthorizations.length > 0 ? "已授权" : "未授权"}</p>
          </div>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div>
            <h3 className="paw-more-label">Protected resource metadata</h3>
            <p className="paw-mcp-value">{claudeConnector?.protectedResourceMetadataUrl ?? "读取中"}</p>
            <span className={metadataStatus.protectedResource === "failed" ? "paw-status-pill warn" : "paw-status-pill link"}>
              {metadataStatusLabel(metadataStatus.protectedResource)}
            </span>
          </div>
          <div>
            <h3 className="paw-more-label">Authorization server metadata</h3>
            <p className="paw-mcp-value">{claudeConnector?.authorizationServerMetadataUrl ?? "读取中"}</p>
            <span className={metadataStatus.authorizationServer === "failed" ? "paw-status-pill warn" : "paw-status-pill link"}>
              {metadataStatusLabel(metadataStatus.authorizationServer)}
            </span>
          </div>
        </div>

        {claudeConnectorMessage ? <span className="paw-status-pill link mt-4">{claudeConnectorMessage}</span> : null}

        <div className="paw-list mt-4">
          {activeClaudeAuthorizations.length === 0 ? (
            <div className="paw-empty">
              <h3>还没有 Claude connector 授权</h3>
              <p>在 Claude Custom Connector 中使用 Connector URL 后，完成浏览器授权才会出现在这里。</p>
            </div>
          ) : (
            activeClaudeAuthorizations.map((authorization) => (
              <div key={authorization.id} className="paw-list-row">
                <div className="min-w-0">
                  <p className="paw-row-title">{authorization.clientName}</p>
                  <p className="paw-row-meta">
                    {mcpPermissionLabels[authorization.permission]} · scope {authorization.scope} · 创建{" "}
                    {formatDateTime(authorization.createdAt)} · 到期 {formatDateTime(authorization.expiresAt)}
                  </p>
                </div>
                <div className="paw-row-actions">
                  <span className="paw-status-pill link">已授权</span>
                  <button
                    type="button"
                    disabled={pending === authorization.id}
                    onClick={() => void revokeClaudeAuthorization(authorization)}
                    aria-label={`撤销 ${authorization.clientName}`}
                    className="paw-secondary-btn !px-3 !py-2 !text-xs text-[var(--app-danger)]"
                  >
                    <Trash2 size={13} />
                    撤销
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="paw-list-card mb-4">
        <div className="paw-list-header">
          <div>
            <h2 className="paw-list-title">恢复目标</h2>
            <p className="paw-list-subtitle">系统默认 {formatHours(activeRecoveryTarget.minutes)}，当前不可编辑。</p>
          </div>
          <span className="paw-more-icon">
            <ShieldCheck size={18} />
          </span>
        </div>
        <div className="paw-list-row">
          <div>
            <p className="paw-row-title">系统默认 {formatHours(activeRecoveryTarget.minutes)}</p>
            <p className="paw-row-meta">来源：{activeRecoveryTarget.source} · 助手不应把恢复时间压到目标以下。</p>
          </div>
          <button type="button" disabled className="paw-secondary-btn !px-3 !py-2 !text-xs">
            暂不可配置
          </button>
        </div>
      </section>

      <section id="routines" className="paw-list-card mb-4">
        <div className="paw-list-header">
          <div>
            <h2 className="paw-list-title">日常事项</h2>
            <p className="paw-list-subtitle">保存到 routines，用于家务、做饭、通勤、运动等固定容量。</p>
          </div>
          <span className="paw-more-icon">
            <RotateCcw size={18} />
          </span>
        </div>

        <form onSubmit={saveRoutine} className="grid gap-3 border-b border-[var(--app-line)] py-4">
          <div className="grid gap-3 md:grid-cols-2">
            <label>
              <span className="paw-field-label">标题</span>
              <input
                value={routineForm.title}
                onChange={(event) => setRoutineForm((current) => ({ ...current, title: event.target.value }))}
                className="paw-input"
                placeholder="做饭 / 通勤 / 运动"
              />
            </label>
            <label>
              <span className="paw-field-label">默认时段</span>
              <select
                value={routineForm.defaultTimeSegment}
                onChange={(event) =>
                  setRoutineForm((current) => ({
                    ...current,
                    defaultTimeSegment: event.target.value as RoutineTimeSegment,
                  }))
                }
                className="paw-input"
              >
                <option value="morning">上午</option>
                <option value="afternoon">下午</option>
                <option value="evening">晚上</option>
                <option value="specific_window">指定时间</option>
              </select>
            </label>
          </div>
          <div className="grid gap-3 md:grid-cols-5">
            <label>
              <span className="paw-field-label">开始</span>
              <input
                type="time"
                value={routineForm.defaultStartTime ?? ""}
                onChange={(event) => setRoutineForm((current) => ({ ...current, defaultStartTime: event.target.value }))}
                className="paw-input"
              />
            </label>
            <label>
              <span className="paw-field-label">结束</span>
              <input
                type="time"
                value={routineForm.defaultEndTime ?? ""}
                onChange={(event) => setRoutineForm((current) => ({ ...current, defaultEndTime: event.target.value }))}
                className="paw-input"
              />
            </label>
            <label>
              <span className="paw-field-label">星期规则</span>
              <input
                value={routineForm.weekdayPattern}
                onChange={(event) => setRoutineForm((current) => ({ ...current, weekdayPattern: event.target.value }))}
                className="paw-input"
              />
            </label>
            <label>
              <span className="paw-field-label">分钟</span>
              <input
                type="number"
                min={1}
                value={routineForm.estimatedMinutes}
                onChange={(event) =>
                  setRoutineForm((current) => ({
                    ...current,
                    estimatedMinutes: Number(event.target.value),
                  }))
                }
                className="paw-input"
              />
            </label>
            <label>
              <span className="paw-field-label">能量</span>
              <select
                value={routineForm.energyLevel}
                onChange={(event) =>
                  setRoutineForm((current) => ({ ...current, energyLevel: event.target.value as EnergyLevel }))
                }
                className="paw-input"
              >
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
              </select>
            </label>
          </div>
          <div className="paw-save-row !mt-1">
            <button type="submit" disabled={pending === "routine"} className="paw-primary-btn !px-4 !py-2 !text-sm">
              {isEditing ? <Save size={15} /> : <Plus size={15} />}
              {pending === "routine" ? "保存中" : isEditing ? "保存修改" : "新增日常"}
            </button>
            {isEditing ? (
              <button
                type="button"
                onClick={() => setRoutineForm(emptyRoutineForm)}
                className="paw-secondary-btn !px-4 !py-2 !text-sm"
              >
                取消编辑
              </button>
            ) : null}
          </div>
        </form>

        {routines.length === 0 ? (
          <div className="paw-empty mt-4">
            <h3>还没有日常事项</h3>
            <p>新增后会保存到当前计划空间的日常安排。</p>
          </div>
        ) : (
          <div className="paw-list">
            {routines.map((routine) => (
              <div key={routine.id} className="paw-list-row">
                <div className="min-w-0">
                  <p className="paw-row-title">{routine.title}</p>
                  <p className="paw-row-meta">
                    {segmentLabels[routine.defaultTimeSegment]} · {routine.estimatedMinutes} 分钟 · 能量
                    {energyLabels[routine.energyLevel]} · {routine.weekdayPattern}
                  </p>
                </div>
                <div className="paw-row-actions">
                  <button
                    type="button"
                    onClick={() => setRoutineForm(routine)}
                    className="paw-secondary-btn !px-3 !py-2 !text-xs"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    disabled={pending === routine.id}
                    onClick={() => void deleteExistingRoutine(routine.id)}
                    className="paw-secondary-btn !px-3 !py-2 !text-xs text-[var(--app-danger)]"
                  >
                    <Trash2 size={13} />
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="paw-list-card mb-4">
        <div className="paw-list-header">
          <div>
            <h2 className="paw-list-title">能量规则</h2>
            <p className="paw-list-subtitle">保存每个时段适合的任务强度，供助手排期时参考。</p>
          </div>
          <span className="paw-more-icon">
            <Zap size={18} />
          </span>
        </div>

        <div className="paw-list">
          {energySettings.map((setting) => (
            <label key={setting.segment} className="paw-list-row">
              <div>
                <p className="paw-row-title">{segmentLabels[setting.segment]}</p>
                <p className="paw-row-meta">默认任务能量强度</p>
              </div>
              <select
                value={setting.energyLevel}
                onChange={(event) => updateEnergy(setting.segment, event.target.value as EnergyLevel)}
                className="paw-input min-w-[120px]"
              >
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
              </select>
            </label>
          ))}
        </div>
        <div className="paw-save-row">
          <button
            type="button"
            disabled={pending === "energy"}
            onClick={() => void saveEnergy()}
            className="paw-primary-btn !px-4 !py-2 !text-sm"
          >
            <Save size={15} />
            {pending === "energy" ? "保存中" : "保存能量规则"}
          </button>
        </div>
      </section>

      <section className="paw-list-card">
        <div className="paw-list-header">
          <div>
            <h2 className="paw-list-title">危险操作</h2>
            <p className="paw-list-subtitle">删除当前计划空间会同时删除它下面的计划、任务、设置、令牌和记录。</p>
          </div>
          <span className="paw-more-icon text-[var(--app-danger)]">
            <AlertTriangle size={18} />
          </span>
        </div>

        <form onSubmit={deleteWorkspace} className="grid gap-3 border-t border-[var(--app-line)] pt-4">
          <div className="grid gap-3 md:grid-cols-2">
            <label>
              <span className="paw-field-label">计划空间名称</span>
              <input
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
                className="paw-input"
                placeholder="当前计划空间名称"
              />
            </label>
            <label>
              <span className="paw-field-label">删除确认</span>
              <input
                value={workspaceDeleteConfirmation}
                onChange={(event) => setWorkspaceDeleteConfirmation(event.target.value)}
                className="paw-input"
                placeholder={expectedWorkspaceDeleteConfirmation || "DELETE <计划空间名称>"}
              />
            </label>
          </div>
          <div className="paw-save-row !mt-1">
            <button
              type="submit"
              disabled={!canDeleteWorkspace || pending === "workspace-delete"}
              className="paw-secondary-btn !px-4 !py-2 !text-sm text-[var(--app-danger)]"
            >
              <Trash2 size={15} />
              {pending === "workspace-delete" ? "删除中" : "删除计划空间"}
            </button>
            {workspaceDeleteMessage ? <span className="paw-status-pill warn">{workspaceDeleteMessage}</span> : null}
          </div>
        </form>
      </section>
    </div>
  );
}
