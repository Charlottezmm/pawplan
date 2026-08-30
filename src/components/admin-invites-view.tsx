"use client";

import { Copy, Plus, ShieldCheck, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

type Invite = {
  id: string;
  label: string;
  maxRedemptions: number | null;
  redemptionCount: number;
  expiresAt: string | null;
  disabledAt: string | null;
  createdAt: string;
  inviteUrl?: string;
};

type WorkspaceRow = {
  workspaceId: string;
  workspaceName: string;
  workspaceCreatedAt: string;
  inviteLabel: string | null;
  inviteMaxRedemptions: number | null;
  inviteRedemptionCount: number | null;
  inviteExpiresAt: string | null;
  inviteDisabledAt: string | null;
};

type AdminInvitesResponse = {
  inviteUrlBase: string;
  invites: Invite[];
  workspaces: WorkspaceRow[];
};

function formatDate(value: string | null) {
  if (!value) return "不过期";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function inviteStatus(invite: Pick<Invite, "disabledAt" | "expiresAt" | "maxRedemptions" | "redemptionCount">) {
  if (invite.disabledAt) return "disabled";
  if (invite.expiresAt && new Date(invite.expiresAt) <= new Date()) return "expired";
  if (invite.maxRedemptions !== null && invite.redemptionCount >= invite.maxRedemptions) return "used";
  return "active";
}

export function AdminInvitesView() {
  const [data, setData] = useState<AdminInvitesResponse | null>(null);
  const [label, setLabel] = useState("");
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [message, setMessage] = useState<string | null>(null);
  const [createdInviteUrl, setCreatedInviteUrl] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  async function loadInvites() {
    setMessage(null);
    const response = await fetch("/api/admin/invites");
    if (!response.ok) {
      setData(null);
      setMessage(response.status === 403 ? "当前计划空间没有邀请管理权限。" : "邀请管理数据读取失败。");
      return;
    }
    setData((await response.json()) as AdminInvitesResponse);
  }

  useEffect(() => {
    void loadInvites();
  }, []);

  async function createInvite(event: React.FormEvent) {
    event.preventDefault();
    setPending("create");
    setMessage(null);
    setCreatedInviteUrl(null);
    const response = await fetch("/api/admin/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, maxRedemptions: 1, expiresInDays }),
    });
    setPending(null);
    if (!response.ok) {
      setMessage("邀请链接创建失败。");
      return;
    }
    const body = (await response.json()) as { invite: Invite };
    setCreatedInviteUrl(body.invite.inviteUrl ?? null);
    setLabel("");
    await loadInvites();
  }

  async function disableInvite(invite: Invite) {
    setPending(invite.id);
    setMessage(null);
    const response = await fetch("/api/admin/invites", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "disable", id: invite.id }),
    });
    setPending(null);
    if (!response.ok) {
      setMessage("禁用邀请链接失败。");
      return;
    }
    await loadInvites();
  }

  async function copyInviteUrl() {
    if (!createdInviteUrl) return;
    await navigator.clipboard.writeText(createdInviteUrl);
    setMessage("邀请链接已复制。");
  }

  return (
    <div className="paw-page">
      <section className="paw-page-header">
        <h1 className="paw-page-date">邀请管理</h1>
        <div className="paw-agent-row">
          <ShieldCheck size={38} />
          <p className="paw-agent-msg">仅所有者可用：创建一次性邀请链接，并查看已注册计划空间。</p>
        </div>
      </section>

      <section className="paw-list-card">
        <div className="paw-list-header">
          <div>
            <h2 className="paw-list-title">创建邀请链接</h2>
            <p className="paw-list-subtitle">默认一人一链，只能创建一个计划空间。</p>
          </div>
        </div>
        <form className="paw-admin-form" onSubmit={(event) => void createInvite(event)}>
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="邀请备注"
            className="paw-input"
            maxLength={120}
            required
          />
          <input
            value={expiresInDays}
            onChange={(event) => setExpiresInDays(Number(event.target.value))}
            type="number"
            min={1}
            max={365}
            className="paw-input"
            aria-label="有效天数"
          />
          <button className="paw-primary-btn" disabled={pending === "create" || label.trim().length === 0}>
            <Plus size={16} />
            {pending === "create" ? "创建中" : "创建邀请链接"}
          </button>
        </form>
        {createdInviteUrl ? (
          <div className="paw-admin-created">
            <span className="paw-wrap-anywhere">{createdInviteUrl}</span>
            <button type="button" className="paw-secondary-btn" onClick={() => void copyInviteUrl()}>
              <Copy size={15} />
              Copy
            </button>
          </div>
        ) : null}
        {message ? <p className="paw-row-meta">{message}</p> : null}
      </section>

      <section className="paw-list-card">
        <div className="paw-list-header">
          <div>
            <h2 className="paw-list-title">邀请链接</h2>
            <p className="paw-list-subtitle">原始 token 只在创建时显示；这里不保存可复制链接。</p>
          </div>
        </div>
        <div className="paw-admin-table-wrap">
          <table className="paw-admin-table">
            <thead>
              <tr>
                <th>备注</th>
                <th>状态</th>
                <th>使用</th>
                <th>过期</th>
                <th>创建</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {(data?.invites ?? []).map((invite) => (
                <tr key={invite.id}>
                  <td>{invite.label}</td>
                  <td>{inviteStatus(invite)}</td>
                  <td>
                    {invite.redemptionCount}/{invite.maxRedemptions ?? "∞"}
                  </td>
                  <td>{formatDate(invite.expiresAt)}</td>
                  <td>{formatDate(invite.createdAt)}</td>
                  <td>
                    <button
                      type="button"
                      className="paw-secondary-btn"
                      disabled={Boolean(invite.disabledAt) || pending === invite.id}
                      onClick={() => void disableInvite(invite)}
                    >
                      <XCircle size={14} />
                      禁用
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="paw-list-card">
        <div className="paw-list-header">
          <div>
            <h2 className="paw-list-title">已创建计划空间</h2>
            <p className="paw-list-subtitle">用户信息表格：计划空间名称、创建时间和来源邀请。</p>
          </div>
        </div>
        <div className="paw-admin-table-wrap">
          <table className="paw-admin-table">
            <thead>
              <tr>
                <th>计划空间</th>
                <th>计划空间 ID</th>
                <th>来源邀请</th>
                <th>创建时间</th>
                <th>邀请状态</th>
              </tr>
            </thead>
            <tbody>
              {(data?.workspaces ?? []).map((workspace) => (
                <tr key={workspace.workspaceId}>
                  <td>{workspace.workspaceName}</td>
                  <td className="paw-mono-cell">{workspace.workspaceId}</td>
                  <td>{workspace.inviteLabel ?? "manual"}</td>
                  <td>{formatDate(workspace.workspaceCreatedAt)}</td>
                  <td>
                    {workspace.inviteLabel
                      ? `${workspace.inviteRedemptionCount ?? 0}/${workspace.inviteMaxRedemptions ?? "∞"}`
                      : "n/a"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
