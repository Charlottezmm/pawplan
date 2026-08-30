"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { CatIcon } from "./cat-icon";
import { Notice } from "./ui/notice";
import { safeRelativeNextPath } from "@/lib/auth/next-url";

type LoginResponse = {
  error?: string;
};

const loginErrorMessages: Record<string, string> = {
  "Workspace not found": "未找到这个计划空间",
  "Invalid workspace password": "计划空间密码不正确",
  "Workspace name is unavailable; try again": "这个计划空间名称不可用，请换一个",
  "Invalid beta workspace payload": "计划空间信息无效，请检查后重试",
  "Invite code invalid": "邀请码无效，请检查后重试",
  "Invite code expired": "邀请码已过期，请申请新的邀请链接",
  "Invite code disabled": "邀请码已停用，请申请新的邀请链接",
  "Invite code exhausted": "邀请码已达到使用次数上限，请申请新的邀请链接",
};

type LoginMode = "login" | "create";

type LoginFormProps = {
  nextPath?: string;
  initialMode?: LoginMode;
  initialInviteCode?: string;
  inviteCodeLocked?: boolean;
};

export function LoginForm({
  nextPath = "/today",
  initialMode = "login",
  initialInviteCode = "",
  inviteCodeLocked = false,
}: LoginFormProps) {
  const [mode, setMode] = useState<LoginMode>(inviteCodeLocked ? "create" : initialMode);
  const [workspaceName, setWorkspaceName] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [inviteCode, setInviteCode] = useState(initialInviteCode);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);

    if (mode === "create" && password !== passwordConfirmation) {
      setMessage("两次输入的密码不一致");
      return;
    }

    setPending(true);
    try {
      const response = await fetch(mode === "login" ? "/api/auth/login" : "/api/beta/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "login" ? { workspaceName, password } : { workspaceName, password, inviteCode }),
      });
      let data: LoginResponse = {};
      try {
        data = (await response.json()) as LoginResponse;
      } catch {
        // Some proxies return an HTML error page. Keep the form usable and show a stable message.
      }

      if (!response.ok) {
        const fallbackMessage = mode === "login" ? "登录失败，请稍后重试" : "创建失败，请稍后重试";
        setMessage(data.error ? (loginErrorMessages[data.error] ?? fallbackMessage) : fallbackMessage);
        return;
      }

      window.location.href = safeRelativeNextPath(nextPath);
    } catch {
      setMessage("网络请求失败，请检查连接后重试");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="paw-login">
      <div className="paw-login-card">
        <div>
          <h1 className="paw-login-brand">
            <CatIcon size={38} />
            PawPlan
          </h1>
          <p className="paw-login-copy">
            {inviteCodeLocked
              ? "你被邀请使用 PawPlan。把任务、固定日程和调整建议放进同一个可审核的计划空间，创建后即可开始。"
              : "登录已有计划空间，继续查看今天的任务与待审核建议；创建新计划空间需要邀请链接。"}
          </p>
        </div>
        <div className="paw-login-fields">
          {inviteCodeLocked ? null : (
            <div className="paw-login-mode" aria-label="登录模式">
              <button
                type="button"
                className={mode === "login" ? "paw-login-mode-btn is-active" : "paw-login-mode-btn"}
                aria-pressed={mode === "login"}
                onClick={() => {
                  setMode("login");
                  setMessage(null);
                }}
              >
                登录已有计划空间
              </button>
              <button
                type="button"
                className={mode === "create" ? "paw-login-mode-btn is-active" : "paw-login-mode-btn"}
                aria-pressed={mode === "create"}
                onClick={() => {
                  setMode("create");
                  setMessage(null);
                }}
              >
                邀请创建计划空间
              </button>
            </div>
          )}
          <div>
            <label className="paw-field-label" htmlFor="workspace-name">
              计划空间名称
            </label>
            <input
              id="workspace-name"
              name="workspaceName"
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              placeholder="例如：学习计划"
              className="paw-input"
              autoCapitalize="none"
              autoComplete="username"
              required
            />
          </div>
          <div>
            <label className="paw-field-label" htmlFor="workspace-password">
              密码
            </label>
            <input
              id="workspace-password"
              name="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="输入密码"
              type={showPassword ? "text" : "password"}
              className="paw-input"
              autoCapitalize="none"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              required
            />
          </div>
          {mode === "create" ? (
            <div>
              <label className="paw-field-label" htmlFor="workspace-password-confirmation">
                确认密码
              </label>
              <input
                id="workspace-password-confirmation"
                name="passwordConfirmation"
                value={passwordConfirmation}
                onChange={(event) => setPasswordConfirmation(event.target.value)}
                placeholder="再次输入密码"
                type={showPassword ? "text" : "password"}
                className="paw-input"
                autoCapitalize="none"
                autoComplete="new-password"
                required
              />
            </div>
          ) : null}
          <button
            type="button"
            className="paw-secondary-btn"
            aria-pressed={showPassword}
            onClick={() => setShowPassword((visible) => !visible)}
          >
            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            {showPassword ? "隐藏密码" : "显示密码"}
          </button>
          {mode === "create" && !inviteCodeLocked ? (
            <div>
              <label className="paw-field-label" htmlFor="invite-code">
                邀请码
              </label>
              <input
                id="invite-code"
                name="inviteCode"
                value={inviteCode}
                onChange={(event) => setInviteCode(event.target.value)}
                placeholder="输入邀请码"
                className="paw-input"
                autoCapitalize="none"
                autoComplete="off"
                required
              />
            </div>
          ) : null}
          <p className="paw-login-recovery-note">
            请保存好计划空间名称和密码；目前没有自助找回或重置入口。
          </p>
          <button disabled={pending} className="paw-primary-btn">
            {pending ? "处理中…" : mode === "login" ? "进入" : "创建并进入"}
          </button>
          {message ? <Notice tone="danger" title={message} dismissible onDismiss={() => setMessage(null)} /> : null}
        </div>
      </div>
    </form>
  );
}
